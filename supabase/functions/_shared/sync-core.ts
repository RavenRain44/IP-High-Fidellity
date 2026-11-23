// Syncs every email/calendar account the signed-in user connected (Google and Microsoft).
//
// POST { time_zone? } with the user's session token: syncs that user's accounts.
// POST { scheduled: true } with header x-sync-secret = SYNC_CRON_SECRET: the database's timer
//   (pg_cron, every 10 minutes) asking to sync every account not synced in the last ~30 minutes,
//   for all users, as many as fit in one run. Each user's contacts are read with their own
//   sharing rules (sync_contacts_for), exactly as when they're signed in.
// For each account:
//   * Calendar: events from 30 days ago to 45 days ahead, matched to approved contacts by email.
//     Past meetings with contacts go on their timelines.
//   * Mail: only messages to/from approved contacts' saved addresses (the provider's search does the
//     filtering, so other mail is never downloaded). Threads waiting on your reply surface in Needs
//     Attention; one AI pass suggests promises and meetings for you to confirm.
// Secrets: TOKEN_ENCRYPTION_KEY; GOOGLE_CLIENT_ID/SECRET and/or MICROSOFT_CLIENT_ID/SECRET;
// ANTHROPIC_API_KEY (optional: without it the promise/meeting check is off).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { importKey } from './crypto.ts';
import { accessToken } from './tokens.ts';
import { googleAdapter } from './google.ts';
import { microsoftAdapter } from './microsoft.ts';
import { buildContactIndex, foldThread, type ContactIndex, type ThreadState } from './mail-common.ts';
import { needsReconnect, ProviderError, type Adapter, type NormMessage, type ProviderId } from './provider.ts';
import {
  alreadyOnCalendar, analyzeEmails, buildEmailPrompt, sanitizeEmailMeetings, sanitizeEmailPromises, type EmailForReview,
} from './email-insights.ts';

export const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
export const env = (...names: string[]) => names.map(n => Deno.env.get(n)).find(Boolean) ?? '';

/** The adapter for a provider, or null when its client ID/secret aren't set on the server. */
export function adapterFor(provider: string): Adapter | null {
  const id = env(provider === 'google' ? 'GOOGLE_CLIENT_ID' : 'MICROSOFT_CLIENT_ID');
  const secret = env(provider === 'google' ? 'GOOGLE_CLIENT_SECRET' : 'MICROSOFT_CLIENT_SECRET');
  if (!id || !secret) return null;
  return provider === 'google' ? googleAdapter({ id, secret }) : provider === 'microsoft' ? microsoftAdapter({ id, secret }) : null;
}

/** A valid IANA zone name, or null. */
export function validZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || tz.length > 64) return null;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return null; }
}

const DAY = 86_400_000;
const MAX_MESSAGES = 150;       // per sync; later syncs pick up the rest
const MAX_CHECK_EMAILS = 25;    // newest new emails checked for promises and meetings per sync

type Conn = { id: string; provider: ProviderId; account_email: string; scopes: string[]; last_synced_at: string | null; time_zone: string | null };
// userDb is the signed-in user's own client; null for scheduled runs, which use server-only paths
// that apply the same rules (sync_contacts_for, and owner-only contact updates).
type Ctx = { userId: string; userName: string | null; userDb: SupabaseClient | null; admin: SupabaseClient; key: CryptoKey; anthropic: Anthropic | null; browserZone: string | null };

export async function syncHandler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const cronSecret = req.headers.get('x-sync-secret');
  if (cronSecret !== null) {
    if (!env('SYNC_CRON_SECRET') || !sameSecret(cronSecret, env('SYNC_CRON_SECRET'))) return json({ error: 'Forbidden' }, 403);
    return scheduledSync();
  }
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Sign in required' }, 401);

  const url = env('SUPABASE_URL');
  const userDb = createClient(url, env('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'), { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: { user } } = await userDb.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
  if (!user) return json({ error: 'Sign in required' }, 401);
  if (!env('TOKEN_ENCRYPTION_KEY')) return json({ error: 'Account sync isn’t set up on the server yet.' }, 503);
  const body = await req.json().catch(() => ({}));

  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
  const { data: conns } = await admin.from('integration_connections').select('id,provider,account_email,scopes,last_synced_at,time_zone')
    .eq('user_id', user.id).in('provider', ['google', 'microsoft']).neq('status', 'revoked');
  if (!conns?.length) return json({ results: [] });

  const { data: profile } = await userDb.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const ctx: Ctx = {
    userId: user.id, userName: profile?.full_name ?? null, userDb, admin,
    key: await importKey(env('TOKEN_ENCRYPTION_KEY')),
    anthropic: env('ANTHROPIC_API_KEY') ? new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') }) : null,
    browserZone: validZone(body.time_zone),
  };
  const results = [];
  for (const c of conns as Conn[]) {
    const adapter = adapterFor(c.provider);
    results.push(adapter ? await syncConnection(ctx, c, adapter)
      : { provider: c.provider, email: c.account_email, error: `${c.provider === 'google' ? 'Google' : 'Microsoft'} isn’t set up on the server yet.` });
  }
  return json({ results });
}

