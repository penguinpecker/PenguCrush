// Smoke test: simulate startLevel(1) from a never-touched wallet against the
// live proxy via eth_call. Pre-upgrade this reverts NoLives; post-upgrade it
// must succeed. Also verifies played wallet still works (no regression).
import { createPublicClient, http, encodeFunctionData, getAddress, parseAbi } from 'viem';
import { abstract } from 'viem/chains';
import { readFileSync } from 'node:fs';

const PROXY = '0x06aCb91c46aD1359825560B19A9556118Aeb1896';
const abi = JSON.parse(readFileSync(new URL('../contracts/PenguCrushABI.json', import.meta.url)));
const rpc = process.env.VITE_ABSTRACT_RPC_URL || 'https://api.mainnet.abs.xyz';
const pc = createPublicClient({ chain: abstract, transport: http(rpc) });

const FRESH = getAddress('0x000000000000000000000000000000000000feed'); // never touched
const PLAYED = process.argv[2] ? getAddress(process.argv[2]) : null;

async function getLives(addr) {
  const [regular, frozen, total, secondsToNext] = await pc.readContract({
    address: PROXY, abi, functionName: 'getLives', args: [addr],
  });
  return { regular: Number(regular), frozen: Number(frozen), total: Number(total), secondsToNext: Number(secondsToNext) };
}

async function simulateStartLevel(addr, level = 1) {
  try {
    await pc.simulateContract({
      address: PROXY, abi, functionName: 'startLevel', args: [level], account: addr,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.shortMessage || e.message };
  }
}

console.log('Proxy:', PROXY);
console.log('Fresh wallet test:', FRESH);
console.log('  getLives ->', await getLives(FRESH));
console.log('  simulate startLevel(1) ->', await simulateStartLevel(FRESH));

if (PLAYED) {
  console.log('Played wallet:', PLAYED);
  console.log('  getLives ->', await getLives(PLAYED));
  console.log('  simulate startLevel(1) ->', await simulateStartLevel(PLAYED));
}
