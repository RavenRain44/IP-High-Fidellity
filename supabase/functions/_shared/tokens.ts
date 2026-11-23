// Access tokens for a stored connection: decrypt, refresh when expired, and save what comes back.
// Microsoft issues a new refresh token on every refresh, so a returned one always replaces the old.
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt } from './crypto.ts';
import type { TokenResponse } from './provider.ts';

export async function accessToken(admin: SupabaseClient, key: CryptoKey, connectionId: string,
  refresh: (refreshToken: string) => Promise<TokenResponse>, onMissing: () => Error): Promise<string> {
  const { data: s } = await admin.from('integration_secrets').select('access_token,refresh_token,expires_at').eq('connection_id', connectionId).single();
  if (s?.access_token && s.expires_at && new Date(s.expires_at).getTime() > Date.now() + 60_000) return decrypt(key, s.access_token);
  if (!s?.refresh_token) throw onMissing();
  const t = await refresh(await decrypt(key, s.refresh_token));
  await admin.from('integration_secrets').update({
    access_token: await encrypt(key, t.access_token),
    expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    ...(t.refresh_token ? { refresh_token: await encrypt(key, t.refresh_token) } : {}),
    updated_at: new Date().toISOString(),
  }).eq('connection_id', connectionId);
  return t.access_token;
}

/** Saves tokens from a fresh sign-in. */
export async function storeTokens(admin: SupabaseClient, key: CryptoKey, connectionId: string, t: TokenResponse) {
  const row: Record<string, unknown> = {
    connection_id: connectionId,
    access_token: await encrypt(key, t.access_token),
    expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (t.refresh_token) row.refresh_token = await encrypt(key, t.refresh_token);
  const { error } = await admin.from('integration_secrets').upsert(row, { onConflict: 'connection_id' });
  if (error) throw new Error(error.message);
}
