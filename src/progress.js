// ═══════════════════════════════════════════════════════════════
//  PROGRESS GATE — is a given level actually unlocked for this player?
//
//  localStorage is a fast hint but cannot be trusted (a user can
//  edit it). The blockchain is the source of truth: level N>1 is
//  unlocked iff the connected wallet has a recorded result for
//  level N-1 with stars > 0 on the PenguCrush contract.
//
//  The gate returns "locked" whenever on-chain verification is
//  unavailable (no wallet, RPC fails) for any level > 1, so URL-
//  tampered requests can't slip through.
// ═══════════════════════════════════════════════════════════════

import { getPublicClient, getAGWAddress } from './agw.js';
import { PENGUCRUSH_ADDRESS } from './onchain.js';
import penguCrushAbiJson from '../contracts/PenguCrushABI.json';

const abi = Array.isArray(penguCrushAbiJson) ? penguCrushAbiJson : penguCrushAbiJson.abi || [];

/** Fast, untrusted hint from localStorage — useful for UI, not for authorization. */
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

/** Authoritative on-chain gate. Returns true only if the chain confirms. */
export async function isLevelUnlockedOnchain(levelN) {
  if (levelN <= 1) return true;
  const wallet = getAGWAddress();
  if (!wallet) return false; // must be connected to prove past completions
  try {
    const client = getPublicClient();
    const result = await client.readContract({
      address: PENGUCRUSH_ADDRESS,
      abi,
      functionName: 'getBestResult',
      args: [wallet, levelN - 1],
    });
    // Viem returns struct as either object or tuple depending on ABI shape
    const stars = Number(result?.stars ?? result?.[2] ?? 0);
    return stars > 0;
  } catch (err) {
    console.warn('Level-unlock chain check failed:', err?.shortMessage || err?.message || err);
    return false;
  }
}

/**
 * Combined gate: chain is authoritative; localStorage only helps decide
 * when to *skip* the chain call for the obvious unlocked-by-default case.
 */
export async function isLevelUnlocked(levelN) {
  if (levelN <= 1) return true;
  return isLevelUnlockedOnchain(levelN);
}
