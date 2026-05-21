// ═══════════════════════════════════════════════════════════════
//  ON-CHAIN API — PenguCrushV2 on Abstract mainnet (chainId 2741)
//
//  Single entry point for every chain interaction. Uses AGW session
//  keys (when granted) so in-game txs auto-execute without per-tx
//  wallet prompts. Shop purchases bypass the session key — those
//  always go through the normal walletClient so the user sees the
//  payment prompt.
// ═══════════════════════════════════════════════════════════════

import { getWalletClient, ensureWalletClient, getAGWAddress, getPublicClient, getAgwClient } from './agw.js';
import { getSessionClient, hasActiveSession, prepareSessionGrantCall } from './session-key.js';
import { abstract } from 'viem/chains';
import { keccak256, toBytes, encodeAbiParameters, parseAbiParameters } from 'viem';
import { logTxSubmitted, logTxResult, logTxError } from './tx-log.js';
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

/// Patterns AGW / zksync surface when a session key is no longer usable —
/// usually because the lifetime fee budget (0.05 ETH) is exhausted, or the
/// 24h TTL expired, or the session was revoked. Hitting any of these is the
/// signal to ask the user for a fresh session and retry the write through it.
const SESSION_EXHAUSTED_RX = /session[-_ ]?(expired|closed|invalid|exhaust|disabled|revoked)|feeLimit|fee[-_ ]?limit|FeeLimit|SessionLib|sessionState|validation\s+failed|hook validation failed|no longer authorized/i;

function looksLikeSessionExhausted(msg) {
  return SESSION_EXHAUSTED_RX.test(String(msg || ''));
}

/**
 * Send a write. If a session key is granted for this method, use it (silent
 * tx, no prompt). Otherwise route through the user's AGW (prompts).
 *
 * Auto-renewal: if a session-key write fails with a "session exhausted /
 * expired / fee-limit hit" error, we clear the local blob, ask the user to
 * sign one re-grant, then retry the write through the fresh session. Net UX
 * is a single extra prompt when the 0.05 ETH lifetime budget runs out (or
 * the 24h TTL hits) instead of an unexplained revert.
 */
async function chainWrite(label, functionName, args, options = {}) {
  const account = getAGWAddress();
  // Build a sanitized details payload for the tx log (no BigInts, no PII).
  const logDetails = {
    function: functionName,
    valueWei: options.value ? String(options.value) : '0',
    requireUserPrompt: !!options.requireUserPrompt,
  };

  if (isDisabled()) {
    logTxError({ wallet: account, type: label, error: 'onchain_disabled', details: logDetails });
    throw new Error(`onchain disabled (VITE_ONCHAIN_DISABLED set)`);
  }
  if (!account) {
    logTxError({ wallet: '0x0000000000000000000000000000000000000000', type: label, error: 'wallet_not_connected', details: logDetails });
    throw new Error('wallet not connected');
  }
  const wantSession = !options.requireUserPrompt;
  let sessionClient = wantSession ? await getSessionClient(functionName).catch(() => null) : null;
  let client;
  try {
    client = sessionClient || await ensureWalletClient();
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    logTxError({ wallet: account, type: label, error: `ensureWalletClient: ${msg}`, details: logDetails });
    throw err;
  }
  if (!client) {
    logTxError({ wallet: account, type: label, error: 'no_client', details: logDetails });
    throw new Error('wallet client missing — reconnect AGW');
  }
  // Loud per-tx logging so you can see at a glance which calls run silently
  // through the session key vs which ones pop the wallet. If gameplay calls
  // are showing 'wallet', the session-key path is broken and needs fixing.
  console.info(`[chainWrite] ${label} (${functionName}) → ${sessionClient ? 'SESSION (silent)' : 'WALLET (popup)'}${options.requireUserPrompt ? ' [requireUserPrompt]' : ''}${wantSession && !sessionClient ? ' [session unavailable]' : ''}`);

  let hash;
  try {
    hash = await client.writeContract({
      address: PENGUCRUSH_ADDRESS,
      abi: penguCrushAbi,
      functionName,
      args,
      account,
      chain: abstract,
      value: options.value || 0n,
    });
  } catch (err) {
    const msg = err?.shortMessage || err?.message || String(err);
    const rejected = /reject|denied|cancel/i.test(msg);

    // Auto-renewal path: only kicks in when (a) the failed write was via the
    // session client, (b) the error looks like a session-exhausted signature,
    // (c) the user didn't just cancel, and (d) we're not in a recursive
    // retry already (options._retriedAfterRenew prevents loops).
    if (sessionClient && !rejected && !options._retriedAfterRenew && looksLikeSessionExhausted(msg)) {
      const renewed = await _renewSessionInteractive(account, label, msg).catch(() => false);
      if (renewed) {
        // Retry via the freshly-granted session. Mark the recursive flag so
        // a second failure doesn't loop us back into another re-grant prompt.
        return chainWrite(label, functionName, args, { ...options, _retriedAfterRenew: true });
      }
    }

    logTxError({ wallet: account, type: label, error: rejected ? `user_rejected: ${msg}` : `writeContract: ${msg}`, details: { ...logDetails, used: sessionClient ? 'session' : 'wallet' } });
    throw err;
  }

  // Insert "submitted" row so the trail exists even if waitForTransactionReceipt
  // hangs or the page closes mid-mine.
  const rowId = await logTxSubmitted({ wallet: account, type: label, txHash: hash, details: { ...logDetails, used: sessionClient ? 'session' : 'wallet' } });

  if (options.waitForReceipt !== false) {
    const pc = getPublicClient();
    try {
      // Bounded wait so a sequencer / RPC stall can't pin the level-popup
      // Next button forever. 120 s is well past Abstract's ~2 s block time
      // and well past a normal worst-case sequencer hiccup (audit H6).
      const receipt = await pc.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 120_000 });
      const status = receipt.status === 'success' ? 'success' : 'reverted';
      logTxResult(rowId, { status, txHash: hash, blockNumber: Number(receipt.blockNumber) });
      if (status !== 'success') throw new Error(`reverted (status=${receipt.status})`);
      return { hash, receipt, used: sessionClient ? 'session' : 'wallet' };
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      const isTimeout = /timed?\s*out|timeout|WaitForTransactionReceiptTimeoutError/i.test(msg);
      logTxResult(rowId, { status: isTimeout ? 'timeout' : 'reverted', txHash: hash, error: `receipt: ${msg}` });
      throw err;
    }
  }
  // Fire-and-forget — we already logged "submitted"; outcome will be visible on Abscan.
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

