// ═══════════════════════════════════════════════════════════════
//  TX LOG — mirror every chain tx into Supabase pengu_tx_log
//
//  Fire-and-forget. The chain is the ultimate source of truth (every
//  hash is on Abscan), but this DB mirror lets admin / support filter
//  by wallet + type + status without crawling RPC logs.
//
//  Public API:
//    logTxSubmitted({ wallet, type, txHash?, details })   → row id
//    logTxResult(rowId, { status, blockNumber?, error? })
//    logTxError({ wallet, type, error, details })         → no on-chain hash
// ═══════════════════════════════════════════════════════════════

import { supabase } from './supabase.js';

function ms(addr) {
  return typeof addr === 'string' ? addr.toLowerCase() : null;
}

function shorten(s) {
  return typeof s === 'string' ? s.slice(0, 500) : null;
}

/** Insert a `submitted` row before sending the tx (so even crashes leave a trail). */
export async function logTxSubmitted({ wallet, type, txHash = null, details = {} }) {
  const w = ms(wallet);
  if (!w || !/^0x[a-f0-9]{40}$/.test(w)) return null;
  try {
    const { data, error } = await supabase
      .from('pengu_tx_log')
      .insert({
        wallet: w,
        tx_type: String(type).slice(0, 64),
        status: 'submitted',
        tx_hash: txHash,
        details: details || {},
      })
      .select('id')
      .single();
    if (error) return null;
    return data?.id || null;
  } catch (_) { return null; }
}

/** Update a previously-inserted row with the eventual outcome. */
export async function logTxResult(rowId, { status, txHash = null, blockNumber = null, error = null }) {
  if (!rowId) return;
  try {
    await supabase
      .from('pengu_tx_log')
      .update({
        status,
        tx_hash: txHash,
        block_number: blockNumber,
        error: shorten(error),
        updated_at: new Date().toISOString(),
      })
      .eq('id', rowId);
  } catch (_) { /* swallow */ }
}

/** One-shot log for a non-submitted error (signature step failed, etc.). */
export async function logTxError({ wallet, type, error, details = {} }) {
  const w = ms(wallet);
  if (!w || !/^0x[a-f0-9]{40}$/.test(w)) return;
  try {
    await supabase
      .from('pengu_tx_log')
      .insert({
        wallet: w,
        tx_type: String(type).slice(0, 64),
        status: 'error',
        details: details || {},
        error: shorten(error),
      });
  } catch (_) { /* swallow */ }
}
