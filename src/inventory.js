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
    lastCrushPass: null, // ISO week key, e.g. "2026-W20" (UTC-based ISO week)
    crushPassHistory: [], // [{ week, at, boostersEach, shardBonus? }]
    lives: 5, // regular hearts 0–5
    lastLifeRegenAt: null, // ISO — anchor for 8h regen; null when lives are full
    frozenLives: 0, // weekly-pass bonus 0–2
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
  if (s.lives === undefined || s.lives === null) s.lives = 5;
  if (s.frozenLives === undefined || s.frozenLives === null) s.frozenLives = 0;
  if (s.lastLifeRegenAt === undefined) s.lastLifeRegenAt = null;
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

// ── Daily lives (8h regen per heart, max 5 + up to 2 frozen from weekly pass) ──

const LIVES_MAX = 5;
const FROZEN_LIVES_MAX = 2;
const LIFE_REGEN_MS = 8 * 60 * 60 * 1000;

/**
 * Apply regen ticks to `s` in memory. Returns whether `s` was mutated.
 * @param {ReturnType<typeof emptyState>} s
 */
function applyLifeRegenToState(s) {
  s.lives = Math.max(0, Math.min(LIVES_MAX, Number(s.lives) || 0));
  s.frozenLives = Math.max(0, Math.min(FROZEN_LIVES_MAX, Number(s.frozenLives) || 0));
  let changed = false;

  if (s.lives >= LIVES_MAX) {
    if (s.lives !== LIVES_MAX) {
      s.lives = LIVES_MAX;
      changed = true;
    }
    if (s.lastLifeRegenAt != null) {
      s.lastLifeRegenAt = null;
      changed = true;
    }
    return changed;
  }

  if (s.lastLifeRegenAt == null) {
    s.lastLifeRegenAt = new Date().toISOString();
    return true;
  }

  const anchor = Date.parse(s.lastLifeRegenAt);
  const elapsed = Date.now() - anchor;
  if (elapsed < LIFE_REGEN_MS) return changed;
  const gained = Math.min(LIVES_MAX - s.lives, Math.floor(elapsed / LIFE_REGEN_MS));
  if (gained <= 0) return changed;

  s.lives += gained;
  changed = true;
  const newAnchor = anchor + gained * LIFE_REGEN_MS;
  if (s.lives >= LIVES_MAX) {
    s.lives = LIVES_MAX;
    s.lastLifeRegenAt = null;
  } else {
    s.lastLifeRegenAt = new Date(newAnchor).toISOString();
  }
  return changed;
}

export function getMaxLives() {
  return LIVES_MAX;
}

/** Snapshot after applying regen. Persists if regen added lives. */
export function getLives() {
  const s = getInventory();
  const changed = applyLifeRegenToState(s);
  if (changed) {
    saveInventory(s);
    dispatchInventoryChange();
  }
  return {
    lives: s.lives,
    frozenLives: s.frozenLives,
    total: s.lives + s.frozenLives,
  };
}

/** Ms until the next regular life from regen; 0 if full or regen is due now (call getLives to apply). */
export function nextLifeRegenIn() {
  getLives();
  const s = getInventory();
  if (s.lives >= LIVES_MAX) return 0;
  if (!s.lastLifeRegenAt) return LIFE_REGEN_MS;
  const elapsed = Date.now() - Date.parse(s.lastLifeRegenAt);
  if (elapsed >= LIFE_REGEN_MS) return 0;
  return Math.max(0, LIFE_REGEN_MS - elapsed);
}

/**
 * Spend one life (regular first, then frozen). Returns false if none left.
 */
export function consumeLife() {
  getLives();
  const s = getInventory();
  const total = s.lives + s.frozenLives;
  if (total <= 0) return false;
  if (s.lives > 0) {
    s.lives -= 1;
  } else {
    s.frozenLives -= 1;
  }
  if (s.lives < LIVES_MAX && !s.lastLifeRegenAt) {
    s.lastLifeRegenAt = new Date().toISOString();
  }
  saveInventory(s);
  dispatchInventoryChange();
  return true;
}

/** Shop / IAP: add regular lives up to max. */
export function addLives(n = 1) {
  if (n <= 0) return getLives();
  getLives();
  const s = getInventory();
  s.lives = Math.min(LIVES_MAX, s.lives + n);
  if (s.lives >= LIVES_MAX) s.lastLifeRegenAt = null;
  saveInventory(s);
  dispatchInventoryChange();
  return getLives();
}

