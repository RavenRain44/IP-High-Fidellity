// google-connect: connect or disconnect a Google account (Gmail + Calendar, read-only).
//
//   POST { action: "start" }                         (signed in) -> { url } to send the browser to
//   GET  ?code=…&state=…                             Google's redirect back here -> redirect to the app
//   POST { action: "disconnect", connection_id }     (signed in) -> revokes access and deletes synced data
//
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY, optional APP_URL.
// Deployed with verify_jwt = false because Google's redirect carries no Supabase session;
// the POST actions check the session themselves.
import { createClient } from '@supabase/supabase-js';
import { encrypt, decrypt, importKey } from '../_shared/crypto.ts';
import { authUrl, exchangeCode, idTokenEmail, revokeToken, SCOPES } from '../_shared/google.ts';

const env = (...names: string[]) => names.map(n => Deno.env.get(n)).find(Boolean) ?? '';
const APP_URL = env('APP_URL') || 'https://lumaco-bvs.pages.dev';
// Where the browser may be sent back to after connecting.
const RETURN_ORIGINS = new Set([new URL(APP_URL).origin, 'http://localhost:5173', 'http://127.0.0.1:5173']);
const RETURN_PATH = '/app/integrations';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const redirect = (to: string) => new Response(null, { status: 302, headers: { Location: to, 'Cache-Control': 'no-store' } });

const url = env('SUPABASE_URL');
const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
const redirectUri = `${url}/functions/v1/google-connect`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method === 'GET') return callback(new URL(req.url));
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const authHeader = req.headers.get('Authorization') ?? '';
  const { data: { user } } = await admin.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
  if (!user) return json({ error: 'Sign in required' }, 401);
  const body = await req.json().catch(() => ({}));

  if (body.action === 'start') {
    const clientId = env('GOOGLE_CLIENT_ID');
    if (!clientId || !env('GOOGLE_CLIENT_SECRET') || !env('TOKEN_ENCRYPTION_KEY')) {
      return json({ error: 'Google connection isn’t set up on the server yet (missing Google client or encryption secrets).' }, 503);
    }
    const origin = req.headers.get('Origin') ?? '';
    const back = (RETURN_ORIGINS.has(origin) ? origin : new URL(APP_URL).origin) + RETURN_PATH;
    const nonce = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
    // Clear this user's abandoned attempts, then remember this one.
    await admin.from('oauth_states').delete().eq('user_id', user.id).lt('created_at', new Date(Date.now() - 15 * 60_000).toISOString());
    const { error } = await admin.from('oauth_states').insert({ nonce, user_id: user.id, provider: 'google', return_path: back });
    if (error) return json({ error: 'Could not start connecting. Try again.' }, 500);
    return json({ url: authUrl({ clientId, redirectUri, state: nonce, loginHint: user.email ?? undefined }) });
  }

  if (body.action === 'disconnect') {
    const id = String(body.connection_id ?? '');
    const { data: conn } = await admin.from('integration_connections').select('id').eq('id', id).eq('user_id', user.id).eq('provider', 'google').maybeSingle();
    if (!conn) return json({ error: 'Connection not found' }, 404);
    const { data: secret } = await admin.from('integration_secrets').select('refresh_token').eq('connection_id', id).maybeSingle();
    if (secret?.refresh_token && env('TOKEN_ENCRYPTION_KEY')) {
      try { await revokeToken(await decrypt(await importKey(env('TOKEN_ENCRYPTION_KEY')), secret.refresh_token)); } catch { /* already revoked */ }
    }
    // Cascades to the tokens, synced calendar events and email threads.
    await admin.from('integration_connections').delete().eq('id', id);
    // Timeline entries and suggestions from Google, unless another Google account is still connected.
    const { count } = await admin.from('integration_connections').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('provider', 'google');
    if (count) return json({ ok: true });
    await admin.from('interactions').delete().eq('owner_id', user.id).in('source', ['gmail', 'google_calendar']);
    await admin.from('promises').delete().eq('owner_id', user.id).eq('source', 'gmail').eq('status', 'suggested');
    return json({ ok: true });
  }

  return json({ error: 'Unknown action' }, 400);
});

async function callback(u: URL): Promise<Response> {
  const state = u.searchParams.get('state') ?? '';
  const fallback = new URL(APP_URL).origin + RETURN_PATH;
  const { data: st } = state
    ? await admin.from('oauth_states').delete().eq('nonce', state).eq('provider', 'google').select('user_id,return_path,created_at').maybeSingle()
    : { data: null };
  const back = (result: Record<string, string>) => redirect(`${st?.return_path ?? fallback}?${new URLSearchParams(result)}`);
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return back({ google: 'error', reason: 'expired' });
  if (u.searchParams.get('error')) return back({ google: 'error', reason: u.searchParams.get('error') === 'access_denied' ? 'denied' : 'failed' });

  try {
    const tokens = await exchangeCode({ code: u.searchParams.get('code') ?? '', clientId: env('GOOGLE_CLIENT_ID'), clientSecret: env('GOOGLE_CLIENT_SECRET'), redirectUri });
    const email = idTokenEmail(tokens.id_token);
    if (!email) return back({ google: 'error', reason: 'no_email' });
    const granted = (tokens.scope ?? '').split(' ');
    const scopes = SCOPES.filter(s => granted.includes(s) || s === 'openid' || s === 'email');
    if (!granted.some(s => s.endsWith('/gmail.readonly') || s.endsWith('/calendar.readonly'))) return back({ google: 'error', reason: 'no_scopes' });

    const key = await importKey(env('TOKEN_ENCRYPTION_KEY'));
    const { data: conn, error } = await admin.from('integration_connections').upsert({
      user_id: st.user_id, provider: 'google', account_email: email.toLowerCase(), scopes, status: 'connected',
      connected_at: new Date().toISOString(), last_error: null, sync_started_at: null,
    }, { onConflict: 'user_id,provider,account_email' }).select('id').single();
    if (error || !conn) throw new Error(error?.message ?? 'save failed');
    const secret: Record<string, unknown> = {
      connection_id: conn.id,
      access_token: await encrypt(key, tokens.access_token),
      expires_at: new Date(Date.now() + (tokens.expires_in - 60) * 1000).toISOString(),
      updated_at: new Date().toISOString(),
    };
    if (tokens.refresh_token) secret.refresh_token = await encrypt(key, tokens.refresh_token);
    const { error: sErr } = await admin.from('integration_secrets').upsert(secret, { onConflict: 'connection_id' });
    if (sErr) throw new Error(sErr.message);
    const partial = !granted.some(s => s.endsWith('/gmail.readonly')) ? 'no_gmail' : !granted.some(s => s.endsWith('/calendar.readonly')) ? 'no_calendar' : '';
    return back({ google: 'connected', ...(partial ? { partial } : {}) });
  } catch (e) {
    console.error('google-connect callback failed', e instanceof Error ? e.message : e);
    return back({ google: 'error', reason: 'failed' });
  }
}
