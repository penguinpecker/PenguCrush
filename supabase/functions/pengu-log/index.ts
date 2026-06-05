// Edge function: pengu-log
// Receives WARN/ERROR log entries from the client-side logger
// (src/logger.js) and inserts them into pengu_client_logs.
//
// POST { session, wallet?, entry, ua?, url? }        — single entry
// POST { session, wallet?, entries, ua?, url? }      — batch (max 20)
//
// Always returns 200 so the client never retries on error.
// Rate limit: 60 inserts per session_id per 5-minute window (in-memory,
// per edge function instance — not distributed, but good enough to
// block runaway loops in a single browser tab).

import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization,apikey',
};

const VALID_LEVELS = new Set(['DEBUG', 'INFO', 'WARN', 'ERROR']);
const LEVEL_NAMES  = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
const MAX_BATCH    = 20;
const MAX_MSG_LEN  = 500;
const MAX_UA_LEN   = 300;
const MAX_TAG_LEN  = 80;

// ── In-process rate limiter (per session_id) ─────────────────────
const _rateMap = new Map<string, { count: number; resetAt: number }>();
const RATE_WINDOW_MS  = 5 * 60 * 1000; // 5 min
const RATE_MAX_INSERTS = 60;

function isRateLimited(sessionId: string): boolean {
  const now = Date.now();
  let entry = _rateMap.get(sessionId);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
    _rateMap.set(sessionId, entry);
  }
  entry.count++;
  return entry.count > RATE_MAX_INSERTS;
}

// Periodically prune stale entries (prevent unbounded growth)
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _rateMap) {
    if (now > v.resetAt) _rateMap.delete(k);
  }
}, 60_000);

// ── Helpers ───────────────────────────────────────────────────────
function trunc(s: unknown, max: number): string | null {
  if (s == null) return null;
  const str = String(s);
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function sanitizeEntry(raw: Record<string, unknown>, ua: string | null, url: string | null, sessionId: string, wallet: string | null) {
  const levelIndex = typeof raw.level === 'number' ? raw.level : -1;
  const levelName  = LEVEL_NAMES[levelIndex] ?? String(raw.level ?? '');
  if (!VALID_LEVELS.has(levelName)) return null;

  const tag = trunc(raw.tag, MAX_TAG_LEN);
  const msg = trunc(raw.msg, MAX_MSG_LEN);
  if (!tag || !msg) return null;

  let data: unknown = null;
  if (raw.data !== undefined) {
    try { data = JSON.parse(JSON.stringify(raw.data)); } catch (_) { data = String(raw.data).slice(0, 300); }
  }

  const tsMs = typeof raw.ts === 'number' ? raw.ts : Date.now();
  const clientTs = new Date(tsMs).toISOString();

  return {
    session_id: sessionId,
    wallet: wallet ? wallet.toLowerCase().slice(0, 42) : null,
    level: levelName,
    tag,
    msg,
    data: data ?? undefined,
    ua: ua ?? undefined,
    url: url ?? undefined,
    client_ts: clientTs,
  };
}

// ── Handler ───────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (req.method !== 'POST')   return new Response('method not allowed', { status: 405, headers: CORS });

  // Always return 200 to the client — errors are logged server-side only.
  const ok = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { ...CORS, 'content-type': 'application/json' },
  });

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch (_) { return ok; }

  const sessionId = trunc(body.session, 64) ?? 'unknown';
  const wallet    = trunc(body.wallet,  42);
  const ua        = trunc(body.ua,       MAX_UA_LEN);
  const url       = trunc(body.url,     200);

  if (isRateLimited(sessionId)) return ok; // silently drop

  // Normalise single vs batch
  const rawEntries: unknown[] = Array.isArray(body.entries)
    ? body.entries.slice(0, MAX_BATCH)
    : body.entry ? [body.entry] : [];

  if (rawEntries.length === 0) return ok;

  const rows = rawEntries
    .map(e => sanitizeEntry(e as Record<string, unknown>, ua, url, sessionId, wallet))
    .filter((r): r is NonNullable<typeof r> => r !== null);

  if (rows.length === 0) return ok;

  // Use service role to bypass RLS
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
  const serviceKey  = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
  if (!supabaseUrl || !serviceKey) return ok;

  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });
  const { error } = await sb.from('pengu_client_logs').insert(rows);
  if (error) {
    console.error('[pengu-log] insert failed:', error.message);
  }

  return ok;
});
