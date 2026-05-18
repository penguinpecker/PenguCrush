// ═══════════════════════════════════════════════════════════════
//  ON-CHAIN API — PenguCrushV2 on Abstract mainnet (chainId 2741)
//
//  Single entry point for every chain interaction. Uses AGW session
//  keys (when granted) so in-game txs auto-execute without per-tx
//  wallet prompts. Shop purchases bypass the session key — those
//  always go through the normal walletClient so the user sees the
//  payment prompt.
// ═══════════════════════════════════════════════════════════════

import { getWalletClient, getAGWAddress, getPublicClient } from './agw.js';
import { getSessionClient } from './session-key.js';
import { abstract } from 'viem/chains';
import { keccak256, toBytes, encodeAbiParameters, parseAbiParameters } from 'viem';
import penguCrushAbiJson from '../contracts/PenguCrushABI.json';

const ENV = (import.meta.env || {});

/** PenguCrushV2 UUPS proxy — set via VITE_PENGUCRUSH_ADDRESS, hard-coded fallback. */
export const PENGUCRUSH_ADDRESS =
  ENV.VITE_PENGUCRUSH_ADDRESS || '0x06aCb91c46aD1359825560B19A9556118Aeb1896';

export const USDC_ADDRESS =
  ENV.VITE_USDC_ADDRESS || '0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1';

const QUOTE_API_BASE =
  ENV.VITE_QUOTE_API_BASE ||
  'https://saftqlwxmdqxzfuwdgtu.supabase.co/functions/v1';

const penguCrushAbi = Array.isArray(penguCrushAbiJson) ? penguCrushAbiJson : penguCrushAbiJson.abi || [];

// Currency enum codes — must match Solidity order
export const CURRENCY = { ETH: 0, USDC: 1 };

// SKU helpers — keccak256 of the on-chain name, e.g. "booster.row"
const skuCache = new Map();
export function sku(name) {
  if (skuCache.has(name)) return skuCache.get(name);
  const h = keccak256(toBytes(name));
  skuCache.set(name, h);
  return h;
}

// ── Kill switch ───────────────────────────────────────────────

function isDisabled() {
  return ENV.VITE_ONCHAIN_DISABLED === 'true';
}

// ── Internal write helper ─────────────────────────────────────

/**
 * Send a write. If a session key is granted for this method, use it (silent
 * tx, no prompt). Otherwise route through the user's AGW (prompts).
 */
async function chainWrite(label, functionName, args, options = {}) {
  if (isDisabled()) {
    // The kill switch is supposed to be a debug aid, not a silent UX win.
    // Throwing makes callers (UI handlers) show "Failed" instead of a fake "+1 ✓".
    throw new Error(`onchain disabled (VITE_ONCHAIN_DISABLED set)`);
  }
  const account = getAGWAddress();
  if (!account) throw new Error('wallet not connected');
  // Shop / value-bearing calls always go through the main wallet so the user
  // explicitly authorizes the payment. Caller signals via `requireUserPrompt`.
  const wantSession = !options.requireUserPrompt;
  const sessionClient = wantSession ? await getSessionClient(functionName).catch(() => null) : null;
  const client = sessionClient || getWalletClient();
  if (!client) throw new Error('wallet client missing — reconnect AGW');
  const hash = await client.writeContract({
    address: PENGUCRUSH_ADDRESS,
    abi: penguCrushAbi,
    functionName,
    args,
    account,
    chain: abstract,
    value: options.value || 0n,
  });
  if (options.waitForReceipt !== false) {
    const pc = getPublicClient();
    const receipt = await pc.waitForTransactionReceipt({ hash, confirmations: 1 });
    if (receipt.status !== 'success') throw new Error(`reverted (status=${receipt.status})`);
    return { hash, receipt, used: sessionClient ? 'session' : 'wallet' };
  }
  return { hash, used: sessionClient ? 'session' : 'wallet' };
}

async function chainRead(functionName, args = []) {
  const pc = getPublicClient();
  return pc.readContract({
    address: PENGUCRUSH_ADDRESS,
    abi: penguCrushAbi,
    functionName,
    args,
  });
}

// ═══════════════════════════════════════════════════════════════
//  GAMEPLAY WRITES — session-key safe
// ═══════════════════════════════════════════════════════════════

export function startLevel(level) {
  return chainWrite('startLevel', 'startLevel', [Number(level)]);
}