/** Constant-time string comparison for the scheduler's secret. */
function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const SCHEDULE_EVERY_MS = 28 * 60_000;   // with the 10-minute timer: each account about every 30 minutes
const SCHEDULE_BUDGET_MS = 100_000;      // stop starting new accounts after this; the next run continues

/** One scheduled run: the accounts most overdue first, until the time budget is used. */
async function scheduledSync(): Promise<Response> {
  if (!env('TOKEN_ENCRYPTION_KEY')) return json({ error: 'Account sync isn’t set up on the server yet.' }, 503);
  const started = Date.now();
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
  const cutoff = new Date(started - SCHEDULE_EVERY_MS).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const { data: due, error } = await admin.from('integration_connections')
    .select('id,user_id,provider,account_email,scopes,last_synced_at,time_zone,last_error')
    .in('provider', ['google', 'microsoft']).neq('status', 'revoked')
    .or(`last_synced_at.is.null,last_synced_at.lt.${cutoff}`)
    .order('last_synced_at', { ascending: true, nullsFirst: true }).limit(100);
  if (error) return json({ error: 'Could not list accounts.' }, 500);
  // Accounts that need the user to reconnect would only fail again.
  const todo = (due ?? []).filter(c => !/reconnect/i.test(c.last_error ?? ''));

  const key = await importKey(env('TOKEN_ENCRYPTION_KEY'));
  const anthropic = env('ANTHROPIC_API_KEY') ? new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') }) : null;
  const ctxs = new Map<string, Ctx>();
  let synced = 0, failed = 0, skipped = 0;
  for (const c of todo) {
    if (Date.now() - started > SCHEDULE_BUDGET_MS) break;
    const adapter = adapterFor(c.provider);
    if (!adapter) { skipped++; continue; }
    let ctx = ctxs.get(c.user_id);
    if (!ctx) {
      const { data: profile } = await admin.from('profiles').select('full_name').eq('id', c.user_id).maybeSingle();
      ctx = { userId: c.user_id, userName: profile?.full_name ?? null, userDb: null, admin, key, anthropic, browserZone: null };
      ctxs.set(c.user_id, ctx);
    }
    const r = await syncConnection(ctx, c as Conn, adapter);
    if ('skipped' in r) skipped++; else if ('error' in r && r.error) failed++; else synced++;
  }
  return json({ due: todo.length, synced, failed, skipped, left: todo.length - synced - failed - skipped });
}

