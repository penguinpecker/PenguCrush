-- ═══════════════════════════════════════════════════════════════
-- pengu_client_logs — stores WARN/ERROR events emitted by the
-- client-side logger (src/logger.js) via the pengu-log edge fn.
--
-- Retention: rows older than 30 days are deleted by a scheduled
-- Supabase cron (add via Dashboard → Database → Scheduled Tasks).
--   delete from pengu_client_logs where created_at < now() - interval '30 days';
-- ═══════════════════════════════════════════════════════════════

create table if not exists pengu_client_logs (
  id         uuid        primary key default gen_random_uuid(),
  session_id text        not null,                    -- browser session (not wallet session)
  wallet     text,                                    -- lowercase 0x… or null if not connected
  level      text        not null check (level in ('DEBUG','INFO','WARN','ERROR')),
  tag        text        not null,                    -- dot-namespaced, e.g. 'onchain.submit'
  msg        text        not null,
  data       jsonb,                                   -- optional structured context
  ua         text,                                    -- navigator.userAgent (truncated to 300)
  url        text,                                    -- page path (no query string)
  client_ts  timestamptz not null,                    -- timestamp from the client
  created_at timestamptz not null default now()       -- server arrival time
);

-- Query: all errors for a given wallet, newest first
create index if not exists clogs_wallet_level_idx
  on pengu_client_logs (wallet, level, created_at desc);

-- Query: all entries for a given tag pattern
create index if not exists clogs_tag_idx
  on pengu_client_logs (tag, created_at desc);

-- Query: recent activity across all users
create index if not exists clogs_created_idx
  on pengu_client_logs (created_at desc);

-- ── RLS — anon/authenticated cannot read or write directly.
-- All writes go through the pengu-log edge function (service role).
alter table pengu_client_logs enable row level security;
-- No policies = no access for anon/authenticated; service role bypasses RLS.

-- ── Helpful admin views ─────────────────────────────────────────

-- Recent errors across all users (last 24h), most recent first
create or replace view pengu_recent_errors as
  select
    created_at,
    wallet,
    tag,
    msg,
    data,
    session_id,
    url
  from pengu_client_logs
  where level = 'ERROR'
    and created_at > now() - interval '24 hours'
  order by created_at desc;

-- Error frequency by tag (last 7 days) — useful for spotting regressions
create or replace view pengu_error_frequency as
  select
    tag,
    msg,
    count(*)            as occurrences,
    count(distinct wallet) as unique_wallets,
    max(created_at)     as last_seen
  from pengu_client_logs
  where level = 'ERROR'
    and created_at > now() - interval '7 days'
  group by tag, msg
  order by occurrences desc;

-- Per-wallet log summary (last 7 days)
create or replace view pengu_wallet_log_summary as
  select
    wallet,
    count(*) filter (where level = 'ERROR') as errors,
    count(*) filter (where level = 'WARN')  as warns,
    max(created_at)                          as last_event,
    min(created_at)                          as first_event
  from pengu_client_logs
  where created_at > now() - interval '7 days'
    and wallet is not null
  group by wallet
  order by errors desc, warns desc;
