import { createClient } from '@supabase/supabase-js';

// V2 Supabase project (ap-south-1). URL + anon key are bundled into the client
// at build time — they're public by design. Override via VITE_ env if you spin
// up a separate environment.
const ENV = import.meta.env || {};
const SUPABASE_URL = ENV.VITE_SUPABASE_URL || 'https://saftqlwxmdqxzfuwdgtu.supabase.co';
const SUPABASE_ANON_KEY = ENV.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNhZnRxbHd4bWRxeHpmdXdkZ3R1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzkwODI5ODYsImV4cCI6MjA5NDY1ODk4Nn0.4K4TfBVRFcURiEkWJBL3wsl4Bx1c8If3Lag5n_dux_0';
const EDGE_URL = `${SUPABASE_URL}/functions/v1/pengu-save-progress`;

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ═══════════════════════════════════════════════════
//  WALLET — powered by Abstract Global Wallet (AGW)
// ═══════════════════════════════════════════════════
import { connectAGW, disconnectAGW, getAGWAddress, shortAddress, hasInjectedWallet, signInWithAGW, isSignedIn } from './agw.js';

export function getWallet() {
  return getAGWAddress();
}

export async function ensureWallet() {
  const addr = getAGWAddress();
  if (addr) return addr;
  try {
    return await connectAGW();
  } catch (err) {
    console.warn('AGW connect failed:', err.message);
    return null;
  }
}

export { connectAGW, disconnectAGW, shortAddress, hasInjectedWallet, signInWithAGW, isSignedIn };

// ═══════════════════════════════════════════════════
//  READ — fetch player progress from Supabase
// ═══════════════════════════════════════════════════
export async function fetchPlayerProgress(wallet) {
  if (!wallet) return null;
  const w = wallet.toLowerCase();

  // `.maybeSingle()` — anon writes to pengu_players are now revoked (audit
  // fix H2), so a brand-new wallet has zero rows. `.single()` would throw
  // 406 PostgREST "Not Acceptable" in that case. maybeSingle returns null.
  const { data: player } = await supabase
    .from('pengu_players')
    .select('id, total_stars, highest_level, total_score, games_played')
    .eq('wallet_address', w)
    .maybeSingle();

  if (!player) return null;

  // Get progress per level
  const { data: progress } = await supabase
    .from('pengu_progress')
    .select('level, stars, best_score, attempts')
    .eq('player_id', player.id)
    .order('level', { ascending: true });

  // Get booster charges
  const { data: boosters } = await supabase
    .from('pengu_boosters')
    .select('booster_type, charges')
    .eq('player_id', player.id);

  return {
    player,
    progress: progress || [],
    boosters: boosters || [],
  };
}

/// On-chain leaderboard reader. The Supabase mirror table `pengu_leaderboard`
/// is no longer kept in sync (anon writes were revoked in the V2 audit and
/// the signed-write edge function isn't built yet), so the table sat empty
/// and the leaderboard rendered nothing even after real wins. Pivot: read
/// `getPlayerCount` + `getPlayers(0, N)` + `getLeaderboardBatch` directly
/// off the proxy. Chain is the source of truth, no replication delay.
export async function fetchLeaderboard(limit = 20) {
  try {
    const { getPublicClient } = await import('./agw.js');
    const { PENGUCRUSH_ADDRESS } = await import('./onchain.js');
    const abiJson = (await import('../contracts/PenguCrushABI.json')).default;
    const abi = Array.isArray(abiJson) ? abiJson : abiJson.abi || [];
    const client = getPublicClient();
    const count = Number(await client.readContract({
      address: PENGUCRUSH_ADDRESS, abi, functionName: 'getPlayerCount',
    }));
    if (count === 0) return [];
    // Pull up to 4× the display limit to leave headroom for ties / unranked
    // wallets, capped so a giant player set doesn't blow up the RPC round trip.
    const fetchN = Math.min(count, Math.max(limit * 4, 50), 500);
    const addrs = await client.readContract({
      address: PENGUCRUSH_ADDRESS, abi, functionName: 'getPlayers', args: [0n, BigInt(fetchN)],
    });
    if (!addrs || addrs.length === 0) return [];
    const stats = await client.readContract({
      address: PENGUCRUSH_ADDRESS, abi, functionName: 'getLeaderboardBatch', args: [addrs],
    });
    const rows = addrs.map((addr, i) => {
      const s = stats[i] || {};
      return {
        wallet_address: addr.toLowerCase(),
        total_stars:   Number(s.totalStars   ?? s[2] ?? 0),
        total_score:   Number(s.totalScore   ?? s[1] ?? 0),
        highest_level: Number(s.highestLevel ?? s[0] ?? 0),
      };
    }).filter(r => r.total_stars > 0 || r.total_score > 0 || r.highest_level > 0);
    rows.sort((a, b) =>
      (b.total_stars - a.total_stars) ||
      (b.total_score - a.total_score) ||
      (b.highest_level - a.highest_level));
    return rows.slice(0, limit);
  } catch (err) {
    console.warn('Leaderboard chain read failed:', err?.shortMessage || err?.message || err);
    return [];
  }
}

// ═══════════════════════════════════════════════════
//  WRITE — save level result via edge function
// ═══════════════════════════════════════════════════
/**
 * Mirror the on-chain `submitLevel` result into Supabase for fast leaderboard
 * reads. The on-chain tx is the source of truth.
 *
 * NOTE — security hardening 2026-05-18: `rpc_upsert_player_progress` had its
 * EXECUTE grant revoked from anon (audit finding H2: anyone could inflate the
 * leaderboard). This function is now a graceful no-op for anon writes; the
 * leaderboard mirror stays empty until a signed-write edge function lands.
 * Frontend leaderboard reads should pivot to on-chain `getPlayers` +
 * `getLeaderboardBatch` (follow-up).
 */
export async function saveLevelResult({ wallet }) {
  if (!wallet) return null;
  // Skip the direct RPC — it's anon-revoked. Real on-chain write happens via
  // submitLevel() in src/game.js. Returning null is the explicit "no mirror"
  // signal; callers already treat null as benign.
  return null;
}

// ═══════════════════════════════════════════════════
//  HELPERS — build map data from Supabase progress
// ═══════════════════════════════════════════════════
export function buildMapProgress(progressArr) {
  const map = {};
  for (const p of progressArr) {
    map[p.level] = { stars: p.stars, best: p.best_score };
  }
  return map;
}
