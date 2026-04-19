import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://dqvwpbggjlcumcmlliuj.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRxdndwYmdnamxjdW1jbWxsaXVqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA2MzA2NjIsImV4cCI6MjA4NjIwNjY2Mn0.yrkg3mv62F-DiGA8-cajSSkwnhKBXRbVlr4ye6bdfTc';
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

  // Get player
  const { data: player } = await supabase
    .from('pengu_players')
    .select('id, total_stars, highest_level, total_score, games_played')
    .eq('wallet_address', w)
    .single();

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

export async function fetchLeaderboard(limit = 20) {
  const { data } = await supabase
    .from('pengu_leaderboard')
    .select('wallet_address, total_stars, total_score, highest_level')
    .order('total_stars', { ascending: false })
    .order('total_score', { ascending: false })
    .limit(limit);
  return data || [];
}

// ═══════════════════════════════════════════════════
//  WRITE — save level result via edge function
// ═══════════════════════════════════════════════════
export async function saveLevelResult({ wallet, level, score, stars, movesUsed, boostersUsed, completed, durationMs }) {
  if (!wallet) return null;
  try {
    const res = await fetch(EDGE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        wallet: wallet.toLowerCase(),
        level,
        score,
        stars,
        movesUsed,
        boostersUsed,
        completed,
        durationMs,
      }),
    });
    return await res.json();
  } catch (err) {
    console.error('Save progress failed:', err);
    return null;
  }
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
