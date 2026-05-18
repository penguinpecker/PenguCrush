// Edge function: pengu-wheel-roll
// Reads on-chain wheel config, picks a weighted random slot, signs an
// EIP-712 WheelRoll that the contract uses to authorize the payout.
// POST body: { player: 0xAddress }
// Response: { roll: { player, dayUtc, slotIndex, nonce, deadline }, signature }

import { createPublicClient, http } from 'npm:viem@^2.47.12';
import { abstract } from 'npm:viem@^2.47.12/chains';
import { signWheelRoll, randomNonce, type WheelRoll } from '../_shared/eip712.ts';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,apikey',
};

const ROLL_TTL_SEC = 90;

const WHEEL_ABI = [
  { type: 'function', name: 'wheelSlotCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'wheelConfig', stateMutability: 'view',
    inputs: [{ type: 'uint8' }],
    outputs: [
      { type: 'uint8' },   // kind
      { type: 'bytes32' }, // sku
      { type: 'uint32' },  // amount
      { type: 'uint16' },  // weight
      { type: 'bool' },    // enabled
    ],
  },
  { type: 'function', name: 'lastWheelDay', stateMutability: 'view',
    inputs: [{ type: 'address' }],
    outputs: [{ type: 'uint64' }],
  },
] as const;

const client = createPublicClient({ chain: abstract, transport: http() });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return new Response('method not allowed', { status: 405, headers: CORS });
  try {
    const { player } = await req.json();
    if (!/^0x[a-fA-F0-9]{40}$/.test(player || '')) {
      return json({ error: 'bad player' }, 400);
    }
    const addr = Deno.env.get('PENGUCRUSH_ADDRESS') as `0x${string}` | undefined;
    if (!addr) return json({ error: 'PENGUCRUSH_ADDRESS not set' }, 500);

    const today = BigInt(Math.floor(Date.now() / 1000 / 86400));

    const lastDay = await client.readContract({
      address: addr, abi: WHEEL_ABI, functionName: 'lastWheelDay', args: [player],
    });
    if (BigInt(lastDay) === today) {
      return json({ error: 'already spun today' }, 409);
    }

    const count = Number(await client.readContract({
      address: addr, abi: WHEEL_ABI, functionName: 'wheelSlotCount',
    }));
    if (count === 0) return json({ error: 'wheel not configured' }, 500);

    // Read all slots and pick a weighted random one
    const slots = await Promise.all(
      Array.from({ length: count }).map((_, i) =>
        client.readContract({
          address: addr, abi: WHEEL_ABI, functionName: 'wheelConfig', args: [i],
        })
      )
    );
    let totalWeight = 0;
    for (const [, , , weight, enabled] of slots) {
      if (enabled) totalWeight += Number(weight);
    }
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
    const roll: WheelRoll = {
      player: player as `0x${string}`,
      dayUtc: Number(today),
      slotIndex: chosen,
      nonce,
      deadline,
    };
    const signature = await signWheelRoll(roll);
    return json({ roll, signature, ttlSec: ROLL_TTL_SEC });
  } catch (err) {
    console.error('pengu-wheel-roll error:', err);
    return json({ error: (err as Error).message || String(err) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'content-type': 'application/json' },
  });
}
