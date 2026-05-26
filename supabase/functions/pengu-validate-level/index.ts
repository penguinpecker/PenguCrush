// Edge function: pengu-validate-level
// Audit fix #10. Bounds-checks a player-submitted LevelJournal against the
// known level catalog and recomputed star thresholds, then EIP-712 signs a
// Validation approval that PenguCrushV2.submitLevelValidated() verifies.
//
// POST { player, journal } → { signature, journalHash, validator }

import { privateKeyToAccount } from 'npm:viem@2.47.12/accounts';
import { abstract } from 'npm:viem@2.47.12/chains';
import { encodeAbiParameters, keccak256, parseAbiParameters } from 'npm:viem@2.47.12';
import { getValidatorKey } from './_shared/vault.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,apikey',
};
const PENGUCRUSH_ADDRESS = '0x06aCb91c46aD1359825560B19A9556118Aeb1896' as const;
const DOMAIN = {
  name: 'PenguCrush',
  version: '1',
  chainId: abstract.id,
  verifyingContract: PENGUCRUSH_ADDRESS,
} as const;
const VALIDATION_TYPES = {
  Validation: [
    { name: 'player',      type: 'address' },
    { name: 'journalHash', type: 'bytes32' },
  ],
} as const;

// Per-level moves budget (matches src/levels.js). +5 buffer for crown-shard
// bonus moves (max(5, floor(crown/5)) per src/shards.js).
const LEVEL_MOVES: Record<number, number> = {
   1: 35,  2: 34,  3: 33,  4: 32,  5: 30,
   6: 30,  7: 29,  8: 28,  9: 27, 10: 26,
  11: 26, 12: 25, 13: 25, 14: 24, 15: 23,
  16: 24, 17: 23, 18: 22, 19: 21, 20: 20,
  99: 2,
};
const MAX_MOVES_BUFFER = 5;
const SCORE_MARGIN_X = 3; // realistic shard multiplier x 1.4 then x 2 margin

const LEVEL_STARS: Record<number, [number, number, number]> = {
   1: [3000, 4000, 5500],   2: [3500, 4500, 6000],   3: [4000, 5500, 7000],
   4: [4500, 6000, 8000],   5: [5000, 7000, 9000],   6: [5500, 7500, 10000],
   7: [6000, 8000, 11000],  8: [6500, 8500, 11500],  9: [7500, 10000, 13000],
  10: [8000, 10500, 14000],11: [8500, 11000, 15000],12: [9000, 12000, 16000],
  13: [9500, 13000, 17000],14: [10500, 14000, 18000],15: [11000, 15000, 20000],
  16: [10500, 14000, 18000],17: [11500, 15000, 20000],18: [12000, 16000, 22000],
  19: [13000, 17500, 24000],20: [14000, 19000, 26000], 99: [10, 50, 100],
};

const MAX_BOOSTERS_PER_LEVEL = 20;
const MAX_SHARDS_PER_LEVEL   = 16; // matches PenguCrushV2.MAX_SHARDS_PER_SUBMIT
const MAX_BIG_COMBOS         = 100;
const MAX_FALLER_PENALTIES   = 100;
const MAX_DURATION_MS        = 60 * 60 * 1000;

/** Min % of base move budget left for 2★ / 3★ via the efficiency path (matches src/levels.js). */
const MOVE_STAR_2_PCT = 0.15;
const MOVE_STAR_3_PCT = 0.30;

function movesRemainingForStars(movesUsed: number, baseBudget: number): number {
  return Math.max(0, baseBudget - Math.min(movesUsed, baseBudget));
}

function computeStars(score: number, movesUsed: number, level: number): number {
  const t = LEVEL_STARS[level];
  const budget = LEVEL_MOVES[level];

  const scoreStars =
    score >= t[2] ? 3 :
    score >= t[1] ? 2 :
    score >= t[0] ? 1 : 0;

  const pct = budget > 0 ? movesRemainingForStars(movesUsed, budget) / budget : 0;
  const moveStars =
    pct >= MOVE_STAR_3_PCT ? 3 :
    pct >= MOVE_STAR_2_PCT ? 2 :
    1;

  return Math.max(scoreStars, moveStars);
}

