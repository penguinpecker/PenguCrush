// Vault helpers for pengu-regen-sweep.
//
// Two secrets:
//   RELAYER_PRIVATE_KEY — signs the claimRegenBatch tx (also resolvable via
//                        Deno.env LIFE_REGEN_RELAYER_PK or RELAYER_PRIVATE_KEY)
//   CRON_SECRET         — shared secret pg_cron passes in x-cron-secret header
//
// Both fetched on demand and cached for the Deno isolate lifetime.

import { createClient } from 'npm:@supabase/supabase-js@2';

let _relayerKey: string | null = null;
let _cronSecret: string | null = null;

async function fetchVault(name: string): Promise<string | null> {
  const url = Deno.env.get('SUPABASE_URL');
  const srk = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !srk) throw new Error('SUPABASE_URL or SERVICE_ROLE_KEY env missing');
  const supabase = createClient(url, srk, { auth: { persistSession: false } });
  const { data, error } = await supabase.rpc('get_vault_secret', { p_name: name });
  if (error) throw new Error(`vault read failed: ${error.message}`);
  return data ? String(data).trim() : null;
}

export async function getRelayerKey(): Promise<string> {
  if (_relayerKey) return _relayerKey;
  const envKey = (Deno.env.get('LIFE_REGEN_RELAYER_PK') || Deno.env.get('RELAYER_PRIVATE_KEY') || '').trim();
  if (envKey && envKey.length >= 64) { _relayerKey = envKey; return envKey; }
  const v = await fetchVault('RELAYER_PRIVATE_KEY');
  if (!v) throw new Error('relayer key not in vault and not in env');
  _relayerKey = v;
  return v;
}

export async function getCronSecret(): Promise<string> {
  if (_cronSecret) return _cronSecret;
  const v = await fetchVault('CRON_SECRET');
  if (!v) throw new Error('CRON_SECRET not in vault');
  _cronSecret = v;
  return v;
}

/** Constant-time string compare to avoid timing leaks. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
