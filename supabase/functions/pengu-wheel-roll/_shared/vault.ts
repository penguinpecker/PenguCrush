// Fetches the relayer key from Supabase Vault (via security-definer RPC) or
// Deno.env (dashboard secret), whichever is set. Cached in module memory.
import { createClient } from 'npm:@supabase/supabase-js@2';

let _relayerKey: string | null = null;
export async function getRelayerKey(): Promise<string> {
  if (_relayerKey) return _relayerKey;
  const envKey = (Deno.env.get('RELAYER_PRIVATE_KEY') || '').trim();
  if (envKey && envKey.length >= 64) { _relayerKey = envKey; return envKey; }
  const url = Deno.env.get('SUPABASE_URL');
  const srk = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !srk) throw new Error('SUPABASE_URL or SERVICE_ROLE_KEY env missing');
  const supabase = createClient(url, srk, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc('get_vault_secret', { p_name: 'RELAYER_PRIVATE_KEY' });
  if (error) throw new Error(`vault read failed: ${error.message}`);
  if (!data) throw new Error('RELAYER_PRIVATE_KEY not in vault and not in env');
  _relayerKey = String(data).trim();
  return _relayerKey;
}
