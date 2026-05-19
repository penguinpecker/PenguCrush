// Shared helpers for the audit suite. Each audit script wires these up
// against the live PenguCrushV2 proxy on Abstract mainnet.
import { createPublicClient, http, getAddress, BaseError, ContractFunctionRevertedError } from 'viem';
import { abstract } from 'viem/chains';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

export const PROXY = '0x06aCb91c46aD1359825560B19A9556118Aeb1896';
export const QUOTE_API_BASE = 'https://saftqlwxmdqxzfuwdgtu.supabase.co/functions/v1';
export const RPC = process.env.VITE_ABSTRACT_RPC_URL || 'https://api.mainnet.abs.xyz';
export const abi = JSON.parse(readFileSync(new URL('../contracts/PenguCrushABI.json', import.meta.url)));
export const pc = createPublicClient({ chain: abstract, transport: http(RPC) });

export function freshAddress() {
  return getAddress('0x' + randomBytes(20).toString('hex'));
}

export function decodeRevert(err) {
  if (err instanceof BaseError) {
    const r = err.walk(e => e instanceof ContractFunctionRevertedError);
    if (r) return r.data?.errorName || r.signature || r.reason || r.shortMessage;
  }
  return err.shortMessage || err.message;
}

export async function read(fn, args = []) {
  return pc.readContract({ address: PROXY, abi, functionName: fn, args });
}

export async function sim(fn, args, from, value) {
  try {
    await pc.simulateContract({
      address: PROXY, abi, functionName: fn, args, account: from,
      ...(value != null ? { value } : {}),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: decodeRevert(e) };
  }
}

export function makeRunner(suiteName) {
  const tests = [];
  let pass = 0, fail = 0;
  const failures = [];
  return {
    test(name, fn) { tests.push({ name, fn }); },
    async run() {
      console.log(`\n=== ${suiteName} ===`);
      for (const t of tests) {
        try {
          await t.fn();
          console.log(`  ✓ ${t.name}`);
          pass++;
        } catch (e) {
          console.log(`  ✗ ${t.name}`);
          console.log(`     ${e.message}`);
          fail++;
          failures.push({ suite: suiteName, name: t.name, error: e.message });
        }
      }
      return { suite: suiteName, pass, fail, failures };
    },
  };
}

export function assertEq(actual, expected, label) {
  const a = JSON.stringify(actual, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  const e = JSON.stringify(expected, (_, v) => typeof v === 'bigint' ? v.toString() : v);
  if (a !== e) throw new Error(`${label}: expected ${e}, got ${a}`);
}

/// Returns up to N registered players from the on-chain players[] array,
/// normalized to viem-friendly checksum addresses.
export async function sampleRealPlayers(maxN = 10) {
  const total = await read('getPlayerCount', []);
  const take = Math.min(Number(total), maxN);
  if (take === 0) return [];
  const rows = await read('getPlayers', [0n, BigInt(take)]);
  return rows.map(a => getAddress(a.toLowerCase()));
}

export async function getLivesTuple(addr) {
  const [regular, frozen, total, secondsToNext] = await read('getLives', [addr]);
  return { regular: Number(regular), frozen: Number(frozen), total: Number(total), secondsToNext: Number(secondsToNext) };
}

export async function getCrushPass(addr) {
  const cp = await read('crushPass', [addr]);
  return {
    expiresAt: Number(cp[0]),
    streakWeeks: Number(cp[1]),
    lastPurchaseWeekMonday: Number(cp[2]),
    active: Number(cp[0]) > Math.floor(Date.now() / 1000),
  };
}

export async function getLifeAccount(addr) {
  const la = await read('lifeAccount', [addr]);
  return { regular: Number(la[0]), frozen: Number(la[1]), lastConsumedAt: Number(la[2]) };
}