function encodeJournal(j: any): `0x${string}` {
  // Must match exactly the Solidity ABI encoding of LevelJournal:
  // (uint16, uint32, uint8, uint16, bool, uint32, bytes32[], bytes32[], uint16, uint16)
  return keccak256(encodeAbiParameters(
    parseAbiParameters('(uint16,uint32,uint8,uint16,bool,uint32,bytes32[],bytes32[],uint16,uint16)'),
    [[
      Number(j.level), Number(j.score), Number(j.stars), Number(j.movesUsed),
      !!j.completed, Number(j.durationMs),
      (j.boostersUsed || []) as `0x${string}`[],
      (j.shardsEarned || []) as `0x${string}`[],
      Number(j.bigCombos || 0), Number(j.fallerPenalties || 0),
    ]]
  ));
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: CORS });
  try {
    const body = await req.json();
    const player = (body?.player || '').toLowerCase();
    const j = body?.journal;
    if (!/^0x[a-f0-9]{40}$/.test(player)) return json({ error: 'bad player' }, 400);
    if (!j || typeof j !== 'object') return json({ error: 'missing journal' }, 400);

    const level = Number(j.level);
    if (!Number.isInteger(level) || !(level in LEVEL_MOVES)) return json({ error: 'bad level' }, 400);
    const score = Number(j.score);
    if (!Number.isInteger(score) || score < 0) return json({ error: 'bad score' }, 400);
    if (score > LEVEL_STARS[level][2] * SCORE_MARGIN_X) return json({ error: 'score above bound' }, 400);
    const stars = Number(j.stars);
    if (!Number.isInteger(stars) || stars < 0 || stars > 3) return json({ error: 'bad stars' }, 400);
    const movesUsed = Number(j.movesUsed);
    if (!Number.isInteger(movesUsed) || movesUsed < 0 || movesUsed > LEVEL_MOVES[level] + MAX_MOVES_BUFFER) {
      return json({ error: 'moves out of range' }, 400);
    }
    if (typeof j.completed !== 'boolean') return json({ error: 'completed must be boolean' }, 400);
    const durationMs = Number(j.durationMs || 0);
    if (!Number.isInteger(durationMs) || durationMs < 0 || durationMs > MAX_DURATION_MS) {
      return json({ error: 'duration out of range' }, 400);
    }
    const boostersUsed = Array.isArray(j.boostersUsed) ? j.boostersUsed : [];
    const shardsEarned = Array.isArray(j.shardsEarned) ? j.shardsEarned : [];
    if (boostersUsed.length > MAX_BOOSTERS_PER_LEVEL) return json({ error: 'too many boosters' }, 400);
    if (shardsEarned.length > MAX_SHARDS_PER_LEVEL) return json({ error: 'too many shards' }, 400);
    for (const s of [...boostersUsed, ...shardsEarned]) {
      if (typeof s !== 'string' || !/^0x[a-f0-9]{64}$/i.test(s)) return json({ error: 'bad sku in journal' }, 400);
    }
    const bigCombos = Number(j.bigCombos || 0);
    const fallerPenalties = Number(j.fallerPenalties || 0);
    if (!Number.isInteger(bigCombos) || bigCombos < 0 || bigCombos > MAX_BIG_COMBOS) return json({ error: 'bad bigCombos' }, 400);
    if (!Number.isInteger(fallerPenalties) || fallerPenalties < 0 || fallerPenalties > MAX_FALLER_PENALTIES) {
      return json({ error: 'bad fallerPenalties' }, 400);
    }

    // Deterministic stars check — hybrid score + moves-remaining (matches src/levels.js).
    const expectedStars = j.completed ? computeStars(score, movesUsed, level) : 0;
    if (j.completed) {
      if (stars !== expectedStars) return json({ error: `stars mismatch (claimed ${stars}, computed ${expectedStars})` }, 400);
    } else {
      if (stars !== 0) return json({ error: 'failed level must have 0 stars' }, 400);
    }

    const pk = await getValidatorKey() as `0x${string}`;
    const account = privateKeyToAccount(pk);
    const journalHash = encodeJournal(j);
    const signature = await account.signTypedData({
      domain: DOMAIN, types: VALIDATION_TYPES, primaryType: 'Validation',
      message: { player: player as `0x${string}`, journalHash },
    });
    return json({ signature, journalHash, validator: account.address });
  } catch (err) {
    console.error('pengu-validate-level error:', err);
    return json({ error: 'server_error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
