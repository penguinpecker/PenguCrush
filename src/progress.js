// ═══════════════════════════════════════════════════════════════
//  PROGRESS GATE — is a given level actually unlocked for this player?
//
//  Authorization comes from trusted sources only:
//    1. On-chain PenguCrush.getBestResult(wallet, N-1) — primary
//    2. Supabase pengu_progress for that wallet — backup
//
//  localStorage is never used for auth. If both trusted sources say
//  "no" or are unavailable, the level stays locked. Editing
//  pengucrush_progress in localStorage has zero effect on access.
// ═══════════════════════════════════════════════════════════════

import { getPublicClient, getAGWAddress } from './agw.js';
import { PENGUCRUSH_ADDRESS } from './onchain.js';
import { fetchPlayerProgress } from './supabase.js';
import penguCrushAbiJson from '../contracts/PenguCrushABI.json';

const abi = Array.isArray(penguCrushAbiJson) ? penguCrushAbiJson : penguCrushAbiJson.abi || [];

/** Fast, untrusted hint from localStorage — useful for UI only, never for authorization. */
export function isLevelUnlockedLocal(levelN) {
  if (levelN <= 1) return true;
  try {
    const p = JSON.parse(localStorage.getItem('pengucrush_progress') || '{}');
    const prev = p[levelN - 1];
    if (prev && prev.stars > 0) return true;
    const cur = p[levelN];
    if (cur && cur.unlocked && prev && prev.stars > 0) return true;
  } catch (_) {}
  return false;
}

/** Primary check: on-chain best result for the previous level. */
export async function isLevelUnlockedOnchain(levelN) {
  if (levelN <= 1) return true;
  const wallet = getAGWAddress();
  if (!wallet) return false;
  try {
    const client = getPublicClient();
    const result = await client.readContract({
      address: PENGUCRUSH_ADDRESS,
      abi,
      functionName: 'getBestResult',
      args: [wallet, levelN - 1],
    });
    const stars = Number(result?.stars ?? result?.[2] ?? 0);
    return stars > 0;
  } catch (err) {
    console.warn('Level-unlock chain check failed:', err?.shortMessage || err?.message || err);
    return null; // signal "unknown" so caller can fall through to backup
  }
}

/** Backup check: Supabase pengu_progress. Only trusted because the
 *  edge function owns writes to this table. */
export async function isLevelUnlockedSupabase(levelN) {
  if (levelN <= 1) return true;
  const wallet = getAGWAddress();
  if (!wallet) return false;
  try {
    const data = await fetchPlayerProgress(wallet);
    const rows = data?.progress || [];
    const prev = rows.find(r => Number(r.level) === levelN - 1);
    return Number(prev?.stars || 0) > 0;
  } catch (err) {
    console.warn('Level-unlock supabase check failed:', err?.message || err);
    return false;
  }
}

/**
 * Combined gate: chain is primary, Supabase is backup, localStorage is last resort.
 *
 * localStorage is accepted as a final fallback because:
 *   - saveLevelResult (Supabase write) was security-revoked in May 2026 and is
 *     currently a no-op, so Supabase never has data to confirm unlocks.
 *   - The "Map" popup button discards pendingJournal before a chain tx fires,
 *     so chain records may also be missing for wins where the player navigated
 *     away rather than clicking Next.
 *   - game.js writes stars to pengucrush_progress in localStorage only when the
 *     game engine itself records a win (score >= targetScore, objective met), so
 *     the value is as trustworthy as client-side state can be.
 *   - A player editing their own localStorage only affects their own progression;
 *     the risk is cosmetic compared to permanently locking legitimate progress.
 */
export async function isLevelUnlocked(levelN) {
  if (levelN <= 1) return true;
  // Level 99 is the debug/test level (see src/levels.js) — 2 moves,
  // low target, used to quickly reach the end-of-level popup for UI work.
  // It's never shown on the map so only a manual goToLevel(99) hits it.
  if (levelN === 99) return true;
  const chain = await isLevelUnlockedOnchain(levelN);
  if (chain === true) return true;
  // chain === false  → explicit deny from chain; still consult Supabase as a backup
  // chain === null   → chain RPC failed; consult Supabase
  const supa = await isLevelUnlockedSupabase(levelN);
  if (supa === true) return true;
  // Both remote sources unavailable or deny — fall back to localStorage so that
  // players who won but navigated to Map (losing pendingJournal) can still progress.
  return isLevelUnlockedLocal(levelN);
}
