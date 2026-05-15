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
    lastCrushPass: null,  // ISO week key, e.g. "2026-W20" (UTC-based ISO week)
    crushPassHistory: [], // [{ week, kind, id, at }]
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
  if (!Array.isArray(s.crushPassHistory)) s.crushPassHistory = [];
  if (s.lastCrushPass === undefined) s.lastCrushPass = null;
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

// ── Weekly Crush Pass (UTC ISO week, one claim per week) ──────

/**
 * Dev: set `true` to ignore the weekly cooldown (claim as many times as you like).
 * Or at runtime: `__pengu.setCrushPassRewardDebug(true)` — see entry.js.
 */
export const DEBUG_CRUSH_PASS_REWARD = true;

function crushPassRewardDebugEnabled() {
  if (DEBUG_CRUSH_PASS_REWARD) return true;
  try {
    return !!(typeof window !== 'undefined' && window.__pengu && window.__pengu.crushPassRewardDebug);
  } catch (_) {
    return false;
  }
}

/** Toggle Crush Pass cooldown bypass (persists only for this page load unless you set window.__pengu.crushPassRewardDebug). */
export function setCrushPassRewardDebug(on) {
  if (typeof window === 'undefined') return;
  window.__pengu ||= {};
  window.__pengu.crushPassRewardDebug = !!on;
}

export function getCrushPassRewardDebug() {
  return crushPassRewardDebugEnabled();
}

/** ISO week key "YYYY-Www" in UTC (ISO 8601 week date). */
function crushPassWeekKeyUTC(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/** Next Monday 00:00:00.000 UTC (unlock boundary after a claimed week). */
function nextMondayMidnightUTC(from = new Date()) {
  const d = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const dow = d.getUTCDay();
  let add = (8 - dow) % 7;
  if (add === 0) add = 7;
  d.setUTCDate(d.getUTCDate() + add);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

const CRUSH_PASS_BOOSTER_ICONS = {
  row: '/assets/boosters-2d/row-clear.png',
  col: '/assets/boosters-2d/col-clear.png',
  colorBomb: '/assets/boosters-2d/color-bomb.png',
  hammer: '/assets/boosters-2d/hammer.png',
  shuffle: '/assets/boosters-2d/shuffle.png',
};

const CRUSH_PASS_BOOSTER_LABELS = {
  row: 'Row clear',
  col: 'Column clear',
  colorBomb: 'Color bomb',
  hammer: 'Hammer',
  shuffle: 'Shuffle',
};

const CRUSH_PASS_SHARD_ICONS = {
  necklace: '/assets/shards/necklace.webp',
  crown: '/assets/shards/crown.webp',
  plooshie: '/assets/shards/plooshie.webp',
};

const CRUSH_PASS_SHARD_LABELS = {
  necklace: 'Necklace shard',
  crown: 'Crown shard',
  plooshie: 'Plooshie shard',
};

/** Weighted table: row 20%, col 20%, colorBomb 15%, hammer 15%, shuffle 10%, necklace 12%, crown 6%, plooshie 2%. */
const CRUSH_PASS_TABLE = [
  { kind: 'booster', id: 'row', w: 20 },
  { kind: 'booster', id: 'col', w: 20 },
  { kind: 'booster', id: 'colorBomb', w: 15 },
  { kind: 'booster', id: 'hammer', w: 15 },
  { kind: 'booster', id: 'shuffle', w: 10 },
  { kind: 'shard', id: 'necklace', w: 12 },
  { kind: 'shard', id: 'crown', w: 6 },
  { kind: 'shard', id: 'plooshie', w: 2 },
];

function rollCrushPassReward() {
  const total = CRUSH_PASS_TABLE.reduce((a, e) => a + e.w, 0);
  let r = Math.random() * total;
  for (const e of CRUSH_PASS_TABLE) {
    r -= e.w;
    if (r <= 0) return e;
  }
  return CRUSH_PASS_TABLE[0];
}

export function canClaimCrushPass() {
  if (crushPassRewardDebugEnabled()) return true;
  const s = getInventory();
  return s.lastCrushPass !== crushPassWeekKeyUTC();
}

export function nextCrushPassAvailableIn() {
  if (crushPassRewardDebugEnabled()) return 0;
  if (canClaimCrushPass()) return 0;
  return Math.max(0, nextMondayMidnightUTC() - Date.now());
}

/**
 * Claim this week's Crush Pass reward. Returns { kind, id, icon, label } or null if already claimed.
 */
export function claimCrushPass() {
  if (!canClaimCrushPass()) return null;
  const week = crushPassWeekKeyUTC();
  const pick = rollCrushPassReward();
  const kind = pick.kind;
  const id = pick.id;

  if (kind === 'booster') {
    addBooster(id, 1);
  } else {
    addShard(id, 1);
  }

  const s = getInventory();
  s.lastCrushPass = week;
  s.crushPassHistory.push({ week, kind, id, at: new Date().toISOString() });
  if (s.crushPassHistory.length > 52) s.crushPassHistory = s.crushPassHistory.slice(-52);
  saveInventory(s);
  dispatchInventoryChange();

  const icon =
    kind === 'booster'
      ? CRUSH_PASS_BOOSTER_ICONS[id]
      : CRUSH_PASS_SHARD_ICONS[id];
  const label =
    kind === 'booster'
      ? CRUSH_PASS_BOOSTER_LABELS[id] || id
      : CRUSH_PASS_SHARD_LABELS[id] || id;

  return { kind, id, icon, label };
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
