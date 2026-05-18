// Edge function: pengu-regen-sweep
// Hourly cron (pg_cron @ minute :07). Sweeps registered players whose 8h
// life-regen tick is due and calls PenguCrushV2.claimRegenBatch so a
// LifeRegenerated event fires for each offline player too.
//
// AUTH: requires `x-cron-secret` request header matching vault.secrets/CRON_SECRET.
// pg_cron is configured to send it; ad-hoc curls without the header get 401.
// Closes audit finding H4 (unauthenticated public sweep → relayer-gas burn).

import { createPublicClient, createWalletClient, http } from 'npm:viem@^2.47.12';
import { privateKeyToAccount } from 'npm:viem@^2.47.12/accounts';
import { abstract } from 'npm:viem@^2.47.12/chains';
import { getRelayerKey, getCronSecret, constantTimeEqual } from './_shared/vault.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,GET,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,apikey,x-cron-secret',
};
const PENGUCRUSH_ADDRESS = '0x06aCb91c46aD1359825560B19A9556118Aeb1896' as const;

const ABI = [
  { type: 'function', name: 'claimRegenBatch', stateMutability: 'nonpayable',
    inputs: [{ type: 'address[]' }], outputs: [] },
  { type: 'function', name: 'getLives', stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint8' }, { type: 'uint8' }, { type: 'uint8' }, { type: 'uint64' }] },
  { type: 'function', name: 'getPlayers', stateMutability: 'view',
    inputs: [{ type: 'uint256' }, { type: 'uint256' }], outputs: [{ type: 'address[]' }] },
  { type: 'function', name: 'getPlayerCount', stateMutability: 'view',
    inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

const BATCH_SIZE = 50;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  // Auth gate — require x-cron-secret matching vault.secrets/CRON_SECRET
  try {
    const provided = req.headers.get('x-cron-secret') || '';
    if (!provided) return json({ error: 'unauthorized' }, 401);
    const expected = await getCronSecret();
    if (!constantTimeEqual(provided, expected)) return json({ error: 'unauthorized' }, 401);
  } catch (e) {
    console.error('auth failure:', e);
    return json({ error: 'auth_internal' }, 500);
  }
  try {
    const pk = await getRelayerKey() as `0x${string}`;
    const publicClient = createPublicClient({ chain: abstract, transport: http() });
    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({ account, chain: abstract, transport: http() });

    let candidates: `0x${string}`[] = [];
    if (req.method === 'POST') {
      try {
        const body = await req.json();
        if (Array.isArray(body?.players)) candidates = body.players.map((x: string) => x.toLowerCase() as `0x${string}`);
      } catch (_) {}
    }
    if (candidates.length === 0) {
      const totalRaw = await publicClient.readContract({
        address: PENGUCRUSH_ADDRESS, abi: ABI, functionName: 'getPlayerCount',
      });
      const total = Number(totalRaw);
      for (let off = 0; off < total; off += 200) {
        const page = await publicClient.readContract({
          address: PENGUCRUSH_ADDRESS, abi: ABI, functionName: 'getPlayers',
          args: [BigInt(off), 200n],
        });
        for (const p of page) candidates.push(p.toLowerCase() as `0x${string}`);
      }
    }

    const eligible: `0x${string}`[] = [];
    for (const p of candidates) {
      try {
        const [regular, , , secondsToNext] = await publicClient.readContract({
          address: PENGUCRUSH_ADDRESS, abi: ABI, functionName: 'getLives', args: [p],
        });
        if (Number(regular) < 3 && Number(secondsToNext) === 0) eligible.push(p);
      } catch (_) {}
    }

    if (eligible.length === 0) return json({ swept: 0, candidates: candidates.length });

    const txHashes: string[] = [];
    for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
      const chunk = eligible.slice(i, i + BATCH_SIZE);
      const hash = await walletClient.writeContract({
        address: PENGUCRUSH_ADDRESS, abi: ABI, functionName: 'claimRegenBatch', args: [chunk],
      });
      txHashes.push(hash);
    }
    return json({ swept: eligible.length, batches: txHashes.length, txHashes });
  } catch (err) {
    console.error('pengu-regen-sweep error:', err);
    return json({ error: 'server_error' }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