/**
 * Ask the user to re-grant a fresh AGW session key after the current one
 * exhausted (fee budget hit / TTL expired / revoked). One wallet prompt —
 * the createSession tx. Returns true on success, false if the user
 * cancelled or the AGW client wasn't available. The caller is expected
 * to retry the original write through the new session after this resolves.
 *
 * Deduped: parallel writes that all trip the exhaustion check await a
 * single in-flight renewal instead of all popping separate prompts.
 */
let _renewInFlight = null;
async function _renewSessionInteractive(walletAddr, triggeringLabel, originalErrMsg) {
  if (_renewInFlight) return _renewInFlight;
  _renewInFlight = (async () => {
    try {
      const agwClient = getAgwClient();
      if (!agwClient) {
        console.warn('[session-renew] no AGW client — cannot renew');
        return false;
      }
      const { clearSessionForAddress, grantSession } = await import('./session-key.js');
      // Drop the stale local blob so getSessionClient stops returning a
      // dead client during the renewal window.
      clearSessionForAddress(walletAddr);

      // Best-effort analytics — module is optional in case of refactor.
      try {
        const { Events } = await import('./analytics.js');
        Events.sessionKeyFailed?.(`renew_triggered_by_${triggeringLabel}: ${String(originalErrMsg).slice(0, 80)}`);
      } catch (_) { /* ignore */ }

      console.info('[session-renew] prompting user to renew session-key (triggered by ' + triggeringLabel + ')');
      const r = await grantSession(agwClient);

      try {
        const { Events } = await import('./analytics.js');
        Events.sessionKeyGranted?.(r?.sessionAddress);
      } catch (_) { /* ignore */ }

      return true;
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      // User cancelled the renewal popup — fine, just don't retry.
      if (/reject|denied|cancel/i.test(msg)) {
        console.info('[session-renew] user declined renewal');
      } else {
        console.warn('[session-renew] grantSession threw:', msg);
      }
      return false;
    } finally {
      _renewInFlight = null;
    }
  })();
  return _renewInFlight;
}

// ═══════════════════════════════════════════════════════════════
//  GAMEPLAY WRITES — session-key safe
// ═══════════════════════════════════════════════════════════════

export function startLevel(level) {
  return chainWrite('startLevel', 'startLevel', [Number(level)]);
}

/**
 * Cold-start bootstrap — sequential, NOT atomic.
 *
 * Previously this tried to bundle createSession + claimStarterPack +
 * startLevel into a single AGW batchCall tx. That blew up in production
 * with "Session key policy violation. Status: Unset" because the Privy
 * cross-app signer auto-picks a validator based on what's installed on
 * the smart wallet, and on a wallet that already has a session module
 * (from any prior attempt) it would route the batchCall through the
 * SESSION validator instead of the EOA validator — and the just-being-
 * added session obviously has no policy for PenguCrushV2 yet, so the
 * wallet rejects with the policy violation.
 *
 * There's no public API to tell Privy "use the EOA validator for this
 * one" — agw-client's signPrivyTransaction(client, parameters) hands
 * the whole tx to Privy and Privy decides. So we abandon the in-batch
 * session-creation trick and go back to the proven AGW pattern:
 *
 *   1. grantSession (one Privy popup)  ← uses agwClient.createSession
 *      which AGW explicitly signs with EOA_VALIDATOR_ADDRESS — Privy
 *      respects that because it's a wallet-management call.
 *   2. claimStarterPack — silent through the freshly-granted session
 *   3. startLevel(level) — silent through the freshly-granted session
 *
 * Net cold-start UX: AGW login + SIWE + ONE Privy popup (the grant) =
 * three signatures, then every gameplay tx is silent via the session
 * key. Returning users with a still-valid local session skip the grant
 * and the whole bootstrap is silent.
 */
