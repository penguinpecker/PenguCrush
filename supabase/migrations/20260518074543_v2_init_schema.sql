-- ═══════════════════════════════════════════════════════════════
-- PenguCrush v2 — initial schema for the new Supabase project.
-- Combines the legacy app tables (players/progress/boosters) with
-- the v2 additions (game snapshots + private app_secrets table).
-- ═══════════════════════════════════════════════════════════════

create table if not exists pengu_players (
  id              uuid primary key default gen_random_uuid(),
  wallet_address  text not null unique,
  username        text,
  avatar_url      text,
  total_stars     integer not null default 0,
  highest_level   smallint not null default 0,
  total_score     integer not null default 0,
  games_played    integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists pengu_players_wallet_idx on pengu_players (wallet_address);

create table if not exists pengu_progress (
  id          uuid primary key default gen_random_uuid(),
  player_id   uuid not null references pengu_players(id) on delete cascade,
  level       smallint not null,
  stars       smallint not null default 0,
  best_score  integer not null default 0,
  attempts    integer not null default 0,
  updated_at  timestamptz not null default now(),
  unique (player_id, level)
);
create index if not exists pengu_progress_player_idx on pengu_progress (player_id);

create table if not exists pengu_boosters (
  id            uuid primary key default gen_random_uuid(),
  player_id     uuid not null references pengu_players(id) on delete cascade,
  booster_type  text not null,
  charges       integer not null default 0,
  updated_at    timestamptz not null default now(),
  unique (player_id, booster_type)
);
create index if not exists pengu_boosters_player_idx on pengu_boosters (player_id);

create table if not exists pengu_game_snapshots (
  id            uuid primary key default gen_random_uuid(),
  wallet        text not null,
  level         smallint not null,
  move_num      smallint not null,
  score         integer not null default 0,
  snapshot      jsonb not null,
  snapshot_hash text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (wallet, level)
);
create index if not exists pengu_snapshots_wallet_idx on pengu_game_snapshots (wallet);

create or replace view pengu_leaderboard as
  select
    wallet_address,
    total_stars,
    total_score,
    highest_level,
    games_played
  from pengu_players
  order by total_stars desc, total_score desc;

create table if not exists app_secrets (
  name        text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

alter table pengu_players          enable row level security;
alter table pengu_progress         enable row level security;
alter table pengu_boosters         enable row level security;
alter table pengu_game_snapshots   enable row level security;
alter table app_secrets            enable row level security;

drop policy if exists "anon read pengu_players"   on pengu_players;
create policy "anon read pengu_players"   on pengu_players   for select using (true);
drop policy if exists "anon read pengu_progress"  on pengu_progress;
create policy "anon read pengu_progress"  on pengu_progress  for select using (true);
drop policy if exists "anon read pengu_boosters"  on pengu_boosters;
create policy "anon read pengu_boosters"  on pengu_boosters  for select using (true);

drop policy if exists "anon read snapshots"  on pengu_game_snapshots;
create policy "anon read snapshots"  on pengu_game_snapshots for select using (true);
drop policy if exists "anon write snapshots" on pengu_game_snapshots;
create policy "anon write snapshots" on pengu_game_snapshots for insert with check (true);
drop policy if exists "anon update snapshots" on pengu_game_snapshots;
create policy "anon update snapshots" on pengu_game_snapshots for update using (true);
drop policy if exists "anon delete snapshots" on pengu_game_snapshots;
create policy "anon delete snapshots" on pengu_game_snapshots for delete using (true);

create or replace function rpc_upsert_player_progress(
  p_wallet text,
  p_level smallint,
  p_score integer,
  p_stars smallint,
  p_moves_used smallint,
  p_completed boolean
) returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_player_id uuid;
  v_prev_stars smallint;
  v_prev_score integer;
begin
  insert into pengu_players (wallet_address)
    values (lower(p_wallet))
    on conflict (wallet_address) do update set updated_at = now()
    returning id into v_player_id;

  select stars, best_score into v_prev_stars, v_prev_score
    from pengu_progress where player_id = v_player_id and level = p_level;
  v_prev_stars := coalesce(v_prev_stars, 0::smallint);
  v_prev_score := coalesce(v_prev_score, 0);

  insert into pengu_progress (player_id, level, stars, best_score, attempts, updated_at)
    values (v_player_id, p_level, greatest(v_prev_stars, p_stars), greatest(v_prev_score, p_score), 1, now())
    on conflict (player_id, level) do update set
      stars      = greatest(pengu_progress.stars, excluded.stars),
      best_score = greatest(pengu_progress.best_score, excluded.best_score),
      attempts   = pengu_progress.attempts + 1,
      updated_at = now();

  update pengu_players set
    total_stars    = coalesce((select sum(stars) from pengu_progress where player_id = v_player_id), 0),
    total_score    = coalesce((select sum(best_score) from pengu_progress where player_id = v_player_id), 0),
    highest_level  = greatest(highest_level, case when p_completed and p_stars > 0 then p_level else 0 end),
    games_played   = games_played + 1,
    updated_at     = now()
   where id = v_player_id;

  return v_player_id;
end;
$$;