async function syncConnection(ctx: Ctx, conn: Conn, a: Adapter) {
  const { admin } = ctx;
  const runStart = new Date();
  const base = { provider: a.id, email: conn.account_email };
  // Take the lock unless another sync started in the last 3 minutes.
  const { data: locked } = await admin.from('integration_connections')
    .update({ status: 'syncing', sync_started_at: runStart.toISOString() })
    .eq('id', conn.id)
    .or(`sync_started_at.is.null,sync_started_at.lt.${new Date(runStart.getTime() - 3 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')}`)
    .select('id');
  if (!locked?.length) return { ...base, skipped: 'already syncing' };

  try {
    const token = await accessToken(admin, ctx.key, conn.id, a.refresh, () => new ProviderError('No refresh token', 401, 'invalid_grant'));
    const contacts = await readContacts(ctx);
    const idx = buildContactIndex(contacts ?? []);
    // Addresses saved since the last sync get their past 30 days of email, not just new mail.
    const added = new Set((contacts ?? []).flatMap(c => (c.contact_identities ?? [])
      .filter(i => i.kind === 'email' && (!conn.last_synced_at || new Date(i.created_at) > new Date(conn.last_synced_at)))
      .map(i => i.value.trim().toLowerCase())));

    // Time zone for reading "Tuesday at 2" in email: the calendar's own, else the browser's, else the last known.
    const timeZone = (a.canReadCalendar(conn.scopes) ? await a.timeZone(token) : null) ?? ctx.browserZone ?? conn.time_zone ?? 'UTC';

    const cal = a.canReadCalendar(conn.scopes) ? await syncCalendar(ctx, conn, a, token, idx, runStart) : null;
    const mail = a.canReadMail(conn.scopes) ? await syncMail(ctx, conn, a, token, idx, added, runStart, timeZone) : null;
    await admin.from('integration_connections').update({
      status: 'connected', last_synced_at: runStart.toISOString(), last_error: null, sync_started_at: null, time_zone: timeZone,
      // Only replace the last check's result when this sync actually checked something.
      ...(mail?.check.note ? { last_check: mail.check.note } : {}),
    }).eq('id', conn.id);
    return {
      ...base, events: cal?.events ?? null, messages: mail?.messages ?? null, threads: mail?.threads ?? null,
      suggestions: mail?.check.promises ?? null, meetings: mail?.check.meetings ?? null, checked: mail?.check.checked ?? null,
      check_error: mail?.check.error, warning: mail?.warning,
    };
  } catch (e) {
    const message = needsReconnect(e) ? `${a.name} access expired or was removed. Reconnect this account.`
      : e instanceof ProviderError && e.code === 'api_disabled' ? e.message
      : e instanceof ProviderError && e.status === 403 ? `${a.name} refused access. Your organization may need to approve LuMaCo, or reconnect and allow access.`
      : 'Sync failed. It will try again next time.';
    console.error('sync failed', a.id, conn.id, e instanceof Error ? e.message : e);
    await admin.from('integration_connections').update({ status: 'error', last_error: message, sync_started_at: null }).eq('id', conn.id);
    return { ...base, error: message };
  }
}

/** Inserts timeline entries that aren't there yet (the unique index is partial, so no upsert). */
async function addInteractions(ctx: Ctx, source: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return 0;
  const refs = rows.map(r => r.source_ref as string);
  const known = new Set<string>();
  for (let i = 0; i < refs.length; i += 100) {
    const { data } = await ctx.admin.from('interactions').select('source_ref').eq('owner_id', ctx.userId).eq('source', source).in('source_ref', refs.slice(i, i + 100));
    (data ?? []).forEach(d => known.add(d.source_ref));
  }
  const fresh = rows.filter(r => !known.has(r.source_ref as string)).map(r => ({ ...r, owner_id: ctx.userId, team_id: null, visibility: 'private', source }));
  for (let i = 0; i < fresh.length; i += 200) await ctx.admin.from('interactions').insert(fresh.slice(i, i + 200));
  return fresh.length;
}

type ContactRow = { id: string; contact_identities: { kind: string; value: string; created_at: string }[] };
/** The contacts the user can see (theirs and ones shared with them), with their addresses. */
async function readContacts(ctx: Ctx): Promise<ContactRow[]> {
  if (ctx.userDb) {
    const { data, error } = await ctx.userDb.from('contacts').select('id,contact_identities(kind,value,created_at)').limit(5000);
    if (error) throw new Error(`contacts: ${error.message}`);
    return (data ?? []) as ContactRow[];
  }
  const { data, error } = await ctx.admin.rpc('sync_contacts_for', { p_user: ctx.userId });
  if (error) throw new Error(`contacts: ${error.message}`);
  return ((data ?? []) as { contact_id: string; identities: ContactRow['contact_identities'] }[])
    .map(r => ({ id: r.contact_id, contact_identities: r.identities ?? [] }));
}

/** Moves a contact's last outreach / engagement forward. Only contacts the user owns, as with their own permissions. */
async function bumpContacts(ctx: Ctx, field: 'last_outreach_at' | 'last_engagement_at', latest: Map<string, string>) {
  for (const [id, at] of latest) {
    const iso = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const q = ctx.userDb ? ctx.userDb.from('contacts').update({ [field]: iso }) : ctx.admin.from('contacts').update({ [field]: iso }).eq('owner_id', ctx.userId);
    await q.eq('id', id).or(`${field}.is.null,${field}.lt.${iso}`);
  }
}

