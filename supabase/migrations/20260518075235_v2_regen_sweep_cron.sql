-- Schedule pengu-regen-sweep hourly so offline players still see
-- LifeRegenerated events fire as their 8h ticks accrue.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

do $$
begin
  perform cron.unschedule('pengu-regen-sweep-hourly');
exception when others then null;
end $$;

select cron.schedule(
  'pengu-regen-sweep-hourly',
  '7 * * * *',
  $$
    select net.http_post(
      url := 'https://saftqlwxmdqxzfuwdgtu.supabase.co/functions/v1/pengu-regen-sweep',
      headers := jsonb_build_object('content-type', 'application/json'),
      body := '{}'::jsonb
    );
  $$
);