/**
 * V2.2: validate-then-submit. The server-side validator (Supabase edge
 * function `pengu-validate-level`) bounds-checks the journal against per-level
 * limits + recomputes stars from score, then signs an EIP-712 Validation
 * approval. The on-chain `submitLevelValidated` verifies the signature
 * against `validatorRelayer` and only then records the result. Falls back to
 * unvalidated `submitLevel` if the validator returns an error (so a
 * misbehaving validator can't fully brick gameplay — chain still records
 * the play, just without the validated flag).
 */
export async function submitLevel(journal) {
  const j = {
    level: Number(journal.level),
    score: Number(journal.score),
    stars: Number(journal.stars),
    movesUsed: Number(journal.movesUsed),
    completed: !!journal.completed,
    durationMs: Number(journal.durationMs),
    boostersUsed: journal.boostersUsed || [],
    shardsEarned: journal.shardsEarned || [],
    bigCombos: Number(journal.bigCombos || 0),
    fallerPenalties: Number(journal.fallerPenalties || 0),
  };
  const player = getAGWAddress();
  if (!player) return chainWrite('submitLevel', 'submitLevel', [j]);

  // 1) Ask the validator to bounds-check + sign.
  try {
    const url = `${QUOTE_API_BASE}/pengu-validate-level`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player, journal: j }),
    });
    if (res.ok) {
      const { signature } = await res.json();
      if (signature) {
        // 2) Submit the validated journal — gas-cheaper for indexers since
        //    a LevelValidated event fires alongside LevelSubmitted.
        return chainWrite('submitLevelValidated', 'submitLevelValidated', [j, signature]);
      }
    } else {
      const text = await res.text().catch(() => '');
      console.warn('validator rejected journal:', res.status, text);
    }
  } catch (err) {
    console.warn('validator unreachable, falling back to unvalidated:', err?.message || err);
  }
  // 3) Validator down or rejected — degrade gracefully to unvalidated path so
  //    the chain still records the play (no leaderboard validation marker).
  return chainWrite('submitLevel', 'submitLevel', [j]);
}

export function levelCheckpoint(level, moveNum, snapshotHash) {
  return chainWrite('levelCheckpoint', 'levelCheckpoint',
    [Number(level), Number(moveNum), snapshotHash],
    { waitForReceipt: false }); // fire-and-forget, low priority
}

export function claimRegen() {
  return chainWrite('claimRegen', 'claimRegen', []);
}

/// V2.3 — one-time per-wallet starter pack: 1 of every enabled Booster on chain.
/// Permissionless + idempotent (chain reverts StarterPackAlreadyClaimed on 2nd
/// call). Session-key safe so it runs silently after the user's first SIWE.
export function claimStarterPack() {
  return chainWrite('claimStarterPack', 'claimStarterPack', []);
}

/// Read whether this wallet has already claimed the starter pack.
export async function readStarterPackClaimed(player) {
  const p = player || getAGWAddress();
  if (!p) return false;
  return chainRead('claimedStarterPack', [p]);
}

export function cancelCrushPass() {
  return chainWrite('cancelCrushPass', 'cancelCrushPass', []);
}

// ═══════════════════════════════════════════════════════════════
//  SHOP — quote fetch + payable
// ═══════════════════════════════════════════════════════════════

/**
 * Ask the backend signer for a fresh price quote.
 * skuName: "booster.row" | "booster.col" | ... | "life.regular" | "pass.weekly"
 * currency: 'ETH' | 'USDC'
 */
export async function fetchShopQuote({ skuName, qty = 1, currency = 'ETH' }) {
  const buyer = getAGWAddress();
  if (!buyer) throw new Error('No wallet connected');
  const url = `${QUOTE_API_BASE}/pengu-quote-price`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ buyer, skuName, qty, currency }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`quote failed: ${res.status} ${text}`);
  }
  return await res.json();
  // returns: { quote: { buyer, sku, qty, currency, amount, nonce, deadline }, signature }
}

export async function buyBoosterETH(skuName, qty = 1) {
  const { quote, signature } = await fetchShopQuote({ skuName, qty, currency: 'ETH' });
  return chainWrite('buyBoosterETH', 'buyBoosterETH', [quote.sku, quote, signature], {
    value: BigInt(quote.amount),
    requireUserPrompt: true,
  });
}

