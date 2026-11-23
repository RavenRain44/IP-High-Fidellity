// microsoft-connect: connect or disconnect a Microsoft 365 / Outlook.com account (mail + calendar, read-only).
//
//   POST { action: "start", calendar_write?, return_to? }  (signed in) -> { url } to send the browser to;
//        calendar_write also asks to add events (only when the user chooses to add a meeting)
//   GET  ?code=…&state=…                                   Microsoft's redirect back here -> redirect to the app
//   POST { action: "disconnect", connection_id }           (signed in) -> deletes tokens and synced data
//
// Secrets: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY, optional APP_URL.
// Deployed with verify_jwt = false because Microsoft's redirect carries no Supabase session;
// the POST actions check the session themselves.
import { createClient } from '@supabase/supabase-js';
import { importKey } from '../_shared/crypto.ts';
import { storeTokens } from '../_shared/tokens.ts';
import { graph, MS_CALENDAR_WRITE, MS_SCOPES, msAuthUrl, msExchangeCode, msIdTokenEmail, normalizeScopes } from '../_shared/microsoft.ts';

const env = (...names: string[]) => names.map(n => Deno.env.get(n)).find(Boolean) ?? '';
const APP_URL = env('APP_URL') || 'https://lumaco-bvs.pages.dev';
const RETURN_ORIGINS = new Set([new URL(APP_URL).origin, 'http://localhost:5173', 'http://127.0.0.1:5173']);
const RETURN_PATH = '/app/integrations';
const RETURN_PATHS = new Set([RETURN_PATH, '/app']);

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
const redirectUri = `${url}/functions/v1/microsoft-connect`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method === 'GET') return callback(new URL(req.url));
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const { data: { user } } = await admin.auth.getUser((req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''));
  if (!user) return json({ error: 'Sign in required' }, 401);
  const body = await req.json().catch(() => ({}));

  if (body.action === 'start') {
    const clientId = env('MICROSOFT_CLIENT_ID');
    if (!clientId || !env('MICROSOFT_CLIENT_SECRET') || !env('TOKEN_ENCRYPTION_KEY')) {
      return json({ error: 'Microsoft connection isn’t set up on the server yet (missing Microsoft client secrets).' }, 503);
    }
    const origin = req.headers.get('Origin') ?? '';
    const path = RETURN_PATHS.has(String(body.return_to)) ? String(body.return_to) : RETURN_PATH;
    const back = (RETURN_ORIGINS.has(origin) ? origin : new URL(APP_URL).origin) + path;
    const nonce = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
    await admin.from('oauth_states').delete().eq('user_id', user.id).lt('created_at', new Date(Date.now() - 15 * 60_000).toISOString());
    // Remember whether calendar write was asked for, so the token exchange requests the same permissions.
    const { error } = await admin.from('oauth_states').insert({ nonce, user_id: user.id, provider: 'microsoft', return_path: `${back}${body.calendar_write === true ? '#write' : ''}` });
    if (error) return json({ error: 'Could not start connecting. Try again.' }, 500);
    return json({ url: msAuthUrl({ clientId, redirectUri, state: nonce, loginHint: user.email ?? undefined, calendarWrite: body.calendar_write === true }) });
  }

  if (body.action === 'disconnect') {
    const id = String(body.connection_id ?? '');
    const { data: conn } = await admin.from('integration_connections').select('id').eq('id', id).eq('user_id', user.id).eq('provider', 'microsoft').maybeSingle();
    if (!conn) return json({ error: 'Connection not found' }, 404);
    // Microsoft has no per-app token revoke for this flow; deleting the tokens ends LuMaCo's access,
    // and the user can remove the app at https://myapps.microsoft.com or account.live.com/consent/Manage.
    await admin.from('integration_connections').delete().eq('id', id);   // cascades to tokens, events, threads
    const { count } = await admin.from('integration_connections').select('id', { count: 'exact', head: true }).eq('user_id', user.id).eq('provider', 'microsoft');
    if (!count) {
      await admin.from('interactions').delete().eq('owner_id', user.id).in('source', ['outlook', 'microsoft_calendar']);
      await admin.from('promises').delete().eq('owner_id', user.id).eq('source', 'outlook').eq('status', 'suggested');
    }
    return json({ ok: true });
  }

  return json({ error: 'Unknown action' }, 400);
});

async function callback(u: URL): Promise<Response> {
  const state = u.searchParams.get('state') ?? '';
  const fallback = new URL(APP_URL).origin + RETURN_PATH;
  const { data: st } = state
    ? await admin.from('oauth_states').delete().eq('nonce', state).eq('provider', 'microsoft').select('user_id,return_path,created_at').maybeSingle()
    : { data: null };
  const [returnTo, flag] = (st?.return_path ?? fallback).split('#');
  const back = (result: Record<string, string>) => redirect(`${returnTo}?${new URLSearchParams(result)}`);
  if (!st || Date.now() - new Date(st.created_at).getTime() > 15 * 60_000) return back({ microsoft: 'error', reason: 'expired' });
  const err = u.searchParams.get('error');
  if (err) {
    // Work accounts whose IT blocks user consent come back with this.
    const needsAdmin = /admin|AADSTS65001|AADSTS90094/i.test(`${err} ${u.searchParams.get('error_description') ?? ''}`);
    return back({ microsoft: 'error', reason: err === 'access_denied' && !needsAdmin ? 'denied' : needsAdmin ? 'admin' : 'failed' });
  }

  try {
    const wantWrite = flag === 'write';
    const tokens = await msExchangeCode({
      code: u.searchParams.get('code') ?? '', clientId: env('MICROSOFT_CLIENT_ID'), clientSecret: env('MICROSOFT_CLIENT_SECRET'), redirectUri,
      scopes: [...MS_SCOPES, ...(wantWrite ? [MS_CALENDAR_WRITE] : [])],
    });
    let email = msIdTokenEmail(tokens.id_token);
    if (!email) {
      const me = await graph<{ mail?: string; userPrincipalName?: string }>(tokens.access_token, '/me?$select=mail,userPrincipalName').catch(() => null);
      email = (me?.mail || me?.userPrincipalName || '').toLowerCase() || null;
    }
    if (!email) return back({ microsoft: 'error', reason: 'no_email' });
    const granted = normalizeScopes(tokens.scope);
    if (!granted.includes('Mail.Read') && !granted.includes('Calendars.Read') && !granted.includes(MS_CALENDAR_WRITE)) return back({ microsoft: 'error', reason: 'no_scopes' });

    const { data: conn, error } = await admin.from('integration_connections').upsert({
      user_id: st.user_id, provider: 'microsoft', account_email: email, scopes: granted, status: 'connected',
      connected_at: new Date().toISOString(), last_error: null, sync_started_at: null,
    }, { onConflict: 'user_id,provider,account_email' }).select('id').single();
    if (error || !conn) throw new Error(error?.message ?? 'save failed');
    await storeTokens(admin, await importKey(env('TOKEN_ENCRYPTION_KEY')), conn.id, tokens);
    const partial = !granted.includes('Mail.Read') ? 'no_mail' : !granted.some(s => s.startsWith('Calendars.')) ? 'no_calendar' : '';
    return back({ microsoft: 'connected', ...(partial ? { partial } : {}), ...(granted.includes(MS_CALENDAR_WRITE) ? { calendar_write: '1' } : {}) });
  } catch (e) {
    console.error('microsoft-connect callback failed', e instanceof Error ? e.message : e);
    return back({ microsoft: 'error', reason: 'failed' });
  }
}
