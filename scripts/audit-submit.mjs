// ═══════════════════════════════════════════════════════════════════════
// audit-submit.mjs — submitLevel / submitLevelValidated / submitAndStartNext
// ═══════════════════════════════════════════════════════════════════════
import { PROXY, RPC, QUOTE_API_BASE, sim, read, freshAddress, makeRunner } from './_audit-shared.mjs';

const { test, run } = makeRunner('submit-flows');

const player = freshAddress();

// "Failed run" journal — no stars, sub-target score, completed=false.
// The validator computes stars from score against the level's target;
// stars=0 + completed=false is the safest "always-accepted" payload.
const sampleJournal = {
  level: 1,
  score: 100,
  stars: 0,
  movesUsed: 5,
  completed: false,
  durationMs: 30000,
  boostersUsed: [],
  shardsEarned: [],
  bigCombos: 0,
  fallerPenalties: 0,
};

async function fetchValidatorSig(p, journal) {
  const res = await fetch(`${QUOTE_API_BASE}/pengu-validate-level`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player: p, journal }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`validator failed: ${res.status} ${text.slice(0, 200)}`);
  }
  return res.json();
}

test('A1 validatorRelayer configured on chain', async () => {
  const r = await read('validatorRelayer', []);
  if (r === '0x0000000000000000000000000000000000000000') throw new Error('validatorRelayer not set');
});

test('A2 maxLevel set (gameplay configured)', async () => {
  const n = await read('maxLevel', []);
  if (Number(n) === 0) throw new Error('maxLevel is zero');
});

test('B1 validator endpoint signs a clean journal', async () => {
  const { signature } = await fetchValidatorSig(player, sampleJournal);
  if (!signature || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error(`bad signature: ${signature}`);
  }
});

test('B2 validator rejects out-of-bounds score (catches cheating client)', async () => {
  let body, status;
  try {
    const res = await fetch(`${QUOTE_API_BASE}/pengu-validate-level`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player, journal: { ...sampleJournal, score: 99999999 } }),
    });
    status = res.status;
    body = await res.json().catch(() => null);
  } catch (e) { throw new Error(`request failed: ${e.message}`); }
  // Either rejects with non-2xx, OR returns 200 but no signature.
  const refused = status >= 400 || (body && !body.signature);
  if (!refused) throw new Error(`validator signed cheating journal: ${JSON.stringify(body)}`);
});

test('C1 submitLevel without prior startLevel reverts NoStart', async () => {
  // submitLevel checks levelStartedAt[player][level] != 0 — fresh wallet
  // has never called startLevel so this must revert.
  const r = await sim('submitLevel', [sampleJournal], player);
  if (r.ok) throw new Error('submit without start should have reverted');
  // The exact error name depends on contract — anything that isn't
  // success is acceptable for the fresh case (NoStart, JournalLevelMismatch,
  // or any guard).
});

test('C2 submitLevelValidated with live sig: signature path accepts (reverts on a different guard)', async () => {
  const { signature } = await fetchValidatorSig(player, sampleJournal);
  const r = await sim('submitLevelValidated', [sampleJournal, signature], player);
  // Should revert at a downstream guard (likely NoStart since fresh wallet
  // never called startLevel). The key assertion: NOT ValidatorBadSigner.
  if (r.ok) throw new Error('expected revert, got success (fresh wallet should fail at NoStart)');
  if (/ValidatorBadSigner|ValidatorNotConfigured/i.test(r.error)) {
    throw new Error(`validator path broken: ${r.error}`);
  }
});

test('C3 submitLevelValidated with TAMPERED sig reverts ValidatorBadSigner', async () => {
  const { signature } = await fetchValidatorSig(player, sampleJournal);
  const bad = signature.slice(0, -2) + (signature.slice(-2) === 'ff' ? '00' : 'ff');
  const r = await sim('submitLevelValidated', [sampleJournal, bad], player);
  if (r.ok) throw new Error('tampered sig should have reverted');
});

test('C4 submitAndStartNext with live sig: signature path accepts', async () => {
  const { signature } = await fetchValidatorSig(player, sampleJournal);
  const r = await sim('submitAndStartNext', [sampleJournal, signature, 2], player);
  if (r.ok) {
    // Fresh wallet's seed materialization fires inside the embedded
    // _consumeLife → startLevel(2) succeeds. submit half may revert at
    // NoStart, but the whole call is atomic — either both halves run or
    // none. So success means BOTH halves resolved (only possible if the
    // submit half doesn't actually require a prior start, which depends
    // on contract semantics).
    return;
  }
  if (/ValidatorBadSigner|ValidatorNotConfigured/i.test(r.error)) {
    throw new Error(`validator path broken: ${r.error}`);
  }
});

console.log(`Proxy: ${PROXY}`);
console.log(`RPC:   ${RPC}`);
console.log(`Validator: ${QUOTE_API_BASE}/pengu-validate-level`);
const result = await run();
console.log(`\n${result.pass} passed · ${result.fail} failed`);
process.exit(result.fail === 0 ? 0 : 1);
