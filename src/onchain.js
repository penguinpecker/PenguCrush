// ═══════════════════════════════════════════════════════════════
//  ON-CHAIN ACTIVITY — writes to Abstract from the user's AGW
//
//  Every meaningful action (level complete, booster purchase,
//  booster use, daily spin) fires a best-effort tx from the
//  connected wallet so it counts as on-chain activity on Abstract.
//
//  Failures are logged but never block gameplay. Set
//  VITE_ONCHAIN_DISABLED=true in .env.local to turn all of this
//  off during development.
// ═══════════════════════════════════════════════════════════════

import { getWalletClient, getAGWAddress, getPublicClient } from './agw.js';
import { abstract } from 'viem/chains';
import scoresAbiJson from '../contracts/PenguCrushScoresABI.json';

// ── Contract addresses ────────────────────────────────────────
// PenguCrushScores is already deployed on Abstract Mainnet.
// PenguCrushActivity is a planned contract for booster/spin events —
// once deployed, drop its address here and the matching functions
// below will start sending txs automatically.
const SCORES_ADDRESS = '0x2ef63Ee603a6944396AA97DA35835807F96BA089';
const ACTIVITY_ADDRESS = null; // TODO: deploy and fill in

const scoresAbi = Array.isArray(scoresAbiJson) ? scoresAbiJson : scoresAbiJson.abi || [];

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

/**
 * Submit a completed level to the existing PenguCrushScores contract.
 * Args match the contract's submitScore(level, score, stars, movesUsed).
 */
export async function logLevelOnchain({ level, score, stars, movesUsed }) {
  return safeWrite('level', (client, account) =>
    client.writeContract({
      address: SCORES_ADDRESS,
      abi: scoresAbi,
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

/**
 * Booster consumption event. Requires PenguCrushActivity contract with a
 * `logBoosterUsed(bytes32 booster)` function. No-op until deployed.
 */
export async function logBoosterUseOnchain(boosterType) {
  if (!ACTIVITY_ADDRESS) return null;
  return safeWrite('booster-use', (client, account) =>
    client.writeContract({
      address: ACTIVITY_ADDRESS,
      abi: [{ type: 'function', name: 'logBoosterUsed', stateMutability: 'nonpayable',
              inputs: [{ type: 'bytes32', name: 'booster' }], outputs: [] }],
      functionName: 'logBoosterUsed',
      args: [stringToBytes32(boosterType)],
      account,
      chain: abstract,
    })
  );
}

/**
 * Booster purchase event — same contract + function shape but for 'logBoosterPurchased'.
 */
export async function logBoosterPurchaseOnchain(boosterType, qty) {
  if (!ACTIVITY_ADDRESS) return null;
  return safeWrite('booster-buy', (client, account) =>
    client.writeContract({
      address: ACTIVITY_ADDRESS,
      abi: [{ type: 'function', name: 'logBoosterPurchased', stateMutability: 'nonpayable',
              inputs: [{ type: 'bytes32', name: 'booster' }, { type: 'uint32', name: 'qty' }], outputs: [] }],
      functionName: 'logBoosterPurchased',
      args: [stringToBytes32(boosterType), Number(qty)],
      account,
      chain: abstract,
    })
  );
}

/**
 * Daily wheel spin event. Records the reward identifier on-chain.
 */
export async function logDailySpinOnchain(rewardText) {
  if (!ACTIVITY_ADDRESS) return null;
  return safeWrite('daily-spin', (client, account) =>
    client.writeContract({
      address: ACTIVITY_ADDRESS,
      abi: [{ type: 'function', name: 'logDailySpin', stateMutability: 'nonpayable',
              inputs: [{ type: 'bytes32', name: 'reward' }], outputs: [] }],
      functionName: 'logDailySpin',
      args: [stringToBytes32(rewardText)],
      account,
      chain: abstract,
    })
  );
}

// ── Helpers ───────────────────────────────────────────────────

function stringToBytes32(s) {
  // Encode up to 31 bytes of ASCII into a 0x-prefixed bytes32.
  const bytes = new TextEncoder().encode((s || '').slice(0, 31));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return '0x' + hex.padEnd(64, '0');
}

export { SCORES_ADDRESS, ACTIVITY_ADDRESS };
