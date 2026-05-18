// ═══════════════════════════════════════════════════════════════
//  MID-GAME SNAPSHOT — save/restore + on-chain checkpoint trail
//
//  • Every 5 moves the game hashes its board snapshot and emits a
//    LevelCheckpoint event on chain (via levelCheckpoint in game.js).
//  • The same snapshot is persisted to localStorage (instant resume
//    on the same device) and to Supabase pengu_game_snapshots (cross-
//    device).
//  • On level load, if a snapshot exists for the current wallet+level
//    we offer "resume or start fresh".
//  • The snapshot is wiped on level completion (win or fail).
// ═══════════════════════════════════════════════════════════════

import { supabase } from './supabase.js';
import { getAGWAddress } from './agw.js';
import { keccak256, toBytes } from 'viem';

const LS_KEY = 'pengucrush_midgame_v1';

function key(wallet, level) {
  return `${(wallet || 'guest').toLowerCase()}::L${level}`;
}

function readAll() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}') || {}; } catch (_) { return {}; }
}
function writeAll(all) {
  localStorage.setItem(LS_KEY, JSON.stringify(all));
}

export function hashSnapshot(snapshot) {
  return keccak256(toBytes(JSON.stringify(snapshot)));
}

/** Save snapshot locally + best-effort to Supabase. Returns the snapshot hash. */
export async function saveSnapshot(level, snapshot) {
  const wallet = getAGWAddress();
  const hash = hashSnapshot(snapshot);
  const blob = { wallet, level, snapshot, hash, savedAt: Date.now() };
  const all = readAll();
  all[key(wallet, level)] = blob;
  writeAll(all);
  if (wallet) {
    try {
      await supabase.from('pengu_game_snapshots').upsert({
        wallet: wallet.toLowerCase(),
        level,
        move_num: snapshot.movesUsed || 0,
        score: snapshot.score || 0,
        snapshot,
        snapshot_hash: hash,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'wallet,level' });
    } catch (err) {
      console.warn('mid-game cloud save failed:', err?.message || err);
    }
  }
  return hash;
}

/** Load snapshot for (current wallet, level). localStorage first; falls back to Supabase. */
export async function loadSnapshot(level) {
  const wallet = getAGWAddress();
  const all = readAll();
  const local = all[key(wallet, level)];
  if (local?.snapshot) return local;
  if (!wallet) return null;
  try {
    const { data } = await supabase.from('pengu_game_snapshots')
      .select('snapshot, snapshot_hash, move_num, score, updated_at')
      .eq('wallet', wallet.toLowerCase())
      .eq('level', level)
      .maybeSingle();
    if (!data?.snapshot) return null;
    return {
      wallet, level,
      snapshot: data.snapshot,
      hash: data.snapshot_hash,
      savedAt: new Date(data.updated_at).getTime(),
    };
  } catch (err) {
    console.warn('mid-game cloud load failed:', err?.message || err);
    return null;
  }
}

/** Clear snapshot on level completion. */
export async function clearSnapshot(level) {
  const wallet = getAGWAddress();
  const all = readAll();
  delete all[key(wallet, level)];
  writeAll(all);
  if (wallet) {
    try {
      await supabase.from('pengu_game_snapshots')
        .delete()
        .eq('wallet', wallet.toLowerCase())
        .eq('level', level);
    } catch (err) {
      console.warn('mid-game cloud clear failed:', err?.message || err);
    }
  }
}