// ---------------------------------------------------------------------------------------
async function syncCalendar(ctx: Ctx, conn: Conn, a: Adapter, token: string, idx: ContactIndex, runStart: Date) {
  const from = new Date(runStart.getTime() - 30 * DAY), to = new Date(runStart.getTime() + 45 * DAY);
  const rows = (await a.events(token, from, to, idx))
    .map(e => ({ ...e, owner_id: ctx.userId, connection_id: conn.id, synced_at: runStart.toISOString() }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await ctx.admin.from('calendar_events').upsert(rows.slice(i, i + 200), { onConflict: 'connection_id,source_ref' });
    if (error) throw new Error(error.message);
  }
  // Events deleted or cancelled since the last sync.
  await ctx.admin.from('calendar_events').delete().eq('connection_id', conn.id).gte('starts_at', from.toISOString()).lt('starts_at', to.toISOString()).lt('synced_at', runStart.toISOString());

  // Meetings with contacts that already happened go on the contacts' timelines.
  const now = runStart.getTime();
  const past = rows.filter(r => r.contact_ids.length && new Date(r.ends_at ?? r.starts_at).getTime() < now && r.my_response !== 'declined' && !r.all_day);
  const latest = new Map<string, string>();
  const timeline = past.flatMap(r => r.contact_ids.map(cid => {
    if ((latest.get(cid) ?? '') < r.starts_at) latest.set(cid, r.starts_at);
    const mins = r.ends_at ? Math.round((new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()) / 60_000) : null;
    return { contact_id: cid, kind: 'calendar', direction: null, occurred_at: r.starts_at, title: r.title, summary: r.location ? `Calendar meeting · ${r.location}` : 'Calendar meeting', source_ref: `${r.source_ref}:${cid}`, duration_sec: mins ? mins * 60 : null, qualifies_engagement: true };
  }));
  await addInteractions(ctx, a.calendarSource, timeline);
  await bumpContacts(ctx, 'last_engagement_at', latest);
  return { events: rows.length };
}

// ---------------------------------------------------------------------------------------
async function syncMail(ctx: Ctx, conn: Conn, a: Adapter, token: string, idx: ContactIndex, added: Set<string>, runStart: Date, timeZone: string) {
  const emails = [...idx.keys()];
  if (!emails.length) return { messages: 0, threads: 0, check: NO_CHECK, warning: 'Add email addresses to your contacts to see their emails here.' };
  const backfillAfter = new Date(runStart.getTime() - 30 * DAY);
  const recentAfter = conn.last_synced_at ? new Date(new Date(conn.last_synced_at).getTime() - 2 * 3600_000) : backfillAfter;
  const recent = emails.filter(e => !added.has(e)), backfill = emails.filter(e => added.has(e));
  const since = backfill.length ? backfillAfter : recentAfter;

  // Messages already on the timeline aren't downloaded again.
  const skip = new Set<string>();
  const { data: seen } = await ctx.admin.from('interactions').select('source_ref').eq('owner_id', ctx.userId).eq('source', a.mailSource).gte('occurred_at', since.toISOString()).limit(5000);
  (seen ?? []).forEach(s => skip.add(String(s.source_ref).replace(/:[0-9a-f-]{36}$/, '')));

  const { messages: parsed, more } = await a.messages(token, { recent, recentAfter, backfill, backfillAfter, skip, cap: MAX_MESSAGES, account: conn.account_email, idx });
  const warning = more ? 'More email to catch up on next sync.' : undefined;
  if (!parsed.length) return { messages: 0, threads: 0, check: NO_CHECK, warning };

  // Threads: fold new messages into what we already know.
  const byThread = new Map<string, NormMessage[]>();
  parsed.forEach(m => byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]));
  const threadIds = [...byThread.keys()];
  const prev = new Map<string, ThreadState>();
  for (let i = 0; i < threadIds.length; i += 100) {
    const { data } = await ctx.admin.from('email_threads').select('thread_id,last_message_at,message_count,dismissed_at,contact_ids')
      .eq('connection_id', conn.id).in('thread_id', threadIds.slice(i, i + 100));
    (data ?? []).forEach(t => prev.set(t.thread_id, t as ThreadState));
  }
  const threadRows = [...byThread].map(([tid, msgs]) => {
    const { newer, row } = foldThread(prev.get(tid) ?? null, msgs);
    const latest = [...msgs].sort((x, y) => y.at.localeCompare(x.at))[0];
    return { owner_id: ctx.userId, connection_id: conn.id, thread_id: tid, synced_at: runStart.toISOString(), ...row,
      ...(newer || !prev.has(tid) ? { web_link: latest.link } : {}) };
  });
  // New threads need every column; existing ones may only update some.
  const fresh = threadRows.filter(t => !prev.has(t.thread_id));
  const updates = threadRows.filter(t => prev.has(t.thread_id));
  if (fresh.length) { const { error } = await ctx.admin.from('email_threads').insert(fresh); if (error) throw new Error(error.message); }
  for (const t of updates) await ctx.admin.from('email_threads').update(t).eq('connection_id', conn.id).eq('thread_id', t.thread_id);

  // Timeline entries and last outreach / engagement.
  const outreach = new Map<string, string>(), engagement = new Map<string, string>();
  const timeline = parsed.flatMap(m => m.contactIds.map(cid => {
    const map = m.direction === 'outbound' ? outreach : engagement;
    if ((map.get(cid) ?? '') < m.at) map.set(cid, m.at);
    return { contact_id: cid, kind: 'email', direction: m.direction, occurred_at: m.at, title: m.subject, summary: m.snippet, source_ref: `${m.id}:${cid}`, qualifies_outreach: m.direction === 'outbound', qualifies_engagement: m.direction === 'inbound' };
  }));
  await addInteractions(ctx, a.mailSource, timeline);
  await bumpContacts(ctx, 'last_outreach_at', outreach);
  await bumpContacts(ctx, 'last_engagement_at', engagement);

  // Suggested promises and meetings from the newest new emails (one AI pass).
  const check = await checkEmails(ctx, conn, a, parsed, timeZone);
  return { messages: parsed.length, threads: threadRows.length, check, warning };
}

