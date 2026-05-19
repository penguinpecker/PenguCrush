// ═══════════════════════════════════════════════════════════════════════
// audit-session-key-policy.mjs — verify GAMEPLAY_METHODS matches ABI
//
// Every signature in the session-key allowlist must:
//   1. Hash to a 4-byte selector
//   2. Match a function actually present in the contract ABI
//   3. NOT be a value-bearing / shop selector (those must require the
//      AGW prompt every time)
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { toFunctionSelector } from 'viem';
import { PROXY, abi, makeRunner } from './_audit-shared.mjs';

const { test, run } = makeRunner('session-key-policy');

const sessionKeySrc = readFileSync(new URL('../src/session-key.js', import.meta.url), 'utf8');
// Pull the GAMEPLAY_METHODS array members from source — keeps this test
// independent of any export shape changes.
const methods = (() => {
  const block = sessionKeySrc.match(/const GAMEPLAY_METHODS\s*=\s*\[([\s\S]*?)\];/)?.[1];
  if (!block) throw new Error('could not find GAMEPLAY_METHODS in src/session-key.js');
  return [...block.matchAll(/'([^']+\([^']*\))'/g)].map(m => m[1]);
})();

const SHOP_FORBIDDEN = [
  'buyBoosterETH', 'buyBoosterUSDC',
  'buyLivesETH', 'buyLivesUSDC',
  'buyCrushPassETH', 'buyCrushPassUSDC',
];

const abiFns = abi.filter(x => x.type === 'function').map(x => x.name);

test('A1 GAMEPLAY_METHODS is non-empty', () => {
  if (methods.length === 0) throw new Error('no methods in policy');
});

for (const sig of methods) {
  test(`B.${sig}: signature is a valid selector`, () => {
    const sel = toFunctionSelector(sig);
    if (!/^0x[0-9a-fA-F]{8}$/.test(sel)) throw new Error(`bad selector: ${sel}`);
  });

  test(`C.${sig}: function name exists in contract ABI`, () => {
    const fnName = sig.split('(')[0];
    if (!abiFns.includes(fnName)) {
      throw new Error(`${fnName} is in session policy but not in contract ABI`);
    }
  });

  test(`D.${sig}: NOT a value-bearing shop selector`, () => {
    const fnName = sig.split('(')[0];
    if (SHOP_FORBIDDEN.includes(fnName)) {
      throw new Error(`${fnName} is a shop selector — must require AGW prompt, not session key`);
    }
  });
}

test('E1 removed levelCheckpoint is NOT in session policy', () => {
  const has = methods.some(m => m.startsWith('levelCheckpoint('));
  if (has) throw new Error('levelCheckpoint was removed from client but still in session policy');
});

test('E2 removed levelCheckpoint not called from src/onchain.js', () => {
  const src = readFileSync(new URL('../src/onchain.js', import.meta.url), 'utf8');
  if (/export\s+(async\s+)?function\s+levelCheckpoint\b/.test(src)) {
    throw new Error('levelCheckpoint export still present in onchain.js');
  }
});

console.log(`Proxy: ${PROXY}`);
const result = await run();
console.log(`\n${result.pass} passed · ${result.fail} failed`);
process.exit(result.fail === 0 ? 0 : 1);
