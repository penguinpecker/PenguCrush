// ═══════════════════════════════════════════════════════════════════════
// audit-all.mjs — run every audit suite, aggregate results, exit non-zero
// if any suite fails. Wire this to CI or run pre-deploy.
// ═══════════════════════════════════════════════════════════════════════
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const suites = [
  'audit-life-system.mjs',
  'audit-pass-frozen.mjs',
  'audit-starter-pack.mjs',
  'audit-session-key-policy.mjs',
  'audit-shop-quotes.mjs',
  'audit-wheel.mjs',
  'audit-submit.mjs',
];

function runOne(script) {
  return new Promise(res => {
    const path = resolve(here, script);
    const child = spawn(process.execPath, [path], {
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', d => out += d.toString());
    child.stderr.on('data', d => err += d.toString());
    child.on('close', code => res({ script, code, out, err }));
  });
}

console.log('PenguCrushV2 full audit sweep');
console.log('─'.repeat(60));

const results = [];
for (const s of suites) {
  process.stdout.write(`\n${s}\n`);
  const r = await runOne(s);
  // Strip the per-suite preamble (Proxy/RPC lines) — keep test lines.
  const lines = r.out.split('\n').filter(l => /^  [✓✗ ]/.test(l) || /^\s*\d+ passed/.test(l));
  for (const l of lines) console.log(l);
  if (r.code !== 0 && r.err) console.log(`STDERR: ${r.err.trim().slice(0, 400)}`);
  results.push({ script: s, ok: r.code === 0 });
}

console.log('\n' + '─'.repeat(60));
const passed = results.filter(r => r.ok).length;
const failed = results.length - passed;
for (const r of results) console.log(`  ${r.ok ? '✓' : '✗'} ${r.script}`);
console.log(`\n${passed}/${results.length} suites passed`);
process.exit(failed === 0 ? 0 : 1);
