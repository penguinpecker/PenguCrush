// EIP-712 helpers for PenguCrushV2 ShopQuote signing.
// Relayer key resolution: Deno.env (dashboard secret) first, then Supabase
// Vault via the `public.get_vault_secret` security-definer RPC (service_role
// only). Cached in module memory after first read.

import { privateKeyToAccount } from 'npm:viem@^2.47.12/accounts';
import { abstract } from 'npm:viem@^2.47.12/chains';
import { keccak256, stringToBytes } from 'npm:viem@^2.47.12';
import { createClient } from 'npm:@supabase/supabase-js@2';

export const PENGUCRUSH_ADDRESS = '0x06aCb91c46aD1359825560B19A9556118Aeb1896' as const;

const DOMAIN = {
  name: 'PenguCrush',
  version: '1',
  chainId: abstract.id,
  verifyingContract: PENGUCRUSH_ADDRESS,
} as const;

export interface ShopQuote {
  buyer: `0x${string}`;
  sku: `0x${string}`;
  qty: number;
  currency: 0 | 1;
  amount: string;
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

export function sku(name: string): `0x${string}` {
  return keccak256(stringToBytes(name));
}

let _relayerKey: string | null = null;
async function getRelayerKey(): Promise<string> {
  if (_relayerKey) return _relayerKey;
  const envKey = (Deno.env.get('RELAYER_PRIVATE_KEY') || '').trim();
  if (envKey && envKey.length >= 64) { _relayerKey = envKey; return envKey; }
  const url = Deno.env.get('SUPABASE_URL');
  const srk = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !srk) throw new Error('SUPABASE_URL or SERVICE_ROLE_KEY env missing');
  const supabase = createClient(url, srk, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc('get_vault_secret', { p_name: 'RELAYER_PRIVATE_KEY' });
  if (error) throw new Error(`vault read failed: ${error.message}`);
  if (!data) throw new Error('RELAYER_PRIVATE_KEY not in vault and not in env');
  _relayerKey = String(data).trim();
  return _relayerKey;
}

export async function getRelayer() {
  const pk = (await getRelayerKey()) as `0x${string}`;
  return privateKeyToAccount(pk);
}

export async function signShopQuote(quote: ShopQuote): Promise<`0x${string}`> {
  const account = await getRelayer();
  return await account.signTypedData({
    domain: DOMAIN, types: QUOTE_TYPES, primaryType: 'ShopQuote',
    message: {
      buyer: quote.buyer, sku: quote.sku,
      qty: BigInt(quote.qty), currency: BigInt(quote.currency),
      amount: BigInt(quote.amount), nonce: BigInt(quote.nonce),
      deadline: BigInt(quote.deadline),
    },
  });
}

export function randomNonce(): string {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  let n = 0n;
  for (const b of buf) n = (n << 8n) | BigInt(b);
  return n.toString();
}

/// Canonical bundle definitions. The UI sells one bundle per click — the
/// label IS the bundle total, not a per-unit cost.
///   booster.* = 4 boosters for $2.98 (flat)
///   life.regular = 5 lives for $2.99 (flat)
///   pass.weekly = 1 pass for $4.99
/// The server clamps `qty` to `size`, so a client cannot request 99
/// boosters and pay $2.98 by tampering with the request.
export const SKU_BUNDLES: Record<string, { size: number; priceMicros: bigint }> = {
  'booster.row':       { size: 4, priceMicros: 2_980_000n },
  'booster.col':       { size: 4, priceMicros: 2_980_000n },
  'booster.colorBomb': { size: 4, priceMicros: 2_980_000n },
  'booster.hammer':    { size: 4, priceMicros: 2_980_000n },
  'booster.shuffle':   { size: 4, priceMicros: 2_980_000n },
  'life.regular':      { size: 5, priceMicros: 2_990_000n },
  'pass.weekly':       { size: 1, priceMicros: 4_990_000n },
};

/// Dynamic ETH/USD spot. CoinGecko free tier — FAILS CLOSED if upstream is
/// down so we don't silently underprice quotes when ETH moons during a CG
/// outage. Caller is expected to catch and return a 503 to the client.
/// To explicitly opt back into the (dangerous) fallback, set the env var
/// `ETH_USD_PRICE_FALLBACK_ALLOWED=true` and provide `ETH_USD_FALLBACK`.
export class EthUsdUnavailable extends Error {
  constructor(reason: string) { super(`ETH/USD price unavailable: ${reason}`); }
}

export async function getEthUsdPrice(): Promise<number> {
  let lastErr: unknown;
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd', {
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) throw new Error(`coingecko ${r.status}`);
    const j = await r.json();
    const p = Number(j?.ethereum?.usd);
    if (Number.isFinite(p) && p > 100 && p < 100_000) return p;
    throw new Error(`bad price ${p}`);
  } catch (err) {
    lastErr = err;
  }
  // Fail-closed by default. Operator can opt-in to the fallback via env if they
  // accept the silent-mispricing risk for development environments.
  if (Deno.env.get('ETH_USD_PRICE_FALLBACK_ALLOWED') === 'true') {
    const fallback = Number(Deno.env.get('ETH_USD_FALLBACK') || '0');
    if (Number.isFinite(fallback) && fallback > 100 && fallback < 100_000) {
      console.warn('CoinGecko ETH/USD failed, using opted-in fallback:', lastErr, fallback);
      return fallback;
    }
  }
  throw new EthUsdUnavailable(String((lastErr as Error)?.message || lastErr || 'unknown'));
}

export function usdMicrosToWei(usdMicros: bigint, ethUsd: number): bigint {
  const ethUsdScaled = BigInt(Math.round(ethUsd * 1e6));
  return (usdMicros * 10n ** 18n) / ethUsdScaled;
}
