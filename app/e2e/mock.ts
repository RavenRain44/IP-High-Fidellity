// A fake Supabase backend for browser tests: auth session, REST tables, RPCs and Edge Functions.
import type { Page, Request } from '@playwright/test';

export const ME = { id: '00000000-0000-0000-0000-00000000000a', email: 'alex@acme.test', name: 'Alex Owner' };
export const TEAM = { id: '11111111-1111-1111-1111-111111111111', name: 'Acme Mechanical' };
const SAM = '00000000-0000-0000-0000-00000000000b';
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

export type Backend = {
  tables: Record<string, unknown[]>;
  rpc: Record<string, unknown>;
  functions: Record<string, (body: any) => { status?: number; body: unknown }>;
  calls: { kind: 'rpc' | 'function' | 'rest'; name: string; method: string; body: unknown }[];
};

export function defaultBackend(): Backend {
  const contact = (id: string, full_name: string, owner_id: string, last: number, extra = {}) => ({
    id, owner_id, full_name, team_id: TEAM.id, visibility: 'team', title: null, categories: [], priority: 'Medium', starred: false, detailed: false,
    outreach_cadence_days: 14, engagement_alert_days: 60, last_outreach_at: daysAgo(last), last_engagement_at: daysAgo(last), notes: null,
    company_id: null, companies: { id: 'co1', name: 'Riverside Builders' }, contact_identities: [], created_at: daysAgo(90), updated_at: daysAgo(1), ...extra,
  });
  return {
    tables: {
      profiles: [
        { id: ME.id, email: ME.email, full_name: ME.name, avatar_url: null, onboarded_at: daysAgo(30) },
        { id: SAM, email: 'sam@acme.test', full_name: 'Sam Member', avatar_url: null, onboarded_at: daysAgo(20) },
      ],
      team_members: [
        { team_id: TEAM.id, user_id: ME.id, role: 'owner', joined_at: daysAgo(30), teams: TEAM },
        { team_id: TEAM.id, user_id: SAM, role: 'member', joined_at: daysAgo(20), teams: TEAM },
      ],
      contacts: [
        contact('c1', 'Sarah Mitchell', ME.id, 30),
        contact('c2', 'Dan Ortiz', SAM, 3),
      ],
      promises: [
        { id: 'p1', owner_id: ME.id, title: 'Send revised drawings', due_on: daysAgo(2).slice(0, 10), contact_id: 'c1', status: 'open',
          team_id: TEAM.id, visibility: 'team', direction: 'made_by_me', owner_label: 'You', created_at: daysAgo(5) },
      ],
      integration_connections: [],
    },
    rpc: {
      team_coverage: [{ user_id: ME.id, provider: 'google', mail: true, calendar: true, status: 'connected', last_synced_at: daysAgo(0), needs_reconnect: false }],
      account_deletion_preview: [{ team_id: TEAM.id, team_name: TEAM.name, my_role: 'owner', other_members: 1, successor_name: 'Sam Member', shared_records: 2 }],
      export_my_data: { format: 'Lumaco data export v1', profile: { id: ME.id, email: ME.email }, contacts: [{ full_name: 'Sarah Mitchell' }] },
      my_invites: [],
    },
    functions: {
      'account-delete': body => body?.confirm === 'DELETE' ? { body: { deleted: true, teams: [] } } : { status: 400, body: { error: 'Type DELETE to confirm' } },
    },
    calls: [],
  };
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': 'content-range',
};

function b64url(o: unknown) { return Buffer.from(JSON.stringify(o)).toString('base64url'); }

/** Installs the fake backend; with signedIn, also a stored session so the app starts signed in. */
export async function mockSupabase(page: Page, opts: { signedIn?: boolean; backend?: Backend } = {}): Promise<Backend> {
  const be = opts.backend ?? defaultBackend();
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const user = {
    id: ME.id, aud: 'authenticated', role: 'authenticated', email: ME.email, email_confirmed_at: daysAgo(30),
    app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: { full_name: ME.name },
    identities: [{ id: ME.id, user_id: ME.id, provider: 'email', identity_data: { email: ME.email } }],
    created_at: daysAgo(30), updated_at: daysAgo(1),
  };
  const token = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url({ sub: ME.id, email: ME.email, role: 'authenticated', exp })}.sig`;
  if (opts.signedIn) {
    const session = { access_token: token, refresh_token: 'test-refresh', token_type: 'bearer', expires_in: 3600, expires_at: exp, user };
    await page.addInitScript(s => localStorage.setItem('sb-mock-auth-token', s), JSON.stringify(session));
  }

  await page.route('https://mock.supabase.test/**', async route => {
    const req: Request = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(req.url());
    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      route.fulfill({ status, headers: { ...CORS, 'content-type': 'application/json', ...extra }, body: JSON.stringify(body) });
    let body: unknown = null;
    try { body = req.postDataJSON(); } catch { body = req.postData(); }

    if (url.pathname.startsWith('/auth/v1/')) {
      if (url.pathname.endsWith('/user')) return json(user);
      if (url.pathname.endsWith('/logout')) return route.fulfill({ status: 204, headers: CORS });
      return json({ error: 'not mocked' }, 400);
    }
    const fn = url.pathname.match(/^\/functions\/v1\/([\w-]+)/)?.[1];
    if (fn) {
      be.calls.push({ kind: 'function', name: fn, method: req.method(), body });
      const r = be.functions[fn]?.(body) ?? { status: 404, body: { error: `${fn} not mocked` } };
      return json(r.body, r.status ?? 200);
    }
    const rpc = url.pathname.match(/^\/rest\/v1\/rpc\/(\w+)/)?.[1];
    if (rpc) {
      be.calls.push({ kind: 'rpc', name: rpc, method: req.method(), body });
      return json(be.rpc[rpc] ?? null);
    }
    const table = url.pathname.match(/^\/rest\/v1\/(\w+)/)?.[1];
    if (table) {
      be.calls.push({ kind: 'rest', name: table, method: req.method(), body });
      let rows = (be.tables[table] ?? []) as Record<string, unknown>[];
      const idEq = url.searchParams.get('id');
      if (idEq?.startsWith('eq.')) rows = rows.filter(r => r.id === idEq.slice(3));
      const single = (req.headers()['accept'] ?? '').includes('vnd.pgrst.object');
      if (req.method() !== 'GET') return json(single ? rows[0] ?? {} : rows, req.method() === 'POST' ? 201 : 200);
      if (single) return rows.length ? json(rows[0]) : json(null);
      return json(rows, 200, { 'content-range': `0-${Math.max(rows.length - 1, 0)}/${rows.length}` });
    }
    return json({ error: 'not mocked' }, 404);
  });
  return be;
}