export async function buyBoosterUSDC(skuName, qty = 1) {
  const { quote, signature } = await fetchShopQuote({ skuName, qty, currency: 'USDC' });
  // Caller is responsible for ensuring USDC approval to PENGUCRUSH_ADDRESS first
  return chainWrite('buyBoosterUSDC', 'buyBoosterUSDC', [quote.sku, quote, signature], {
    requireUserPrompt: true,
  });
}

export async function buyLivesETH(qty = 1) {
  const { quote, signature } = await fetchShopQuote({ skuName: 'life.regular', qty, currency: 'ETH' });
  return chainWrite('buyLivesETH', 'buyLivesETH', [quote, signature], {
    value: BigInt(quote.amount),
    requireUserPrompt: true,
  });
}

export async function buyLivesUSDC(qty = 1) {
  const { quote, signature } = await fetchShopQuote({ skuName: 'life.regular', qty, currency: 'USDC' });
  return chainWrite('buyLivesUSDC', 'buyLivesUSDC', [quote, signature], {
    requireUserPrompt: true,
  });
}

export async function buyCrushPassETH() {
  const { quote, signature } = await fetchShopQuote({ skuName: 'pass.weekly', qty: 1, currency: 'ETH' });
  return chainWrite('buyCrushPassETH', 'buyCrushPassETH', [quote, signature], {
    value: BigInt(quote.amount),
    requireUserPrompt: true,
  });
}

export async function buyCrushPassUSDC() {
  const { quote, signature } = await fetchShopQuote({ skuName: 'pass.weekly', qty: 1, currency: 'USDC' });
  return chainWrite('buyCrushPassUSDC', 'buyCrushPassUSDC', [quote, signature], {
    requireUserPrompt: true,
  });
}

// ═══════════════════════════════════════════════════════════════
//  DAILY WHEEL — server-signed roll
// ═══════════════════════════════════════════════════════════════

export async function spinDailyWheel() {
  const player = getAGWAddress();
  if (!player) throw new Error('No wallet connected');
  const url = `${QUOTE_API_BASE}/pengu-wheel-roll`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ player }),
  });
  if (!res.ok) throw new Error(`wheel roll failed: ${res.status}`);
  const { roll, signature } = await res.json();
  return chainWrite('spinDailyWheel', 'spinDailyWheel', [roll, signature]);
}

// ═══════════════════════════════════════════════════════════════
//  READS — single source of truth for the UI
// ═══════════════════════════════════════════════════════════════

export async function readLives(player) {
  const p = player || getAGWAddress();
  if (!p) return null;
  const [regular, frozen, total, secondsToNext] = await chainRead('getLives', [p]);
  return { regular: Number(regular), frozen: Number(frozen), total: Number(total), secondsToNext: Number(secondsToNext) };
}

export async function readPlayerStats(player) {
  const p = player || getAGWAddress();
  if (!p) return null;
  return chainRead('getPlayerStats', [p]);
}

export async function readBestResult(player, level) {
  const p = player || getAGWAddress();
  if (!p) return null;
  return chainRead('getBestResult', [p, Number(level)]);
}

export async function readInventory(player) {
  const p = player || getAGWAddress();
  if (!p) return null;
  const [skus, kinds, balances] = await chainRead('getInventory', [p]);
  // kinds: 1=Booster, 2=Shard, 3=Currency, 4=Lives
  const KIND = { 1: 'booster', 2: 'shard', 3: 'currency', 4: 'lives' };
  const out = { boosters: {}, shards: {}, currencies: {}, lives: {} };
  for (let i = 0; i < skus.length; i++) {
    const k = KIND[Number(kinds[i])];
    if (!k) continue;
    out[k + 's'] ??= {}; // safety
    out[k === 'currency' ? 'currencies' : k + 's'][skus[i]] = Number(balances[i]);
  }
  return out;
}

export async function readCrushPass(player) {
  const p = player || getAGWAddress();
  if (!p) return null;
  const cp = await chainRead('crushPass', [p]);
  return {
    expiresAt: Number(cp[0]) * 1000, // ms
    streakWeeks: Number(cp[1]),
    lastPurchaseWeekMonday: Number(cp[2]),
    active: Number(cp[0]) > Math.floor(Date.now() / 1000),
  };
}

export async function readLastWheelDay(player) {
  const p = player || getAGWAddress();
  if (!p) return null;
  return Number(await chainRead('lastWheelDay', [p]));
}

export async function readSkuPriceUsdMicros(skuName) {
  return Number(await chainRead('skuPriceUsdMicros', [sku(skuName)]));
}

