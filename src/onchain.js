// ═══════════════════════════════════════════════════════════════
//  ON-CHAIN ACTIVITY — writes to Abstract from the user's AGW
//
//  Target contract: PenguCrush (UUPS upgradeable). One proxy address
//  handles level submissions AND booster/spin activity events, so
//  new actions can be added later by upgrading the implementation
//  without changing this file's address or players' history.
//
//  Until the new PenguCrush proxy is deployed, level submissions
//  fall back to the existing PenguCrushScores contract so the
//  existing leaderboard keeps working.
// ═══════════════════════════════════════════════════════════════

import { getWalletClient, getAGWAddress } from './agw.js';
import { abstract } from 'viem/chains';
import legacyScoresAbiJson from '../contracts/PenguCrushScoresABI.json';
import penguCrushAbiJson from '../contracts/PenguCrushABI.json';

// ── Contract addresses ────────────────────────────────────────
// New unified proxy — fill in after `deploy-pengucrush.cjs` runs.
const PENGUCRUSH_ADDRESS = null;

// Legacy scores contract still live on Abstract Mainnet.
const LEGACY_SCORES_ADDRESS = '0x2ef63Ee603a6944396AA97DA35835807F96BA089';

const legacyScoresAbi = Array.isArray(legacyScoresAbiJson) ? legacyScoresAbiJson : legacyScoresAbiJson.abi || [];
const penguCrushAbi = Array.isArray(penguCrushAbiJson) ? penguCrushAbiJson : penguCrushAbiJson.abi || [];

// ── Kill switch ───────────────────────────────────────────────

function isDisabled() {
  try { return import.meta.env?.VITE_ONCHAIN_DISABLED === 'true'; } catch (_) { return false; }
}

function log(label, hash) {
  if (hash) console.log(`🔗 onchain ${label}:`, hash);
}

async function safeWrite(label, fn) {
  if (isDisabled()) return null;
  const client = getWalletClient();
  const account = getAGWAddress();
  if (!client || !account) return null;
  try {
    const hash = await fn(client, account);
    log(label, hash);
    return hash;
  } catch (err) {
    console.warn(`onchain ${label} failed (non-fatal):`, err?.shortMessage || err?.message || err);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────

export async function logLevelOnchain({ level, score, stars, movesUsed }) {
  return safeWrite('level', (client, account) =>
    client.writeContract({
      address: PENGUCRUSH_ADDRESS || LEGACY_SCORES_ADDRESS,
      abi: PENGUCRUSH_ADDRESS ? penguCrushAbi : legacyScoresAbi,
      functionName: 'submitScore',
      args: [
        Number(level),
        Number(score),
        Number(stars),
        Number(movesUsed),
      ],
      account,
      chain: abstract,
    })
  );
}

export async function logBoosterUseOnchain(boosterType) {
  if (!PENGUCRUSH_ADDRESS) return null;
  return safeWrite('booster-use', (client, account) =>
    client.writeContract({
      address: PENGUCRUSH_ADDRESS,
      abi: penguCrushAbi,
      functionName: 'logBoosterUsed',
      args: [stringToBytes32(boosterType)],
      account,
      chain: abstract,
    })
  );
}

export async function logBoosterPurchaseOnchain(boosterType, qty) {
  if (!PENGUCRUSH_ADDRESS) return null;
  return safeWrite('booster-buy', (client, account) =>
    client.writeContract({
      address: PENGUCRUSH_ADDRESS,
      abi: penguCrushAbi,
      functionName: 'logBoosterPurchased',
      args: [stringToBytes32(boosterType), Number(qty)],
      account,
      chain: abstract,
    })
  );
}

export async function logDailySpinOnchain(rewardText) {
  if (!PENGUCRUSH_ADDRESS) return null;
  return safeWrite('daily-spin', (client, account) =>
    client.writeContract({
      address: PENGUCRUSH_ADDRESS,
      abi: penguCrushAbi,
      functionName: 'logDailySpin',
      args: [stringToBytes32(rewardText)],
      account,
      chain: abstract,
    })
  );
}

export async function logSessionPingOnchain(tag) {
  if (!PENGUCRUSH_ADDRESS) return null;
  return safeWrite('session-ping', (client, account) =>
    client.writeContract({
      address: PENGUCRUSH_ADDRESS,
      abi: penguCrushAbi,
      functionName: 'logSessionPing',
      args: [stringToBytes32(tag)],
      account,
      chain: abstract,
    })
  );
}

// ── Helpers ───────────────────────────────────────────────────

function stringToBytes32(s) {
  const bytes = new TextEncoder().encode((s || '').slice(0, 31));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return '0x' + hex.padEnd(64, '0');
}

export { PENGUCRUSH_ADDRESS, LEGACY_SCORES_ADDRESS };
