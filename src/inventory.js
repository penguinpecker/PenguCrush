// ═══════════════════════════════════════════════════════════════
//  INVENTORY — wallet-scoped player state
//
//  Single source of truth for boosters, currencies, and the daily-
//  wheel cooldown. Persists to localStorage synchronously (instant,
//  survives reloads) and syncs to Supabase best-effort in the
//  background.
//
//  All keys are scoped by lowercase wallet address, so connecting a
//  different wallet shows that wallet's inventory, not the previous
//  one's. Before a wallet is connected we fall back to the 'guest'
//  key so new players can still play.
// ═══════════════════════════════════════════════════════════════

import { getAGWAddress } from './agw.js';
import { supabase } from './supabase.js';
import { logBoosterUseOnchain, logBoosterPurchaseOnchain, logDailySpinOnchain } from './onchain.js';

const LS_KEY = 'pengucrush_inventory_v1';

const DEFAULT_BOOSTERS = { row: 1, col: 1, colorBomb: 1, hammer: 1, shuffle: 1 };
const DEFAULT_CURRENCIES = { coins: 0, gems: 0, xp: 0 };
const DEFAULT_SHARDS = { necklace: 0, crown: 0, plooshie: 0 };

function emptyState() {
  return {
    boosters: { ...DEFAULT_BOOSTERS },
    currencies: { ...DEFAULT_CURRENCIES },
    shards: { ...DEFAULT_SHARDS },
    lastDailySpin: null,  // ISO date string 'YYYY-MM-DD' (UTC)
    dailySpinHistory: [], // [{ date, reward, at }]
  };
}

function walletKey() {
  const addr = getAGWAddress();
  return addr ? addr.toLowerCase() : 'guest';
}

function readAll() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {};
  } catch (_) { return {}; }
}

function writeAll(all) {
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

export function getInventory() {
  const all = readAll();
  const key = walletKey();
  if (!all[key]) {
    all[key] = emptyState();
    writeAll(all);
  }
  // Fill any missing fields (schema drift)
  const s = all[key];
  s.boosters = { ...DEFAULT_BOOSTERS, ...(s.boosters || {}) };
  s.currencies = { ...DEFAULT_CURRENCIES, ...(s.currencies || {}) };
  s.shards = { ...DEFAULT_SHARDS, ...(s.shards || {}) };
  if (!Array.isArray(s.dailySpinHistory)) s.dailySpinHistory = [];
  return s;
}

function saveInventory(state) {
  const all = readAll();
  all[walletKey()] = state;
  writeAll(all);
  // Fire-and-forget cloud sync
  queueCloudSync(state);
}

// ── Booster helpers ────────────────────────────────────────────

export function getBoosterCount(type) {
  return getInventory().boosters[type] || 0;
}

export function getAllBoosters() {
  return { ...getInventory().boosters };
}

export function addBooster(type, qty = 1) {
  const s = getInventory();
  s.boosters[type] = (s.boosters[type] || 0) + qty;
  saveInventory(s);
  dispatchInventoryChange();
  // Fire-and-forget onchain activity event
  logBoosterPurchaseOnchain(type, qty);
  return s.boosters[type];
}

export function consumeBooster(type) {
  const s = getInventory();
  const cur = s.boosters[type] || 0;
  if (cur <= 0) return 0;
  s.boosters[type] = cur - 1;
  saveInventory(s);
  dispatchInventoryChange();
  logBoosterUseOnchain(type);
  return s.boosters[type];
}

// ── Shards ───────────────────────────────────────────────────

export function getShards() {
  return { ...getInventory().shards };
}

export function getShardCount(id) {
  return getInventory().shards[id] || 0;
}

export function addShard(id, qty = 1) {
  const s = getInventory();
  if (!s.shards[id] && s.shards[id] !== 0) s.shards[id] = 0;
  s.shards[id] = (s.shards[id] || 0) + qty;
  saveInventory(s);
  dispatchInventoryChange();
  return s.shards[id];
}

// ── Currencies ────────────────────────────────────────────────

export function addCurrency(name, amount) {
  const s = getInventory();
  s.currencies[name] = (s.currencies[name] || 0) + amount;
  saveInventory(s);
  dispatchInventoryChange();
  return s.currencies[name];
}

export function getCurrencies() {
  return { ...getInventory().currencies };
}

// ── Daily wheel ───────────────────────────────────────────────

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

export function canSpinDaily() {
  const s = getInventory();
  return s.lastDailySpin !== todayUTC();
}

export function nextSpinAvailableIn() {
  if (canSpinDaily()) return 0;
  // Milliseconds until next UTC midnight
  const now = Date.now();
  const next = Date.UTC(
    new Date().getUTCFullYear(),
    new Date().getUTCMonth(),
    new Date().getUTCDate() + 1
  );
  return Math.max(0, next - now);
}

/** Apply a reward string (e.g. "5 Gems", "100 XP", "Ice Boost"). Returns the parsed effect. */
export function applyDailyReward(rewardText) {
  const s = getInventory();
  const effect = { type: 'none', amount: 0 };
  const m = /^(\d+)\s+(Gems|Coins|XP)$/i.exec(rewardText);
  if (m) {
    const qty = parseInt(m[1], 10);
    const kind = m[2].toLowerCase();
    if (kind === 'gems') { s.currencies.gems += qty; effect.type = 'gems'; }
    else if (kind === 'coins') { s.currencies.coins += qty; effect.type = 'coins'; }
    else if (kind === 'xp') { s.currencies.xp += qty; effect.type = 'xp'; }
    effect.amount = qty;
  } else if (/ice boost/i.test(rewardText)) {
    // Ice Boost → grant a random booster
    const pool = ['row', 'col', 'colorBomb', 'hammer', 'shuffle'];
    const pick = pool[Math.floor(Math.random() * pool.length)];
    s.boosters[pick] = (s.boosters[pick] || 0) + 1;
    effect.type = 'booster'; effect.booster = pick; effect.amount = 1;
  } else if (/try again/i.test(rewardText)) {
    effect.type = 'none';
  }
  s.lastDailySpin = todayUTC();
  s.dailySpinHistory.push({ date: todayUTC(), reward: rewardText, at: new Date().toISOString() });
  // Keep history bounded
  if (s.dailySpinHistory.length > 60) s.dailySpinHistory = s.dailySpinHistory.slice(-60);
  saveInventory(s);
  dispatchInventoryChange();
  logDailySpinOnchain(rewardText);
  return effect;
}

// ── Cloud sync (best-effort) ──────────────────────────────────

let syncTimer = null;
function queueCloudSync(state) {
  const addr = getAGWAddress();
  if (!addr) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => syncToCloud(addr, state), 500);
}

