// ═══════════════════════════════════════════════════════════════════════
// audit-pass-frozen.mjs — CrushPass + frozen-lives + seed-guard
//
// The seed materialization (V2.7 fix) MUST NOT fire for a wallet whose
// `frozen > 0`. That guard is the critical bit that keeps pass-only
// holders from getting the regen seed reapplied after every pass-life
// consume. This suite locks that invariant.
//
// Coverage:
//   • Source-code lock: the seed-guard literally includes `frozen == 0`
//   • getLives semantics under pass-active / pass-expired states
//   • cancelCrushPass simulate for no-pass + has-pass real wallets
//   • Fresh wallet getCrushPass / lifeAccount truly zero
//   • Real-player CrushPass invariants
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import {
  PROXY, RPC, pc, abi,
  freshAddress, sim, read,
  getCrushPass, getLifeAccount, getLivesTuple,
  sampleRealPlayers, makeRunner,
} from './_audit-shared.mjs';

const { test, run } = makeRunner('pass-frozen');

// ── A. Source-code lock — the seed guard must include frozen==0 ───────
test('A1 _consumeLife seed-guard literally requires `frozen == 0`', () => {
  const src = readFileSync(new URL('../contracts/PenguCrushV2.sol', import.meta.url), 'utf8');
  const consumeBody = src.match(/function _consumeLife\([\s\S]*?\n    \}/)?.[0];
  if (!consumeBody) throw new Error('could not locate _consumeLife body');
  // The exact guard we wrote — match loosely on whitespace
  if (!/la\.regular\s*==\s*0\s*&&\s*la\.lastConsumedAt\s*==\s*0\s*&&\s*la\.frozen\s*==\s*0/.test(consumeBody)) {
    throw new Error('_consumeLife missing `regular==0 && lastConsumedAt==0 && frozen==0` seed guard');
  }
});

test('A2 _grantRegularLives seed-guard literally requires `frozen == 0`', () => {
  const src = readFileSync(new URL('../contracts/PenguCrushV2.sol', import.meta.url), 'utf8');
  const grantBody = src.match(/function _grantRegularLives\([\s\S]*?\n    \}/)?.[0];
  if (!grantBody) throw new Error('could not locate _grantRegularLives body');
  if (!/la\.regular\s*==\s*0\s*&&\s*la\.lastConsumedAt\s*==\s*0\s*&&\s*la\.frozen\s*==\s*0/.test(grantBody)) {
    throw new Error('_grantRegularLives missing matching seed guard');
  }
});

// ── B. Fresh-wallet ground truth ──────────────────────────────────────
test('B1 fresh wallet lifeAccount == (0, 0, 0)', async () => {
  const la = await getLifeAccount(freshAddress());
  if (la.regular !== 0 || la.frozen !== 0 || la.lastConsumedAt !== 0) {
    throw new Error(`unexpected fresh lifeAccount: ${JSON.stringify(la)}`);
  }
});

test('B2 fresh wallet crushPass == (0, 0, 0)', async () => {
  const cp = await getCrushPass(freshAddress());
  if (cp.expiresAt !== 0 || cp.streakWeeks !== 0 || cp.lastPurchaseWeekMonday !== 0) {
    throw new Error(`unexpected fresh crushPass: ${JSON.stringify(cp)}`);
  }
});

test('B3 fresh wallet has no active pass — getLives.frozen masks correctly', async () => {
  const a = freshAddress();
  const lives = await getLivesTuple(a);
  // No pass, no frozen → frozen=0 always.
  if (lives.frozen !== 0) throw new Error(`fresh wallet has frozen=${lives.frozen}, expected 0`);
});

// ── C. cancelCrushPass behavior ───────────────────────────────────────
test('C1 fresh wallet cancelCrushPass is no-op (no revert)', async () => {
  const r = await sim('cancelCrushPass', [], freshAddress());
  if (!r.ok) throw new Error(`unexpected revert: ${r.error}`);
});

test('C2 real wallet cancelCrushPass simulates clean regardless of pass state', async () => {
  const players = await sampleRealPlayers(5);
  let ran = 0;
  for (const p of players) {
    const r = await sim('cancelCrushPass', [], p);
    if (!r.ok) throw new Error(`cancelCrushPass reverted for ${p}: ${r.error}`);
    ran++;
  }
  console.log(`     simulated cancelCrushPass for ${ran} real player(s)`);
});

// ── D. Real-player invariants ──────────────────────────────────────────
test('D1 every real player: getLives.frozen <= MAX_FROZEN_LIVES (2)', async () => {
  const players = await sampleRealPlayers(10);
  for (const p of players) {
    const lives = await getLivesTuple(p);
    if (lives.frozen > 2) throw new Error(`frozen>2 on ${p}: ${lives.frozen}`);
  }
});

test('D2 every real player: pass-expired wallet has effFrozen=0 in getLives', async () => {
  const players = await sampleRealPlayers(10);
  let activePassCount = 0, expiredPassCount = 0;
  for (const p of players) {
    const cp = await getCrushPass(p);
    const lives = await getLivesTuple(p);
    const la = await getLifeAccount(p);
    if (cp.expiresAt === 0) continue; // never had pass — skip
    if (cp.active) {
      activePassCount++;
      // Active pass: getLives.frozen should match storage la.frozen.
      if (lives.frozen !== la.frozen) {
        throw new Error(`active-pass ${p}: getLives.frozen=${lives.frozen} != lifeAccount.frozen=${la.frozen}`);
      }
    } else {
      expiredPassCount++;
      // Expired pass: getLives.frozen MUST be 0 even if storage la.frozen > 0
      // (the view masks it; _materializePassExpiry zeroes it on next write).
      if (lives.frozen !== 0) {
        throw new Error(`expired-pass ${p}: getLives.frozen=${lives.frozen}, expected 0`);
      }
    }
  }
  console.log(`     active passes seen: ${activePassCount}, expired: ${expiredPassCount}`);
});

// ── E. Pass-active wallet startLevel still works (no regression) ──────
test('E1 every real player with total>0 lives: startLevel(1) simulates OK', async () => {
  const players = await sampleRealPlayers(10);
  let okCount = 0, skipped = 0;
  for (const p of players) {
    const lives = await getLivesTuple(p);
    if (lives.total === 0) { skipped++; continue; }
    const r = await sim('startLevel', [1], p);
    if (!r.ok) throw new Error(`${p} (lives=${JSON.stringify(lives)}): ${r.error}`);
    okCount++;
  }
  console.log(`     ${okCount} ok, ${skipped} skipped`);
});

console.log(`Proxy: ${PROXY}`);
console.log(`RPC:   ${RPC}`);
const result = await run();
console.log(`\n${result.pass} passed · ${result.fail} failed`);
process.exit(result.fail === 0 ? 0 : 1);
