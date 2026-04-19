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
    if (cur && cur.unlocked) return true;
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
 * Combined gate: chain is primary, Supabase is a backup. A level is
 * unlocked iff *either* trusted source confirms. If both say no, or
 * both are unreachable, the level stays locked.
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
  return supa === true;
}