async function syncToCloud(wallet, state) {
  try {
    const w = wallet.toLowerCase();
    // Resolve player row (upsert so a new wallet gets a record)
    const { data: player } = await supabase
      .from('pengu_players')
      .upsert({ wallet_address: w }, { onConflict: 'wallet_address' })
      .select('id')
      .single();
    if (!player?.id) return;
    // Upsert each booster charge
    const rows = Object.entries(state.boosters).map(([booster_type, charges]) => ({
      player_id: player.id,
      booster_type,
      charges,
    }));
    await supabase
      .from('pengu_boosters')
      .upsert(rows, { onConflict: 'player_id,booster_type' });
  } catch (err) {
    console.warn('inventory cloud sync failed (non-fatal):', err?.message || err);
  }
}

/** Pull latest inventory from Supabase and merge (cloud wins when greater). */
export async function hydrateFromCloud() {
  const addr = getAGWAddress();
  if (!addr) return;
  const w = addr.toLowerCase();
  try {
    const { data: player } = await supabase
      .from('pengu_players')
      .select('id')
      .eq('wallet_address', w)
      .maybeSingle();
    if (!player?.id) return;
    const { data: cloudBoosters } = await supabase
      .from('pengu_boosters')
      .select('booster_type, charges')
      .eq('player_id', player.id);
    if (!cloudBoosters?.length) return;
    const s = getInventory();
    let changed = false;
    for (const { booster_type, charges } of cloudBoosters) {
      if ((charges || 0) > (s.boosters[booster_type] || 0)) {
        s.boosters[booster_type] = charges;
        changed = true;
      }
    }
    if (changed) {
      saveInventory(s);
      dispatchInventoryChange();
    }
  } catch (err) {
    console.warn('inventory cloud hydrate failed (non-fatal):', err?.message || err);
  }
}

// ── Change notifications ─────────────────────────────────────

function dispatchInventoryChange() {
  try { window.dispatchEvent(new CustomEvent('pengu:inventory')); } catch (_) {}
}

export function onInventoryChange(handler) {
  window.addEventListener('pengu:inventory', handler);
  return () => window.removeEventListener('pengu:inventory', handler);
}
