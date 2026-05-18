// Validator key resolution: Deno.env VALIDATOR_PRIVATE_KEY first, then the
// shared RELAYER_PRIVATE_KEY from env / vault. Same EOA can sign all three
// roles (shop quotes, wheel rolls, level validations) — split later via
// separate vault entries + on-chain setValidatorRelayer.
import { createClient } from 'npm:@supabase/supabase-js@2';

let _relayerKey: string | null = null;
export async function getValidatorKey(): Promise<string> {
  if (_relayerKey) return _relayerKey;
  const envKey = (Deno.env.get('VALIDATOR_PRIVATE_KEY') || Deno.env.get('RELAYER_PRIVATE_KEY') || '').trim();
  if (envKey && envKey.length >= 64) { _relayerKey = envKey; return envKey; }
  const url = Deno.env.get('SUPABASE_URL');
  const srk = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !srk) throw new Error('SUPABASE_URL or SERVICE_ROLE_KEY env missing');
  const supabase = createClient(url, srk, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc('get_vault_secret', { p_name: 'RELAYER_PRIVATE_KEY' });
  if (error) throw new Error(`vault read failed: ${error.message}`);
  if (!data) throw new Error('validator/relayer key not in vault and not in env');
  _relayerKey = String(data).trim();
  return _relayerKey;
}
