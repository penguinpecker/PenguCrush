-- ═══════════════════════════════════════════════════════════════
-- pengu_tx_log — mirror every chain tx the frontend fires.
-- The chain is the ultimate source of truth (every hash is on Abscan)
-- but this DB mirror makes admin / support queries trivial:
--   "show me every shop_buy_pass tx for wallet 0x… in the last 24h"
--   "show every reverted tx in the last hour"
--   "did my pengu-regen-sweep cron run as expected?"
-- ═══════════════════════════════════════════════════════════════

create table if not exists pengu_tx_log (
  id            uuid primary key default gen_random_uuid(),
  wallet        text not null,
  tx_type       text not null,
  status        text not null,
  tx_hash       text,
  block_number  bigint,
  details       jsonb,
  error         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index if not exists pengu_tx_log_wallet_idx     on pengu_tx_log (wallet, created_at desc);
create index if not exists pengu_tx_log_status_idx     on pengu_tx_log (status, created_at desc);
create index if not exists pengu_tx_log_tx_hash_idx    on pengu_tx_log (tx_hash);
create index if not exists pengu_tx_log_tx_type_idx    on pengu_tx_log (tx_type, created_at desc);

alter table pengu_tx_log
  drop constraint if exists pengu_tx_log_wallet_format;
alter table pengu_tx_log
  add constraint pengu_tx_log_wallet_format
  check (wallet ~ '^0x[a-f0-9]{40}$');

alter table pengu_tx_log enable row level security;

drop policy if exists "anon read tx_log"   on pengu_tx_log;
create policy "anon read tx_log"   on pengu_tx_log for select using (true);
drop policy if exists "anon insert tx_log" on pengu_tx_log;
create policy "anon insert tx_log" on pengu_tx_log for insert with check (wallet ~ '^0x[a-f0-9]{40}$');
drop policy if exists "anon update tx_log" on pengu_tx_log;
create policy "anon update tx_log" on pengu_tx_log for update using (wallet ~ '^0x[a-f0-9]{40}$');

-- Cap rows per wallet so a misbehaving client cannot flood-fill the table.
create or replace function _pengu_tx_log_cap_check()
returns trigger language plpgsql as $$
declare v_count int;
begin
  select count(*) into v_count from pengu_tx_log where wallet = lower(new.wallet);
  if v_count >= 10000 then
    raise exception 'tx_log cap reached for wallet';
  end if;
  return new;
end $$;

drop trigger if exists pengu_tx_log_cap on pengu_tx_log;
create trigger pengu_tx_log_cap
  before insert on pengu_tx_log
  for each row execute function _pengu_tx_log_cap_check();
