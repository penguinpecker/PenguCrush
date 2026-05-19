// ═══════════════════════════════════════════════════════════════════════
// audit-wheel.mjs — daily wheel signed-roll pipeline
// ═══════════════════════════════════════════════════════════════════════
import { PROXY, RPC, QUOTE_API_BASE, sim, read, freshAddress, makeRunner, sampleRealPlayers } from './_audit-shared.mjs';

const { test, run } = makeRunner('wheel');

const player = freshAddress();

async function fetchRoll(p) {
  const res = await fetch(`${QUOTE_API_BASE}/pengu-wheel-roll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: p }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`wheel-roll failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

test('A1 wheelRelayer storage var configured', async () => {
  const r = await read('wheelRelayer', []);
  if (r === '0x0000000000000000000000000000000000000000') throw new Error('wheelRelayer not set');
});

test('A2 wheelSlotCount > 0 (wheel configured)', async () => {
  const n = await read('wheelSlotCount', []);
  if (Number(n) === 0) throw new Error('wheel has zero slots');
});

test('B1 /pengu-wheel-roll signs for a fresh player', async () => {
  const { roll, signature } = await fetchRoll(player);
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) throw new Error(`bad signature: ${signature}`);
  if (!roll || roll.player?.toLowerCase() !== player.toLowerCase()) {
    throw new Error(`roll payload mismatch: ${JSON.stringify(roll)}`);
  }
});

test('C1 spinDailyWheel with live sig simulates clean for fresh player', async () => {
  const { roll, signature } = await fetchRoll(player);
  const r = await sim('spinDailyWheel', [roll, signature], player);
  if (!r.ok) throw new Error(`unexpected revert: ${r.error}`);
});

test('C2 spinDailyWheel with TAMPERED sig reverts (signature check live)', async () => {
  const { roll, signature } = await fetchRoll(player);
  // Flip the last byte to corrupt the signature deterministically
  const bad = signature.slice(0, -2) + (signature.slice(-2) === 'ff' ? '00' : 'ff');
  const r = await sim('spinDailyWheel', [roll, bad], player);
  if (r.ok) throw new Error('tampered sig should have reverted');
});

test('D1 real-player lastWheelDay returns plausible value (0 or recent day)', async () => {
  const players = await sampleRealPlayers(5);
  const today = Math.floor(Date.now() / 1000 / 86400);
  for (const p of players) {
    const d = Number(await read('lastWheelDay', [p]));
    if (d !== 0 && (d < today - 365 || d > today + 1)) {
      throw new Error(`lastWheelDay ${d} out of plausible range for ${p}`);
    }
  }
});

console.log(`Proxy: ${PROXY}`);
console.log(`RPC:   ${RPC}`);
console.log(`Wheel signer: ${QUOTE_API_BASE}/pengu-wheel-roll`);
const result = await run();
console.log(`\n${result.pass} passed · ${result.fail} failed`);
process.exit(result.fail === 0 ? 0 : 1);
