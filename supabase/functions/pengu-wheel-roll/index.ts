// Edge function: pengu-wheel-roll
// Reads on-chain wheel config, picks a weighted random slot, EIP-712 signs
// a WheelRoll that PenguCrushV2.spinDailyWheel() consumes.
// POST { player } → { roll, signature, ttlSec }

import { createPublicClient, http } from 'npm:viem@2.47.12';
import { privateKeyToAccount } from 'npm:viem@2.47.12/accounts';
import { abstract } from 'npm:viem@2.47.12/chains';
import { getRelayerKey } from './_shared/vault.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,apikey',
};
const ROLL_TTL_SEC = 90;
const PENGUCRUSH_ADDRESS = '0x06aCb91c46aD1359825560B19A9556118Aeb1896' as const;

const WHEEL_ABI = [
  { type: 'function', name: 'wheelSlotCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'wheelConfig', stateMutability: 'view',
    inputs: [{ type: 'uint8' }],
    outputs: [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint32' }, { type: 'uint16' }, { type: 'bool' }] },
  { type: 'function', name: 'lastWheelDay', stateMutability: 'view',
    inputs: [{ type: 'address' }], outputs: [{ type: 'uint64' }] },
] as const;

const ROLL_TYPES = {
  WheelRoll: [
    { name: 'player',    type: 'address' },
    { name: 'dayUtc',    type: 'uint64' },
    { name: 'slotIndex', type: 'uint8' },
    { name: 'nonce',     type: 'uint256' },
    { name: 'deadline',  type: 'uint256' },
  ],
} as const;

const DOMAIN = { name: 'PenguCrush', version: '1', chainId: abstract.id, verifyingContract: PENGUCRUSH_ADDRESS } as const;
const client = createPublicClient({ chain: abstract, transport: http() });

function randomNonce(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n.toString();
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: CORS });
  try {
    const { player } = await req.json();
    if (!/^0x[a-fA-F0-9]{40}$/.test(player || '')) return json({ error: 'bad player' }, 400);
    const today = BigInt(Math.floor(Date.now() / 1000 / 86400));
    const lastDay = await client.readContract({
      address: PENGUCRUSH_ADDRESS, abi: WHEEL_ABI, functionName: 'lastWheelDay', args: [player],
    });
    if (BigInt(lastDay) === today) return json({ error: 'already spun today' }, 409);
    const count = Number(await client.readContract({
      address: PENGUCRUSH_ADDRESS, abi: WHEEL_ABI, functionName: 'wheelSlotCount',
    }));
    if (count === 0) return json({ error: 'wheel not configured' }, 500);
    const slots = await Promise.all(
      Array.from({ length: count }).map((_, i) =>
        client.readContract({
          address: PENGUCRUSH_ADDRESS, abi: WHEEL_ABI, functionName: 'wheelConfig', args: [i],
        })
      )
    );
    let totalWeight = 0;
    for (const [, , , weight, enabled] of slots) if (enabled) totalWeight += Number(weight);
    if (totalWeight === 0) return json({ error: 'no enabled slots' }, 500);
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    let r = buf[0] % totalWeight;
    let chosen = 0;
    for (let i = 0; i < slots.length; i++) {
      const [, , , weight, enabled] = slots[i];
      if (!enabled) continue;
      const w = Number(weight);
      if (r < w) { chosen = i; break; }
      r -= w;
    }
    const nonce = randomNonce();
    const deadline = Math.floor(Date.now() / 1000) + ROLL_TTL_SEC;
    const roll = { player: player as `0x${string}`, dayUtc: Number(today), slotIndex: chosen, nonce, deadline };
    const pk = await getRelayerKey() as `0x${string}`;
    const account = privateKeyToAccount(pk);
    const signature = await account.signTypedData({
      domain: DOMAIN, types: ROLL_TYPES, primaryType: 'WheelRoll',
      message: {
        player: roll.player, dayUtc: BigInt(roll.dayUtc),
        slotIndex: BigInt(roll.slotIndex), nonce: BigInt(roll.nonce),
        deadline: BigInt(roll.deadline),
      },
    });
    return json({ roll, signature, ttlSec: ROLL_TTL_SEC });
  } catch (err) {
    console.error('pengu-wheel-roll error:', err);
    return json({ error: (err as Error).message || String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'content-type': 'application/json' } });
}