/** Weekly pass: add frozen capacity hearts (capped at 2). */
export function grantFrozenLives(n = 2) {
  if (n <= 0) return getLives();
  const s = getInventory();
  s.frozenLives = Math.min(FROZEN_LIVES_MAX, (s.frozenLives || 0) + n);
  saveInventory(s);
  dispatchInventoryChange();
  return getLives();
}

// ── Weekly Crush Pass (UTC ISO week, one claim per week) ──────

/**
 * Dev: set `true` to ignore the weekly cooldown (claim as many times as you like).
 * Or at runtime: `__pengu.setCrushPassRewardDebug(true)` — see entry.js.
 */
export const DEBUG_CRUSH_PASS_REWARD = false;

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

/** Guaranteed boosters per type each week. */
const CRUSH_PASS_BOOSTERS_EACH = 3;

const CRUSH_PASS_BOOSTER_IDS = ['row', 'col', 'colorBomb', 'hammer', 'shuffle'];

/** ~15% chance to also win one random shard (lucky bonus). */
const CRUSH_PASS_SHARD_BONUS_CHANCE = 0.15;

/** If the shard bonus hits, which shard (necklace most common, plooshie rarest). */
const CRUSH_PASS_SHARD_BONUS_WEIGHTS = [
  { id: 'necklace', w: 55 },
  { id: 'crown', w: 30 },
  { id: 'plooshie', w: 15 },
];

function rollCrushPassShardBonusId() {
  const total = CRUSH_PASS_SHARD_BONUS_WEIGHTS.reduce((a, e) => a + e.w, 0);
  let r = Math.random() * total;
  for (const e of CRUSH_PASS_SHARD_BONUS_WEIGHTS) {
    r -= e.w;
    if (r <= 0) return e.id;
  }
  return CRUSH_PASS_SHARD_BONUS_WEIGHTS[0].id;
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
 * Claim this week's Crush Pass: 3 of each booster, plus a random shard ~15% of the time.
 * Returns { kind, id, label, boosters, shardBonus? } for the celebration UI.
 */
export function claimCrushPass() {
  if (!canClaimCrushPass()) return null;
  const week = crushPassWeekKeyUTC();
  const s = getInventory();

  for (const id of CRUSH_PASS_BOOSTER_IDS) {
    s.boosters[id] = (s.boosters[id] || 0) + CRUSH_PASS_BOOSTERS_EACH;
    logBoosterPurchaseOnchain(id, CRUSH_PASS_BOOSTERS_EACH);
  }

  let shardBonus = null;
  if (Math.random() < CRUSH_PASS_SHARD_BONUS_CHANCE) {
    const sid = rollCrushPassShardBonusId();
    s.shards[sid] = (s.shards[sid] || 0) + 1;
    shardBonus = {
      kind: 'shard',
      id: sid,
      icon: CRUSH_PASS_SHARD_ICONS[sid],
      label: CRUSH_PASS_SHARD_LABELS[sid] || sid,
    };
  }

  s.lastCrushPass = week;
  s.crushPassHistory.push({
    week,
    at: new Date().toISOString(),
    boostersEach: CRUSH_PASS_BOOSTERS_EACH,
    shardBonus: shardBonus ? { kind: 'shard', id: shardBonus.id } : null,
  });
  if (s.crushPassHistory.length > 52) s.crushPassHistory = s.crushPassHistory.slice(-52);

  s.frozenLives = Math.min(FROZEN_LIVES_MAX, (s.frozenLives || 0) + 2);

  saveInventory(s);
  dispatchInventoryChange();

  const boosters = CRUSH_PASS_BOOSTER_IDS.map(id => ({
    id,
    count: CRUSH_PASS_BOOSTERS_EACH,
    icon: CRUSH_PASS_BOOSTER_ICONS[id],
    label: CRUSH_PASS_BOOSTER_LABELS[id] || id,
  }));

  const bundleLabel = `${CRUSH_PASS_BOOSTERS_EACH} of each booster`;
  if (shardBonus) {
    return {
      kind: 'weekly_pass',
      id: 'bundle_plus_shard',
      label: `Lucky! ${shardBonus.label} — ${bundleLabel}`,
      boosters,
      shardBonus,
    };
  }
  return {
    kind: 'weekly_pass',
    id: 'bundle',
    label: bundleLabel,
    boosters,
  };
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
