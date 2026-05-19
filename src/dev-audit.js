// ═══════════════════════════════════════════════════════════════════════
// dev-audit.js — DEV-ONLY in-browser audit driver
//
// Exposes `window.__pengu_audit` so an external automation tool
// (opera-browser-cli, Puppeteer, etc.) can run the same checks the
// Node audit suite runs but from the actual front-end's chain wiring.
// Imported only when `import.meta.env.DEV === true`.
//
// Drives the production code paths (the same getPublicClient + ABI the
// game uses) so a regression that breaks how the front-end talks to
// chain shows up here.
//
// Usage from browser console or opera-browser-cli:
//
//     await window.__pengu_audit.run()        // → returns { pass, fail, results }
//     await window.__pengu_audit.freshLives() // → smoke a fresh-wallet getLives
// ═══════════════════════════════════════════════════════════════════════
import { PENGUCRUSH_ADDRESS } from './onchain.js';
import { getPublicClient } from './agw.js';
import abi from '../contracts/PenguCrushABI.json';
import { getAddress } from 'viem';

function rand20Bytes() {
  const a = new Uint8Array(20);
  crypto.getRandomValues(a);
  return '0x' + Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
}
function fresh() { return getAddress(rand20Bytes()); }

async function read(fn, args = []) {
  return getPublicClient().readContract({ address: PENGUCRUSH_ADDRESS, abi, functionName: fn, args });
}

async function sim(fn, args, from) {
  try {
    await getPublicClient().simulateContract({ address: PENGUCRUSH_ADDRESS, abi, functionName: fn, args, account: from });
    return { ok: true };
  } catch (e) {
    // Walk for the decoded contract error so we can match by error name
    // (browser viem leaves it out of shortMessage by default).
    let errName = '';
    let cur = e;
    while (cur) {
      if (cur.data?.errorName) { errName = cur.data.errorName; break; }
      if (cur.signature) { errName = cur.signature; break; }
      cur = cur.cause;
    }
    return { ok: false, error: errName || e.shortMessage || e.message };
  }
}

async function freshLives() {
  const a = fresh();
  const [r, f, t, sec] = await read('getLives', [a]);
  return { address: a, regular: Number(r), frozen: Number(f), total: Number(t), secondsToNext: Number(sec) };
}

const tests = [
  // Fresh-wallet seed (the bug we just fixed)
  ['fresh getLives = (5,0,5,0)', async () => {
    const x = await freshLives();
    if (x.regular !== 5 || x.frozen !== 0 || x.total !== 5) throw new Error(JSON.stringify(x));
  }],
  ['fresh startLevel(1) simulates clean', async () => {
    const r = await sim('startLevel', [1], fresh());
    if (!r.ok) throw new Error(r.error);
  }],
  ['fresh startLevel(0) reverts (bounds guard intact)', async () => {
    const r = await sim('startLevel', [0], fresh());
    if (r.ok) throw new Error('expected revert');
    // Browser viem may not decode the custom error name; revert alone proves
    // the guard. Node-side audit asserts the exact "InvalidLevel" name.
  }],
  ['fresh claimRegen() is no-op', async () => {
    const r = await sim('claimRegen', [], fresh());
    if (!r.ok) throw new Error(r.error);
  }],
  ['fresh lifeAccount == (0,0,0)', async () => {
    const a = fresh();
    const la = await read('lifeAccount', [a]);
    if (Number(la[0]) || Number(la[1]) || Number(la[2])) throw new Error(JSON.stringify(la));
  }],
  ['fresh crushPass == (0,0,0)', async () => {
    const cp = await read('crushPass', [fresh()]);
    if (Number(cp[0]) || Number(cp[1]) || Number(cp[2])) throw new Error(JSON.stringify(cp));
  }],
  ['fresh claimedStarterPack == false', async () => {
    if (await read('claimedStarterPack', [fresh()]) !== false) throw new Error('truthy');
  }],
  ['priceRelayer configured (non-zero)', async () => {
    const r = await read('priceRelayer', []);
    if (r === '0x0000000000000000000000000000000000000000') throw new Error('unset');
  }],
  ['validatorRelayer configured (non-zero)', async () => {
    const r = await read('validatorRelayer', []);
    if (r === '0x0000000000000000000000000000000000000000') throw new Error('unset');
  }],
  ['maxLevel > 0', async () => {
    const n = await read('maxLevel', []);
    if (Number(n) === 0) throw new Error('zero');
  }],
  ['getLives invariants on 16 random addresses', async () => {
    for (let i = 0; i < 16; i++) {
      const x = await freshLives();
      if (x.regular + x.frozen !== x.total) throw new Error(`sum mismatch: ${JSON.stringify(x)}`);
      if (x.regular > 5 || x.frozen > 2) throw new Error(`cap violated: ${JSON.stringify(x)}`);
    }
  }],
];

async function run() {
  const results = [];
  for (const [name, fn] of tests) {
    try { await fn(); results.push({ name, ok: true }); }
    catch (e) { results.push({ name, ok: false, error: e.message }); }
  }
  const pass = results.filter(r => r.ok).length;
  const fail = results.length - pass;
  // Console output mirrors the Node runner style so opera-cli can grep it.
  for (const r of results) {
    if (r.ok) console.log(`  ✓ ${r.name}`);
    else console.log(`  ✗ ${r.name} — ${r.error}`);
  }
  console.log(`${pass}/${results.length} passed`);
  return { pass, fail, results };
}

window.__pengu_audit = { run, freshLives, read, sim, fresh };
console.log('[dev-audit] window.__pengu_audit ready — call `await __pengu_audit.run()`');
