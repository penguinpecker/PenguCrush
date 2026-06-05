/**
 * PenguCrush client-side logger.
 *
 * Keeps a rolling 200-entry buffer in memory and persists the last 60 entries
 * to localStorage (pengucrush_logs) so log state survives page reloads.
 * ERROR-level events are also POSTed to the validator backend for remote
 * diagnostics.
 *
 * Usage:
 *   import { log, LogLevel } from './logger.js';
 *   log(LogLevel.WARN, 'onchain', 'submitLevel failed', { err: err.message });
 *
 * Dev / support:
 *   window.__pengu.copyLogs()   — copies the log report to clipboard
 *   window.__pengu.getLogs()    — returns raw log array
 *   window.__pengu.clearLogs()  — wipes buffer + localStorage
 */

// ── Constants ────────────────────────────────────────────────────────────────
const LS_KEY       = 'pengucrush_logs';
const MAX_MEM      = 200;   // rolling in-memory entries
const MAX_PERSIST  = 60;    // entries saved to localStorage on each write
const REMOTE_RATE_MS = 30_000; // min ms between remote sends for same error tag

const REPORT_API = (() => {
  // Reuse the same base as onchain.js uses for the validator
  try { return (import.meta.env?.VITE_QUOTE_API_BASE || 'https://api.pengucrush.xyz') + '/pengu-log'; }
  catch (_) { return ''; }
})();

export const LogLevel = /** @type {const} */ ({
  DEBUG: 0,
  INFO:  1,
  WARN:  2,
  ERROR: 3,
});

const LEVEL_NAMES = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

// ── State ────────────────────────────────────────────────────────────────────
/** @type {Array<{ts:number, level:number, tag:string, msg:string, data?:any}>} */
const _buf = [];
/** Last time we POSTed a given tag remotely (rate-limiter). */
const _lastRemote = new Map();

let _sessionId = '';
try {
  _sessionId = sessionStorage.getItem('pengucrush_session_id') || '';
  if (!_sessionId) {
    _sessionId = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    sessionStorage.setItem('pengucrush_session_id', _sessionId);
  }
} catch (_) {}

// Hydrate buffer from localStorage on module load
try {
  const saved = JSON.parse(localStorage.getItem(LS_KEY) || '[]');
  if (Array.isArray(saved)) _buf.push(...saved.slice(-MAX_PERSIST));
} catch (_) {}

// ── Core ─────────────────────────────────────────────────────────────────────
function _persist() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(_buf.slice(-MAX_PERSIST)));
  } catch (_) {}
}

// Pending queue for batched remote sends (WARN+ERROR).
// Entries are flushed immediately on ERROR, or every BATCH_INTERVAL_MS for WARN.
const _queue = [];
const BATCH_INTERVAL_MS = 10_000; // flush WARN queue every 10s
let _flushTimer = null;

function _getContext() {
  return {
    session: _sessionId,
    wallet:  (() => { try { return window.__penguWallet || ''; } catch (_) { return ''; } })(),
    ua:      navigator.userAgent.slice(0, 300),
    url:     location.href.replace(/\?.*/, ''),
  };
}

/** Send a batch of entries to the remote endpoint. */
function _sendBatch(entries) {
  if (!REPORT_API || !entries.length) return;
  try {
    fetch(REPORT_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ..._getContext(), entries }),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}

/** Flush everything in _queue now. */
function _flush() {
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (!_queue.length) return;
  _sendBatch(_queue.splice(0));
}

/** Schedule a flush if one isn't already pending. */
function _scheduleFlush() {
  if (_flushTimer) return;
  _flushTimer = setTimeout(_flush, BATCH_INTERVAL_MS);
}

/** Enqueue an entry for remote send. WARN → batched; ERROR → immediate. */
function _enqueue(entry) {
  if (!REPORT_API) return;
  // Rate-limit per tag to avoid flooding on tight loops
  const now = Date.now();
  const last = _lastRemote.get(entry.tag) || 0;
  if (now - last < REMOTE_RATE_MS) return;
  _lastRemote.set(entry.tag, now);

  _queue.push(entry);
  if (entry.level >= LogLevel.ERROR) {
    _flush(); // ERROR: send immediately
  } else {
    _scheduleFlush(); // WARN: batch
  }
}

// Flush remaining entries when the tab closes or navigates away
if (typeof window !== 'undefined') {
  window.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') _flush();
  });
  window.addEventListener('beforeunload', _flush);
}

/**
 * Add a log entry.
 * @param {number} level  One of LogLevel.*
 * @param {string} tag    Short dot-separated namespace, e.g. 'onchain.submit'
 * @param {string} msg    Human-readable message
 * @param {any}    [data] Extra context (will be JSON-serialised)
 */
export function log(level, tag, msg, data) {
  const entry = { ts: Date.now(), level, tag, msg };
  if (data !== undefined) {
    try { entry.data = JSON.parse(JSON.stringify(data)); } catch (_) { entry.data = String(data); }
  }
  _buf.push(entry);
  if (_buf.length > MAX_MEM) _buf.shift();
  _persist();
  // Ship WARN and above to the remote store
  if (level >= LogLevel.WARN) _enqueue(entry);
}

// Convenience helpers
export const logDebug = (tag, msg, data) => log(LogLevel.DEBUG, tag, msg, data);
export const logInfo  = (tag, msg, data) => log(LogLevel.INFO,  tag, msg, data);
export const logWarn  = (tag, msg, data) => log(LogLevel.WARN,  tag, msg, data);
export const logError = (tag, msg, data) => log(LogLevel.ERROR, tag, msg, data);

// ── Report helpers ────────────────────────────────────────────────────────────
export function getEntries() { return [..._buf]; }

export function clearLogs() {
  _buf.length = 0;
  try { localStorage.removeItem(LS_KEY); } catch (_) {}
}

export function buildReport() {
  const wallet = (() => { try { return window.__penguWallet || ''; } catch (_) { return ''; } })();
  return {
    session:   _sessionId,
    wallet:    wallet ? wallet.slice(0, 10) + '…' : '(none)',
    generated: new Date().toISOString(),
    url:       location.href,
    ua:        navigator.userAgent,
    entries:   _buf.map(e => ({
      time:  new Date(e.ts).toISOString(),
      level: LEVEL_NAMES[e.level] || e.level,
      tag:   e.tag,
      msg:   e.msg,
      ...(e.data !== undefined ? { data: e.data } : {}),
    })),
  };
}

export async function copyReport() {
  const text = JSON.stringify(buildReport(), null, 2);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // Fallback: prompt with the text so the user can copy manually
    prompt('Copy the log report below:', text);
    return false;
  }
}

// ── Global error capture ─────────────────────────────────────────────────────
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    logError('global.error', e.message || 'Uncaught error', {
      source: e.filename ? e.filename.split('/').pop() : '',
      line: e.lineno,
      col: e.colno,
      stack: e.error?.stack?.slice(0, 400),
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const msg = reason?.shortMessage || reason?.message || String(reason);
    logError('global.promise', msg.slice(0, 300), {
      stack: reason?.stack?.slice(0, 400),
    });
  });
}