export async function bootstrapBatch(level) {
  const player = getAGWAddress();
  if (!player) throw new Error('wallet not connected');

  const agwClient = getAgwClient();
  console.info('[bootstrap] start, player=', player, 'agwClient?', !!agwClient);

  let alreadyClaimed = false;
  try {
    alreadyClaimed = !!(await readStarterPackClaimed(player));
  } catch (err) {
    console.warn('[bootstrap] readStarterPackClaimed failed, assuming not claimed:', err?.shortMessage || err?.message || err);
  }
  const sessionLive = hasActiveSession();
  const included = { session: !sessionLive, starter: !alreadyClaimed, start: true };
  console.info('[bootstrap] included=', included);

  let sessionAddress = null;

  // ── 1. Session grant (if needed) — one Privy popup ──
  if (included.session) {
    if (!agwClient) {
      console.warn('[bootstrap] no AGW high-level client — cannot grant session, gameplay will prompt per tx');
    } else {
      try {
        console.info('[bootstrap] requesting session grant — wallet popup incoming');
        const { grantSession } = await import('./session-key.js');
        const r = await grantSession(agwClient);
        sessionAddress = r?.sessionAddress || null;
        console.info('[bootstrap] session granted, sessionAddress=', sessionAddress, 'createTxHash=', r?.txHash);
      } catch (err) {
        const msg = err?.shortMessage || err?.message || String(err);
        console.error('[bootstrap] grantSession failed:', msg);
        // If the user cancelled, propagate so the UI shows it. Otherwise
        // continue — claimStarterPack + startLevel will fall back to
        // per-tx wallet prompts but the player can still play.
        if (/reject|denied|cancel/i.test(msg)) throw err;
      }
    }
  }

  // ── 2. Claim starter pack (if needed) — silent via session ──
  if (included.starter) {
    try {
      console.info('[bootstrap] claiming starter pack — should be silent via session');
      await claimStarterPack();
      console.info('[bootstrap] starter pack claimed');
    } catch (err) {
      const msg = err?.shortMessage || err?.message || String(err);
      // Tolerate "already claimed" — chain is idempotent here even if our
      // pre-check missed it (race between two tabs, etc.).
      if (!/already|StarterPackAlreadyClaimed/i.test(msg)) {
        console.error('[bootstrap] claimStarterPack failed:', msg);
        throw err;
      }
      console.info('[bootstrap] starter pack was already claimed (reverted gracefully)');
    }
  }

  // ── 3. Start the requested level — silent via session ──
  console.info('[bootstrap] starting level', level, '— should be silent via session');
  const r = await startLevel(level);
  console.info('[bootstrap] startLevel landed, hash=', r?.hash, 'used=', r?.used);

  return { hash: r?.hash, used: r?.used, sessionAddress, included };
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

/// V2.6 — fused submit + startLevel(nextLevel) in a single chain tx.
/// Returns from chainWrite (hash + receipt). Falls back to TWO separate
/// calls if the validator is unreachable, since the chain function requires
/// a validator signature.
export async function submitAndStartNext(journal, nextLevel) {
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
  if (!player) throw new Error('not signed in');

  // Ask the validator to bounds-check + sign the journal.
  let signature = null;
  try {
    const url = `${QUOTE_API_BASE}/pengu-validate-level`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ player, journal: j }),
    });
    if (res.ok) {
      const body = await res.json();
      signature = body?.signature || null;
    } else {
      const text = await res.text().catch(() => '');
      console.warn('validator rejected journal:', res.status, text);
    }
  } catch (err) {
    console.warn('validator unreachable:', err?.message || err);
  }
  if (!signature) {
    // Two-tx fallback. Still better than failing outright.
    await chainWrite('submitLevel', 'submitLevel', [j]);
    return chainWrite('startLevel', 'startLevel', [Number(nextLevel)]);
  }
  return chainWrite(
    'submitAndStartNext',
    'submitAndStartNext',
    [j, signature, Number(nextLevel)]
  );
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

/// One-stop helper — checks chain, claims if needed. Idempotent; safe to call
/// repeatedly. Throws are caught and logged so callers can fire-and-forget.
let _starterPackPromise = null;
export function ensureStarterPack() {
  if (_starterPackPromise) return _starterPackPromise;
  const player = getAGWAddress();
  if (!player) return Promise.resolve({ claimed: false, reason: 'no_wallet' });
  _starterPackPromise = (async () => {
    try {
      const already = await readStarterPackClaimed(player);
      if (already) return { claimed: true, reason: 'already' };
      const r = await claimStarterPack();
      return { claimed: true, reason: 'newly_claimed', tx: r?.hash };
    } catch (err) {
      _starterPackPromise = null; // allow retry on next call
      const msg = err?.shortMessage || err?.message || String(err);
      console.warn('ensureStarterPack failed (will retry on next load):', msg);
      return { claimed: false, reason: msg };
    }
  })();
  return _starterPackPromise;
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

