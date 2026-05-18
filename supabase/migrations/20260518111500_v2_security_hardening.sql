-- (See also: 20260518120000_v2_tx_log.sql for the tx_log mirror.)
--
-- ═══════════════════════════════════════════════════════════════
-- V2 security hardening — audit fixes #2, #3, #5
--   #2 pengu_players + pengu_progress + rpc_upsert_player_progress:
--      canonical wallet regex, sane numeric bounds, revoke anon
--   #3 pengu_game_snapshots: wallet format + per-wallet row cap
--   #5 CRON_SECRET in Vault + signed pg_cron call for regen-sweep
--
-- NOTE: the CRON_SECRET vault.create_secret call lives only in the
-- remotely-applied migration version of this file. The plain SQL here
-- intentionally omits the secret value so the migration file is safe to
-- commit. Re-running this migration against a fresh project requires
-- inserting the secret separately.
-- ═══════════════════════════════════════════════════════════════

-- ─── #2: wallet_address must be canonical 0x + 40 hex ──────────
alter table pengu_players
  drop constraint if exists pengu_players_wallet_format;
alter table pengu_players
  add constraint pengu_players_wallet_format
  check (wallet_address ~ '^0x[a-f0-9]{40}$');

-- ─── #2: tighten the RPC and revoke from anon ──────────────────
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
  v_norm_wallet text;
begin
  v_norm_wallet := lower(p_wallet);
  if v_norm_wallet !~ '^0x[a-f0-9]{40}$' then
    raise exception 'bad wallet format';
  end if;
  if p_level is null or p_level < 1 or p_level > 1000 then
    raise exception 'level out of range';
  end if;
  if p_score is null or p_score < 0 or p_score > 1000000000 then
    raise exception 'score out of range';
  end if;
  if p_stars is null or p_stars < 0 or p_stars > 3 then
    raise exception 'stars out of range';
  end if;
  if p_moves_used is null or p_moves_used < 0 or p_moves_used > 1000 then
    raise exception 'moves out of range';
  end if;

  insert into pengu_players (wallet_address)
    values (v_norm_wallet)
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

revoke all on function public.rpc_upsert_player_progress(text, smallint, integer, smallint, smallint, boolean) from public;
revoke all on function public.rpc_upsert_player_progress(text, smallint, integer, smallint, smallint, boolean) from anon;
revoke all on function public.rpc_upsert_player_progress(text, smallint, integer, smallint, smallint, boolean) from authenticated;
grant execute on function public.rpc_upsert_player_progress(text, smallint, integer, smallint, smallint, boolean) to service_role;

-- ─── #3: snapshot wallet format + per-wallet cap ───────────────
alter table pengu_game_snapshots
  drop constraint if exists pengu_snapshots_wallet_format;
alter table pengu_game_snapshots
  add constraint pengu_snapshots_wallet_format
  check (wallet ~ '^0x[a-f0-9]{40}$');

create or replace function _pengu_snapshots_cap_check()
returns trigger language plpgsql as $$
declare v_count int;
begin
  select count(*) into v_count
    from pengu_game_snapshots
   where wallet = lower(new.wallet);
  if v_count >= 30 then
    raise exception 'snapshot cap reached for wallet';
  end if;
  return new;
end $$;

drop trigger if exists pengu_snapshots_cap on pengu_game_snapshots;
create trigger pengu_snapshots_cap
  before insert on pengu_game_snapshots
  for each row execute function _pengu_snapshots_cap_check();

drop policy if exists "anon write snapshots" on pengu_game_snapshots;
create policy "anon write snapshots" on pengu_game_snapshots
  for insert with check (wallet ~ '^0x[a-f0-9]{40}$');

drop policy if exists "anon update snapshots" on pengu_game_snapshots;
create policy "anon update snapshots" on pengu_game_snapshots
  for update using (wallet ~ '^0x[a-f0-9]{40}$');

drop policy if exists "anon delete snapshots" on pengu_game_snapshots;
create policy "anon delete snapshots" on pengu_game_snapshots
  for delete using (wallet ~ '^0x[a-f0-9]{40}$');

-- ─── #5: signed pg_cron call to pengu-regen-sweep ──────────────
-- The actual CRON_SECRET value is inserted into vault.secrets out-of-band
-- (not in this committed migration). Re-running this migration against a
-- fresh project needs:
--   select vault.create_secret('<32-byte-hex>', 'CRON_SECRET', 'cron→regen-sweep');
do $$
declare v_secret text;
begin
  select decrypted_secret into v_secret
    from vault.decrypted_secrets where name = 'CRON_SECRET';
  if v_secret is null then
    raise notice 'CRON_SECRET not in vault — cron schedule not updated. Insert via vault.create_secret and re-run.';
    return;
  end if;
  begin perform cron.unschedule('pengu-regen-sweep-hourly'); exception when others then null; end;
  perform cron.schedule(
    'pengu-regen-sweep-hourly',
    '7 * * * *',
    format($cmd$
      select net.http_post(
        url := 'https://saftqlwxmdqxzfuwdgtu.supabase.co/functions/v1/pengu-regen-sweep',
        headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', %L),
        body := '{}'::jsonb
      );
    $cmd$, v_secret)
  );
end $$;
