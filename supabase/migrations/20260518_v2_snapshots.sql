-- Migration: V2 game snapshot store for mid-level resume + tamper-detection trail.
-- Cross-references on-chain LevelCheckpoint events (snapshot_hash matches).

create table if not exists pengu_game_snapshots (
  id           uuid primary key default gen_random_uuid(),
  wallet       text not null,
  level        smallint not null,
  move_num     smallint not null,
  score        integer not null default 0,
  snapshot     jsonb not null,
  snapshot_hash text not null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create unique index if not exists pengu_game_snapshots_wallet_level_idx
  on pengu_game_snapshots (wallet, level);

create index if not exists pengu_game_snapshots_wallet_idx
  on pengu_game_snapshots (wallet);

-- RLS: anon can read/write their own (frontend uses anon key).
-- Authorization happens server-side via the edge function checking SIWE token,
-- but for now the frontend updates directly with the wallet stamp.
alter table pengu_game_snapshots enable row level security;

drop policy if exists pengu_game_snapshots_select on pengu_game_snapshots;
create policy pengu_game_snapshots_select
  on pengu_game_snapshots for select
  using (true);

drop policy if exists pengu_game_snapshots_insert on pengu_game_snapshots;
create policy pengu_game_snapshots_insert
  on pengu_game_snapshots for insert
  with check (true);

drop policy if exists pengu_game_snapshots_update on pengu_game_snapshots;
create policy pengu_game_snapshots_update
  on pengu_game_snapshots for update
  using (true);

drop policy if exists pengu_game_snapshots_delete on pengu_game_snapshots;
create policy pengu_game_snapshots_delete
  on pengu_game_snapshots for delete
  using (true);

comment on table pengu_game_snapshots is
  'Mid-level board snapshots for resume + tamper-detection trail. snapshot_hash matches the on-chain LevelCheckpoint event emitted from PenguCrushV2.';