// ---------------------------------------------------------------------------------------
type Check = { checked: number; promises: number; meetings: number; error?: string; note?: string };
const NO_CHECK: Check = { checked: 0, promises: 0, meetings: 0 };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function checkEmails(ctx: Ctx, conn: Conn, a: Adapter, parsed: NormMessage[], timeZone: string): Promise<Check> {
  if (!ctx.anthropic) return { ...NO_CHECK, note: `${new Date().toISOString()}|Promise and meeting check is off: the AI key isn’t set on the server.` };
  const review: EmailForReview[] = [...parsed].sort((x, y) => y.at.localeCompare(x.at)).slice(0, MAX_CHECK_EMAILS)
    .map(m => ({ id: m.id, at: m.at, direction: m.direction, fromName: m.fromName, subject: m.subject, text: m.text }))
    .filter(e => e.text.length > 20);
  if (!review.length) return NO_CHECK;
  const when = new Date().toISOString();
  try {
    const found = await analyzeEmails(ctx.anthropic, buildEmailPrompt(review, ctx.userName));
    const byId = new Map(parsed.map(m => [m.id, m]));

    let promises = 0;
    for (const p of sanitizeEmailPromises(found.promises, review)) {
      const { error } = await ctx.admin.from('promises').insert({
        owner_id: ctx.userId, team_id: null, visibility: 'private', contact_id: byId.get(p.message_id)?.contactIds[0] ?? null,
        title: p.title, direction: p.direction, due_on: p.due_on, status: 'suggested', source: a.mailSource, source_ref: p.message_id,
        evidence: p.evidence, owner_label: p.direction === 'made_by_me' ? 'You' : byId.get(p.message_id)?.fromName ?? 'Contact',
      });
      if (!error) promises++;
    }

    let meetings = 0;
    const drafts = sanitizeEmailMeetings(found.meetings, review, timeZone);
    if (drafts.length) {
      const { data: events } = await ctx.admin.from('calendar_events').select('starts_at,contact_ids').eq('owner_id', ctx.userId)
        .gte('starts_at', new Date(Date.now() - DAY).toISOString());
      for (const d of drafts) {
        const msg = byId.get(d.source_ref);
        const row = { ...d, contact_ids: msg?.contactIds ?? [], attendee_emails: msg?.contactEmails ?? [] };
        if (alreadyOnCalendar(row, events ?? [])) continue;   // e.g. they already sent an invite
        const { error } = await ctx.admin.from('meeting_suggestions').insert({
          ...row, owner_id: ctx.userId, connection_id: conn.id, source: a.mailSource, thread_link: msg?.link ?? null,
        });
        if (!error) meetings++;
      }
    }
    return { checked: review.length, promises, meetings,
      note: `${when}|Checked ${plural(review.length, 'new email')}: ${plural(promises, 'promise')}, ${plural(meetings, 'meeting')} found.` };
  } catch (e) {
    // Mail still syncs if the AI step fails; these messages aren't checked again.
    const msg = e instanceof Error ? e.message : 'unknown error';
    console.error('email check failed', msg);
    return { ...NO_CHECK, error: msg, note: `${when}|Promise and meeting check failed: ${msg.slice(0, 200)}` };
  }
}
