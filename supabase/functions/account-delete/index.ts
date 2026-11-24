// account-delete: permanently delete the signed-in user's account.
//
// POST { confirm: "DELETE" } with the user's session token.
//   1. Revokes Google access for connected accounts (Microsoft has no per-app revoke; deleting the
//      tokens ends Lumaco's access).
//   2. prepare_account_deletion(): team-shared records pass to each team's owner; a team the user
//      owned gets a new owner, or is deleted if nobody else is in it.
//   3. Deletes the user's recordings from storage.
//   4. Deletes the auth user, which cascades every remaining row they own.
import { createClient } from '@supabase/supabase-js';
import { decrypt, importKey } from '../_shared/crypto.ts';
import { revokeToken } from '../_shared/google.ts';
import { logError } from '../_shared/log-error.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const env = (...names: string[]) => names.map(n => Deno.env.get(n)).find(Boolean) ?? '';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Sign in required' }, 401);
  const url = env('SUPABASE_URL');
  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
  const { data: { user } } = await admin.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
  if (!user) return json({ error: 'Sign in required' }, 401);

  const body = await req.json().catch(() => ({}));
  if (body?.confirm !== 'DELETE') return json({ error: 'Type DELETE to confirm' }, 400);

  try {
    // 1. Revoke Google access (best effort).
    const keyText = env('TOKEN_ENCRYPTION_KEY');
    const { data: conns } = await admin.from('integration_connections').select('id,provider').eq('user_id', user.id);
    if (keyText) {
      const key = await importKey(keyText);
      for (const c of (conns ?? []).filter(c => c.provider === 'google')) {
        const { data: s } = await admin.from('integration_secrets').select('refresh_token').eq('connection_id', c.id).maybeSingle();
        if (s?.refresh_token) { try { await revokeToken(await decrypt(key, s.refresh_token)); } catch { /* already revoked */ } }
      }
    }

    // 2. Hand shared records to each team and settle team ownership.
    const { data: teams, error: prepError } = await admin.rpc('prepare_account_deletion', { p_user: user.id });
    if (prepError) throw new Error(prepError.message);

    // 3. Recordings: everything under recordings/<user id>/.
    let removed = 0;
    for (;;) {
      const { data: files, error } = await admin.storage.from('recordings').list(user.id, { limit: 1000 });
      if (error) throw new Error(error.message);
      if (!files?.length) break;
      const { error: rmError } = await admin.storage.from('recordings').remove(files.map(f => `${user.id}/${f.name}`));
      if (rmError) throw new Error(rmError.message);
      removed += files.length;
      if (files.length < 1000) break;
    }

    // 4. The account itself; every remaining row cascades.
    const { error: delError } = await admin.auth.admin.deleteUser(user.id);
    if (delError) throw new Error(delError.message);

    return json({ deleted: true, recordings_removed: removed, teams });
  } catch (err) {
    console.error('account-delete failed', err instanceof Error ? err.message : err);
    await logError(admin, 'account-delete', err, user.id);
    return json({ error: 'Your account couldn’t be deleted completely. Please try again in a minute.' }, 500);
  }
});
