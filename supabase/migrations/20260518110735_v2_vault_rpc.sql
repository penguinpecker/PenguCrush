-- Security-definer RPC that wraps vault.decrypted_secrets, callable only by
-- service_role. Lets edge functions fetch the RELAYER_PRIVATE_KEY without
-- exposing the entire `vault` schema through PostgREST.

create or replace function public.get_vault_secret(p_name text)
returns text
language plpgsql
security definer
set search_path = vault, public
as $$
declare
  v_value text;
begin
  select decrypted_secret into v_value
    from vault.decrypted_secrets
   where name = p_name
   limit 1;
  return v_value;
end $$;

revoke all on function public.get_vault_secret(text) from public;
revoke all on function public.get_vault_secret(text) from anon;
revoke all on function public.get_vault_secret(text) from authenticated;
grant execute on function public.get_vault_secret(text) to service_role;
