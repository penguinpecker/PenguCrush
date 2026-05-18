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
import {
  logBoosterUseOnchain, logBoosterPurchaseOnchain, logDailySpinOnchain,
  readInventory, readLives, readCrushPass, sku as nameToSku,
  buyCrushPassETH,
} from './onchain.js';

const LS_KEY = 'pengucrush_inventory_v1';

const DEFAULT_BOOSTERS = { row: 1, col: 1, colorBomb: 1, hammer: 1, shuffle: 1 };
const DEFAULT_CURRENCIES = { coins: 0, gems: 0, xp: 0 };
const DEFAULT_SHARDS = { necklace: 0, crown: 0, plooshie: 0 };

/** Regular (pink) life cap. Ice hearts add on top (see `FROZEN_LIVES_MAX`). */
const LIVES_MAX = 3;
const FROZEN_LIVES_MAX = 2;
const LIFE_REGEN_MS = 8 * 60 * 60 * 1000;

/**
 * If pass window ended, deactivate perks and clear bonus ice hearts.
 * @returns {boolean} Whether state was mutated (caller may persist wallet blob).
 */
function syncCrushPassExpiryIfNeeded(s) {
  if (!s.crushPassExpiresAt) return false;
  const exp = Date.parse(s.crushPassExpiresAt);
  if (!Number.isFinite(exp) || Date.now() < exp) return false;
  let changed = false;
  if (s.crushPassActive) {
    s.crushPassActive = false;
    changed = true;
  }
  s.crushPassExpiresAt = null;
  if ((s.frozenLives || 0) > 0) {
    s.frozenLives = 0;
    changed = true;
  }
  if (s.lives > LIVES_MAX) {
    s.lives = LIVES_MAX;
    changed = true;
  }
  return changed;
}

