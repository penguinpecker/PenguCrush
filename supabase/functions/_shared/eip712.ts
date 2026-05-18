// EIP-712 signing helpers for PenguCrushV2 quote/roll relayer.
// Used by pengu-quote-price and pengu-wheel-roll.

import { privateKeyToAccount } from 'npm:viem@^2.47.12/accounts';
import { abstract } from 'npm:viem@^2.47.12/chains';
import { keccak256, stringToBytes } from 'npm:viem@^2.47.12';

const DOMAIN = {
  name: 'PenguCrush',
  version: '1',
  chainId: abstract.id, // 2741
  // verifyingContract set per-call from env
} as const;

export type Currency = 'ETH' | 'USDC';

export interface ShopQuote {
  buyer: `0x${string}`;
  sku: `0x${string}`;
  qty: number;
  currency: 0 | 1; // 0=ETH, 1=USDC
  amount: string;  // wei or micros (USDC 6dec) as decimal string for JSON safety
  nonce: string;
  deadline: number;
}

export interface WheelRoll {
  player: `0x${string}`;
  dayUtc: number;     // julian day
  slotIndex: number;
  nonce: string;
  deadline: number;
}

const QUOTE_TYPES = {
  ShopQuote: [
    { name: 'buyer',    type: 'address' },
    { name: 'sku',      type: 'bytes32' },
    { name: 'qty',      type: 'uint32' },
    { name: 'currency', type: 'uint8' },
    { name: 'amount',   type: 'uint256' },
    { name: 'nonce',    type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

const ROLL_TYPES = {
  WheelRoll: [
    { name: 'player',    type: 'address' },
    { name: 'dayUtc',    type: 'uint64' },
    { name: 'slotIndex', type: 'uint8' },
    { name: 'nonce',     type: 'uint256' },
    { name: 'deadline',  type: 'uint256' },
  ],
} as const;

export function sku(name: string): `0x${string}` {
  return keccak256(stringToBytes(name));
}

export function getRelayer() {
  const pk = (Deno.env.get('RELAYER_PRIVATE_KEY') || '').trim() as `0x${string}`;
  if (!pk || pk.length < 64) throw new Error('RELAYER_PRIVATE_KEY missing or malformed');
  return privateKeyToAccount(pk);
}

function verifyingContract(): `0x${string}` {
  const addr = Deno.env.get('PENGUCRUSH_ADDRESS') as `0x${string}` | undefined;
  if (!addr || !addr.startsWith('0x')) throw new Error('PENGUCRUSH_ADDRESS missing');
  return addr;
}

export async function signShopQuote(quote: ShopQuote): Promise<`0x${string}`> {
  const account = getRelayer();
  return await account.signTypedData({
    domain: { ...DOMAIN, verifyingContract: verifyingContract() },
    types: QUOTE_TYPES,
    primaryType: 'ShopQuote',
    message: {
      buyer: quote.buyer,
      sku: quote.sku,
      qty: BigInt(quote.qty),
      currency: BigInt(quote.currency),
      amount: BigInt(quote.amount),
      nonce: BigInt(quote.nonce),
      deadline: BigInt(quote.deadline),
    },
  });
}

export async function signWheelRoll(roll: WheelRoll): Promise<`0x${string}`> {
  const account = getRelayer();
  return await account.signTypedData({
    domain: { ...DOMAIN, verifyingContract: verifyingContract() },
    types: ROLL_TYPES,
    primaryType: 'WheelRoll',
    message: {
      player: roll.player,
      dayUtc: BigInt(roll.dayUtc),
      slotIndex: BigInt(roll.slotIndex),
      nonce: BigInt(roll.nonce),
      deadline: BigInt(roll.deadline),
    },
  });
}

/** Generate a fresh 256-bit random nonce as a decimal string. */
export function randomNonce(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n.toString();
}

/** Lookup SKU and USD price (in micros) given a human name. */
export const SKU_USD_MICROS: Record<string, bigint> = {
  'booster.row':       4_990_000n,   // $2.98 each — we'll quote per-qty
  'booster.col':       4_990_000n,
  'booster.colorBomb': 4_990_000n,
  'booster.hammer':    4_990_000n,
  'booster.shuffle':   4_990_000n,
  'life.regular':      2_990_000n,
  'pass.weekly':       4_990_000n,
};

/** $-cents pricing (matches chain seed). Per-unit. */
export const SKU_UNIT_USD_MICROS: Record<string, bigint> = {
  'booster.row':       2_980_000n,
  'booster.col':       2_980_000n,
  'booster.colorBomb': 2_980_000n,
  'booster.hammer':    2_980_000n,
  'booster.shuffle':   2_980_000n,
  'life.regular':      2_990_000n,
  'pass.weekly':       4_990_000n,
};

/** Fetch ETH/USD spot price from CoinGecko (free, no key). Falls back to env. */
export async function getEthUsdPrice(): Promise<number> {
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    if (!r.ok) throw new Error(`coingecko ${r.status}`);
    const j = await r.json();
    const p = Number(j?.ethereum?.usd);
    if (Number.isFinite(p) && p > 100 && p < 100_000) return p;
    throw new Error(`bad price ${p}`);
  } catch (err) {
    const fallback = Number(Deno.env.get('ETH_USD_FALLBACK') || '3000');
    console.warn('CoinGecko ETH/USD lookup failed, using fallback:', err, fallback);
    return fallback;
  }
}

/** Convert USD micros to ETH wei using current spot price. */
export function usdMicrosToWei(usdMicros: bigint, ethUsd: number): bigint {
  // wei = (usd_micros / 1e6 / eth_usd) * 1e18
  //     = usd_micros * 1e12 / eth_usd
  const ethUsdScaled = BigInt(Math.round(ethUsd * 1e6));
  return (usdMicros * 10n ** 18n) / ethUsdScaled;
}
