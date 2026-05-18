// ═══════════════════════════════════════════════════════════════
//  ANALYTICS — thin wrapper around gtag('event', ...)
//
//  Base gtag loader lives in index.html (so it loads before the
//  module bundle and catches pageviews even if the bundle is slow).
//  This module fires CUSTOM EVENTS for every meaningful in-app
//  action. Safe to call even if gtag isn't loaded (ad-blocker etc.)
//  — it no-ops silently.
// ═══════════════════════════════════════════════════════════════

const GA_ID = (import.meta.env && import.meta.env.VITE_GA_ID) || 'G-R5T4Y4B629';

function hasGtag() {
  return typeof window !== 'undefined' && typeof window.gtag === 'function';
}

/** Attach the connected wallet as the GA user_id (cohort analysis).
 *  Pseudonymous but linkable — fine for game analytics. */
export function setAnalyticsUser(walletAddress) {
  if (!hasGtag()) return;
  try {
    window.gtag('config', GA_ID, {
      user_id: walletAddress ? walletAddress.toLowerCase() : undefined,
    });
    // Also set as a user_property so it shows up in user-scoped GA reports
    window.gtag('set', 'user_properties', {
      wallet: walletAddress ? walletAddress.toLowerCase() : null,
    });
  } catch (_) { /* swallow */ }
}

/** Fire a custom event. `name` snake_case, `params` flat key→primitive. */
export function track(name, params = {}) {
  if (!hasGtag()) return;
  try {
    window.gtag('event', name, params);
  } catch (_) { /* swallow */ }
}

// ─── Convenience helpers for common shapes ─────────────────────

export const Events = {
  // Auth / session
  homeView:                ()           => track('home_view'),
  playClicked:             ()           => track('play_clicked'),
  agwConnectStart:         ()           => track('agw_connect_start'),
  agwConnectSuccess:       (addr)       => track('agw_connect_success', { wallet: (addr||'').toLowerCase() }),
  agwConnectFail:          (reason)     => track('agw_connect_fail',    { reason }),
  siweSignSuccess:         (addr)       => track('siwe_sign_success',   { wallet: (addr||'').toLowerCase() }),
  siweSignFail:            (reason)     => track('siwe_sign_fail',      { reason }),
  sessionKeyGranted:       (sessionAddr)=> track('session_key_granted', { session_wallet: (sessionAddr||'').toLowerCase() }),
  sessionKeyFailed:        (reason)     => track('session_key_failed',  { reason }),
  walletDisconnected:      ()           => track('wallet_disconnected'),

  // Navigation
  mapView:                 ()           => track('map_view'),
  shopOpen:                ()           => track('shop_open'),
  leaderboardOpen:         ()           => track('leaderboard_open'),
  inventoryOpen:           ()           => track('inventory_open'),

  // Level lifecycle
  levelPopupOpen:          (level)      => track('level_popup_open', { level }),
  levelStart:              (level)      => track('level_start',      { level }),
  levelLeave:              (level, movesUsed) => track('level_leave', { level, moves_used: movesUsed }),
  levelWin:                (level, score, stars, movesUsed, durationMs) =>
    track('level_win', { level, score, stars, moves_used: movesUsed, duration_ms: durationMs }),
  levelFail:               (level, score, movesUsed, durationMs) =>
    track('level_fail', { level, score, moves_used: movesUsed, duration_ms: durationMs }),

  // Gameplay micro-events
  boosterUsed:             (type, level)=> track('booster_used',  { booster_type: type, level }),
  shardEarned:             (id, level)  => track('shard_earned',  { shard: id, level }),
  bigCombo:                (length, level) => track('big_combo',  { combo_length: length, level }),
  fallerPenalty:           (level)      => track('faller_penalty', { level }),

  // Shop
  shopBuyStart:            (item, qty, currency) => track('shop_buy_start',   { item, qty, currency }),
  shopBuySuccess:          (item, qty, currency, txHash) => track('shop_buy_success', { item, qty, currency, tx_hash: txHash }),
  shopBuyFail:             (item, qty, currency, reason) => track('shop_buy_fail',    { item, qty, currency, reason }),

  // Lives
  lifeConsumed:            (regularAfter, frozenAfter) => track('life_consumed', { regular_after: regularAfter, frozen_after: frozenAfter }),
  lifeRegenReceived:       (ticks, regularAfter)       => track('life_regen_received', { ticks, regular_after: regularAfter }),

  // Crush Pass
  passOpen:                ()           => track('pass_open'),
  passBuyStart:            ()           => track('pass_buy_start'),
  passBuySuccess:          (txHash)     => track('pass_buy_success', { tx_hash: txHash }),
  passBuyFail:             (reason)     => track('pass_buy_fail',    { reason }),
  passCancelled:           ()           => track('pass_cancelled'),
  passShardBonus:          (shard)      => track('pass_shard_bonus', { shard }),

  // Daily wheel
  wheelOpen:               ()           => track('wheel_open'),
  wheelSpinStart:          ()           => track('wheel_spin_start'),
  wheelSpinComplete:       (reward)     => track('wheel_spin_complete', { reward }),
  wheelSpinFail:           (reason)     => track('wheel_spin_fail',    { reason }),

  // Leaderboard
  leaderboardLoadSuccess:  (count)      => track('leaderboard_load_success', { player_count: count }),
  leaderboardLoadFail:     (reason)     => track('leaderboard_load_fail',    { reason }),
};