function emptyState() {
  return {
    boosters: { ...DEFAULT_BOOSTERS },
    currencies: { ...DEFAULT_CURRENCIES },
    shards: { ...DEFAULT_SHARDS },
    lastDailySpin: null,  // ISO date string 'YYYY-MM-DD' (UTC)
    dailySpinHistory: [], // [{ date, reward, at }]
    crushPassHistory: [], // purchase / renewal audit — [{ week, at, boostersEach, shardBonus? }]
    crushPassActive: false,
    crushPassExpiresAt: null, // ISO — end of pass window
    crushPassPurchasedAt: null,
    crushPassStreakWeeks: 0,
    crushPassStreakHistory: [], // [{ week, purchasedAt }] last 52
    crushPassLastPurchaseWeek: null, // ISO week key for streak math
    lives: LIVES_MAX, // regular hearts; pass grants +2 ice; HUD shows LIVES_MAX + FROZEN_LIVES_MAX slots
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
  if (s.crushPassActive === undefined) s.crushPassActive = false;
  if (s.crushPassExpiresAt === undefined) s.crushPassExpiresAt = null;
  if (s.crushPassPurchasedAt === undefined) s.crushPassPurchasedAt = null;
  if (s.crushPassStreakWeeks === undefined || s.crushPassStreakWeeks === null) s.crushPassStreakWeeks = 0;
  if (!Array.isArray(s.crushPassStreakHistory)) s.crushPassStreakHistory = [];
  if (s.crushPassLastPurchaseWeek === undefined) s.crushPassLastPurchaseWeek = null;
  let schemaDirty = false;
  if (s.lastCrushPass !== undefined) {
    delete s.lastCrushPass;
    schemaDirty = true;
  }
  if (s.lives === undefined || s.lives === null) s.lives = LIVES_MAX;
  else s.lives = Math.min(Number(s.lives) || 0, LIVES_MAX);
  if (s.frozenLives === undefined || s.frozenLives === null) s.frozenLives = 0;
  if (s.lastLifeRegenAt === undefined) s.lastLifeRegenAt = null;
  const passDirty = syncCrushPassExpiryIfNeeded(s);
  if (passDirty || schemaDirty) {
    writeAll(all);
    dispatchInventoryChange();
  }
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

export function hasCrushPass() {
  const s = getInventory();
  if (!s.crushPassActive || !s.crushPassExpiresAt) return false;
  const exp = Date.parse(s.crushPassExpiresAt);
  return Number.isFinite(exp) && Date.now() < exp;
}

export function crushPassExpiresIn() {
  const s = getInventory();
  if (!hasCrushPass()) return 0;
  return Math.max(0, Date.parse(s.crushPassExpiresAt) - Date.now());
}

export function getScoreMultiplier() {
  return hasCrushPass() ? 2 : 1;
}

export function getDailyWheelMultiplier() {
  return hasCrushPass() ? 2 : 1;
}

/** Apply a reward string (e.g. "5 Gems", "100 XP", "Ice Boost"). Returns the parsed effect. */
export function applyDailyReward(rewardText) {
  const s = getInventory();
  const mult = getDailyWheelMultiplier();
  const effect = { type: 'none', amount: 0, wheelMultiplier: mult };
  const m = /^(\d+)\s+(Gems|Coins|XP)$/i.exec(rewardText);
  if (m) {
    const qty = parseInt(m[1], 10) * mult;
    const kind = m[2].toLowerCase();
    if (kind === 'gems') { s.currencies.gems += qty; effect.type = 'gems'; }
    else if (kind === 'coins') { s.currencies.coins += qty; effect.type = 'coins'; }
    else if (kind === 'xp') { s.currencies.xp += qty; effect.type = 'xp'; }
    effect.amount = qty;
  } else if (/ice boost/i.test(rewardText)) {
    const pool = ['row', 'col', 'colorBomb', 'hammer', 'shuffle'];
    effect.type = 'booster';
    effect.boosterGrants = [];
    for (let i = 0; i < mult; i++) {
      const pick = pool[Math.floor(Math.random() * pool.length)];
      s.boosters[pick] = (s.boosters[pick] || 0) + 1;
      effect.boosterGrants.push(pick);
    }
    effect.amount = mult;
    effect.booster = effect.boosterGrants[0];
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

// ── Daily lives (8h regen per heart, max 3 regular + up to 2 frozen from Crush Pass) ──

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

/** Heart slots rendered in the map HUD (regular cap + max ice). */
export function getLivesHudSlotCount() {
  return LIVES_MAX + FROZEN_LIVES_MAX;
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

// ── Weekly Crush Pass (purchasable weekly subscription, mock checkout) ─────

/** ISO week key "YYYY-Www" in UTC (ISO 8601 week date). */
function crushPassWeekKeyUTC(now = new Date()) {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

const CRUSH_PASS_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Stops renewal display / clears perks immediately (mock cancel). */
export function cancelCrushPass() {
  const s = getInventory();
  s.crushPassActive = false;
  s.crushPassExpiresAt = null;
  s.frozenLives = 0;
  if (s.lives > LIVES_MAX) s.lives = LIVES_MAX;
  saveInventory(s);
  dispatchInventoryChange();
}

/**
 * Mock purchase: activates ~7d window (extends from current expiry if already active),
 * grants boosters, optional shard, +2 ice hearts. Returns celebration payload or null.
 */
export function purchaseCrushPass() {
  const week = crushPassWeekKeyUTC();
  const s = getInventory();
  const now = Date.now();
  let baseExpiry = now;
  if (s.crushPassActive && s.crushPassExpiresAt) {
    const cur = Date.parse(s.crushPassExpiresAt);
    if (Number.isFinite(cur) && cur > baseExpiry) baseExpiry = cur;
  }

  s.crushPassActive = true;
  s.crushPassPurchasedAt = new Date().toISOString();
  s.crushPassExpiresAt = new Date(baseExpiry + CRUSH_PASS_EXPIRY_MS).toISOString();

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

  const prevWeekKey = crushPassWeekKeyUTC(new Date(now - 7 * 86400000));
  const lastPw = s.crushPassLastPurchaseWeek;
  if (lastPw === week) {
    // stacked renewal in the same ISO week — keep streak
  } else if (lastPw === prevWeekKey) {
    s.crushPassStreakWeeks = (s.crushPassStreakWeeks || 0) + 1;
  } else {
    s.crushPassStreakWeeks = 1;
  }
  s.crushPassLastPurchaseWeek = week;
  s.crushPassStreakHistory.push({ week, purchasedAt: s.crushPassPurchasedAt });
  if (s.crushPassStreakHistory.length > 52) s.crushPassStreakHistory = s.crushPassStreakHistory.slice(-52);

  s.crushPassHistory.push({
    week,
    at: s.crushPassPurchasedAt,
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
      streakWeeks: s.crushPassStreakWeeks,
    };
  }
  return {
    kind: 'weekly_pass',
    id: 'bundle',
    label: bundleLabel,
    boosters,
    streakWeeks: s.crushPassStreakWeeks,
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

// ── Chain sync — chain is the authoritative source of truth ───
// On every wallet-connect / app-resume, pull the player's on-chain
// state and overwrite the localStorage cache. localStorage stays in
// place as an instant-render cache; on conflict the chain wins.

const BOOSTER_NAME_BY_SKU = {
  [nameToSku('booster.row')]:       'row',
  [nameToSku('booster.col')]:       'col',
  [nameToSku('booster.colorBomb')]: 'colorBomb',
  [nameToSku('booster.hammer')]:    'hammer',
  [nameToSku('booster.shuffle')]:   'shuffle',
};
const SHARD_NAME_BY_SKU = {
  [nameToSku('shard.necklace')]: 'necklace',
  [nameToSku('shard.crown')]:    'crown',
  [nameToSku('shard.plooshie')]: 'plooshie',
};
const CURRENCY_NAME_BY_SKU = {
  [nameToSku('currency.coins')]: 'coins',
  [nameToSku('currency.gems')]:  'gems',
  [nameToSku('currency.xp')]:    'xp',
};

export async function hydrateFromChain() {
  const addr = getAGWAddress();
  if (!addr) return;
  try {
    const [inv, lives, pass] = await Promise.all([
      readInventory(addr).catch(() => null),
      readLives(addr).catch(() => null),
      readCrushPass(addr).catch(() => null),
    ]);
    if (!inv && !lives && !pass) return;
    const s = getInventory();
    let changed = false;
    if (inv) {
      const newB = { ...DEFAULT_BOOSTERS };
      for (const [sku, qty] of Object.entries(inv.boosters || {})) {
        const name = BOOSTER_NAME_BY_SKU[sku];
        if (name) newB[name] = qty;
      }
      // Replace, not merge — chain is truth
      if (JSON.stringify(newB) !== JSON.stringify(s.boosters)) {
        s.boosters = newB; changed = true;
      }
      const newSh = { ...DEFAULT_SHARDS };
      for (const [sku, qty] of Object.entries(inv.shards || {})) {
        const name = SHARD_NAME_BY_SKU[sku];
        if (name) newSh[name] = qty;
      }
      if (JSON.stringify(newSh) !== JSON.stringify(s.shards)) {
        s.shards = newSh; changed = true;
      }
      const newCur = { ...DEFAULT_CURRENCIES };
      for (const [sku, qty] of Object.entries(inv.currencies || {})) {
        const name = CURRENCY_NAME_BY_SKU[sku];
        if (name) newCur[name] = qty;
      }
      if (JSON.stringify(newCur) !== JSON.stringify(s.currencies)) {
        s.currencies = newCur; changed = true;
      }
    }
    if (lives) {
      if (s.lives !== lives.regular || s.frozenLives !== lives.frozen) {
        s.lives = lives.regular;
        s.frozenLives = lives.frozen;
        // Reset regen anchor — chain is truth
        if (lives.regular >= LIVES_MAX) s.lastLifeRegenAt = null;
        else if (lives.secondsToNext > 0) {
          s.lastLifeRegenAt = new Date(Date.now() - (LIFE_REGEN_MS - lives.secondsToNext * 1000)).toISOString();
        }
        changed = true;
      }
    }
    if (pass) {
      const newActive = !!pass.active;
      const newExpStr = pass.active ? new Date(pass.expiresAt).toISOString() : null;
      if (s.crushPassActive !== newActive || s.crushPassExpiresAt !== newExpStr) {
        s.crushPassActive = newActive;
        s.crushPassExpiresAt = newExpStr;
        changed = true;
      }
      if ((s.crushPassStreakWeeks || 0) !== pass.streakWeeks) {
        s.crushPassStreakWeeks = pass.streakWeeks;
        changed = true;
      }
    }
    if (changed) {
      saveInventory(s);
      dispatchInventoryChange();
    }
  } catch (err) {
    console.warn('inventory chain hydrate failed (non-fatal):', err?.message || err);
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
