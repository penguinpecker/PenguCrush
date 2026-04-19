// ═══════════════════════════════════════════════════════════════
//  ON-CHAIN ACTIVITY — writes to Abstract from the user's AGW
//
//  Target contract: PenguCrush (UUPS upgradeable proxy). One address
//  handles level submissions AND activity events (booster used,
//  booster purchased, daily spin, session ping). New actions are
//  added by upgrading the implementation — the proxy address and
//  all player history stay the same.
// ═══════════════════════════════════════════════════════════════

import { getWalletClient, getAGWAddress } from './agw.js';
import { abstract } from 'viem/chains';
import penguCrushAbiJson from '../contracts/PenguCrushABI.json';

/** Unified UUPS proxy on Abstract Mainnet (chain 2741). */
export const PENGUCRUSH_ADDRESS = '0xAF2ED337AAF8c3FF4AF5600C15F1C8C7042ec517';

const penguCrushAbi = Array.isArray(penguCrushAbiJson) ? penguCrushAbiJson : penguCrushAbiJson.abi || [];

// ── Kill switch ───────────────────────────────────────────────

function isDisabled() {
  try { return import.meta.env?.VITE_ONCHAIN_DISABLED === 'true'; } catch (_) { return false; }
}

function log(label, hash) {
  if (hash) console.log(`🔗 onchain ${label}:`, hash);
}

async function safeWrite(label, functionName, args) {
  if (isDisabled()) return null;
  const client = getWalletClient();
  const account = getAGWAddress();
  if (!client || !account) return null;
  try {
    const hash = await client.writeContract({
      address: PENGUCRUSH_ADDRESS,
      abi: penguCrushAbi,
      functionName,
      args,
      account,
      chain: abstract,
    });
    log(label, hash);
    return hash;
  } catch (err) {
    console.warn(`onchain ${label} failed (non-fatal):`, err?.shortMessage || err?.message || err);
    return null;
  }
}

// ── Public API ────────────────────────────────────────────────

export function logLevelOnchain({ level, score, stars, movesUsed }) {
  return safeWrite('level', 'submitScore',
    [Number(level), Number(score), Number(stars), Number(movesUsed)]);
}

export function logBoosterUseOnchain(boosterType) {
  return safeWrite('booster-use', 'logBoosterUsed',
    [stringToBytes32(boosterType)]);
}

export function logBoosterPurchaseOnchain(boosterType, qty) {
  return safeWrite('booster-buy', 'logBoosterPurchased',
    [stringToBytes32(boosterType), Number(qty)]);
}

export function logDailySpinOnchain(rewardText) {
  return safeWrite('daily-spin', 'logDailySpin',
    [stringToBytes32(rewardText)]);
}

export function logSessionPingOnchain(tag) {
  return safeWrite('session-ping', 'logSessionPing',
    [stringToBytes32(tag)]);
}

// ── Helpers ───────────────────────────────────────────────────

function stringToBytes32(s) {
  const bytes = new TextEncoder().encode((s || '').slice(0, 31));
  const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  return '0x' + hex.padEnd(64, '0');
}
