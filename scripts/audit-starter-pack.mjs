// ═══════════════════════════════════════════════════════════════════════
// audit-starter-pack.mjs — one-time starter-pack idempotency
// ═══════════════════════════════════════════════════════════════════════
import { PROXY, RPC, sim, read, freshAddress, makeRunner, sampleRealPlayers } from './_audit-shared.mjs';

const { test, run } = makeRunner('starter-pack');

test('A1 fresh wallet: claimedStarterPack == false', async () => {
  const r = await read('claimedStarterPack', [freshAddress()]);
  if (r !== false) throw new Error(`fresh wallet shows claimed=${r}`);
});

test('A2 fresh wallet: claimStarterPack simulates clean', async () => {
  const r = await sim('claimStarterPack', [], freshAddress());
  if (!r.ok) throw new Error(`first claim reverted: ${r.error}`);
});

test('B1 real registered players: claimedStarterPack should be true (they would have auto-claimed)', async () => {
  const players = await sampleRealPlayers(10);
  let claimed = 0, unclaimed = 0;
  for (const p of players) {
    const c = await read('claimedStarterPack', [p]);
    if (c) claimed++; else unclaimed++;
  }
  // Just report — pre-V2.3 registered players might be unclaimed; new
  // ones should be claimed. We don't fail either way.
  console.log(`     ${claimed} claimed, ${unclaimed} unclaimed (informational)`);
});

test('B2 real player who already claimed: second claim reverts StarterPackAlreadyClaimed', async () => {
  const players = await sampleRealPlayers(10);
  let tested = 0;
  for (const p of players) {
    const c = await read('claimedStarterPack', [p]);
    if (!c) continue;
    const r = await sim('claimStarterPack', [], p);
    if (r.ok) throw new Error(`${p} already claimed but second claim succeeded`);
    if (!/StarterPackAlreadyClaimed/i.test(r.error)) {
      throw new Error(`${p} second claim wrong revert: ${r.error}`);
    }
    tested++;
  }
  if (tested === 0) console.log(`     no claimed real players in sample — skipped`);
  else console.log(`     ${tested} already-claimed players verified idempotent`);
});

console.log(`Proxy: ${PROXY}`);
console.log(`RPC:   ${RPC}`);
const result = await run();
console.log(`\n${result.pass} passed · ${result.fail} failed`);
process.exit(result.fail === 0 ? 0 : 1);
