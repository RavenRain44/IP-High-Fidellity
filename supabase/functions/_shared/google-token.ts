// Access tokens for a stored Google connection: decrypts, refreshes when expired, re-saves.
import type { SupabaseClient } from '@supabase/supabase-js';
import { decrypt, encrypt } from './crypto.ts';
import { GoogleError, refreshAccessToken } from './google.ts';

export async function googleAccessToken(admin: SupabaseClient, key: CryptoKey, connectionId: string,
  client: { id: string; secret: string }): Promise<string> {
  const { data: s } = await admin.from('integration_secrets').select('access_token,refresh_token,expires_at').eq('connection_id', connectionId).single();
  if (s?.access_token && s.expires_at && new Date(s.expires_at).getTime() > Date.now() + 60_000) return decrypt(key, s.access_token);
  if (!s?.refresh_token) throw new GoogleError('No refresh token', 401, 'invalid_grant');
  const t = await refreshAccessToken({ refreshToken: await decrypt(key, s.refresh_token), clientId: client.id, clientSecret: client.secret });
  await admin.from('integration_secrets').update({
    access_token: await encrypt(key, t.access_token),
    expires_at: new Date(Date.now() + (t.expires_in - 60) * 1000).toISOString(),
    ...(t.refresh_token ? { refresh_token: await encrypt(key, t.refresh_token) } : {}),
    updated_at: new Date().toISOString(),
  }).eq('connection_id', connectionId);
  return t.access_token;
}
