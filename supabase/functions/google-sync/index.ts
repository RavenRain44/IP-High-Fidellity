// google-sync: bring the signed-in user's Google Calendar and Gmail up to date.
//
// POST {} with the user's session token. Syncs every Google account the user connected:
//   * Calendar: events from 30 days ago to 45 days ahead, matched to approved contacts by email.
//     Past meetings with contacts go on their timelines.
//   * Gmail: only messages to/from approved contacts' saved email addresses (Gmail search does the
//     filtering, so other mail is never downloaded). Threads waiting on your reply surface in Needs
//     Attention; commitments are suggested as promises for you to keep or dismiss.
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY, ANTHROPIC_API_KEY (optional).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { importKey } from '../_shared/crypto.ts';
import { googleAccessToken } from '../_shared/google-token.ts';
import {
  buildContactIndex, foldThread, gapi, GoogleError, gmailQueries, mapEvent, messageText, needsReconnect, parseMessage,
  pool, threadLink, type ContactIndex, type GEvent, type GMessage, type ParsedMessage, type ThreadState,
} from '../_shared/google.ts';
import {
  alreadyOnCalendar, analyzeEmails, buildEmailPrompt, sanitizeEmailMeetings, sanitizeEmailPromises, type EmailForReview,
} from '../_shared/email-insights.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const env = (...names: string[]) => names.map(n => Deno.env.get(n)).find(Boolean) ?? '';

const DAY = 86_400_000;
const MAX_MESSAGES = 150;       // per sync; later syncs pick up the rest
const MAX_CHECK_EMAILS = 25;    // newest new emails checked for promises and meetings per sync

type Conn = { id: string; account_email: string; scopes: string[]; last_synced_at: string | null };
type Ctx = { userId: string; userName: string | null; userDb: SupabaseClient; admin: SupabaseClient; key: CryptoKey; anthropic: Anthropic | null };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Sign in required' }, 401);

  const url = env('SUPABASE_URL');
  const userDb = createClient(url, env('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'), { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: { user } } = await userDb.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
  if (!user) return json({ error: 'Sign in required' }, 401);
  if (!env('GOOGLE_CLIENT_ID') || !env('GOOGLE_CLIENT_SECRET') || !env('TOKEN_ENCRYPTION_KEY')) return json({ error: 'Google sync isn’t set up on the server yet.' }, 503);

  const admin = createClient(url, env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
  const { data: conns } = await admin.from('integration_connections').select('id,account_email,scopes,last_synced_at')
    .eq('user_id', user.id).eq('provider', 'google').neq('status', 'revoked');
  if (!conns?.length) return json({ results: [] });

  const { data: profile } = await userDb.from('profiles').select('full_name').eq('id', user.id).maybeSingle();
  const ctx: Ctx = {
    userId: user.id, userName: profile?.full_name ?? null, userDb, admin,
    key: await importKey(env('TOKEN_ENCRYPTION_KEY')),
    anthropic: env('ANTHROPIC_API_KEY') ? new Anthropic({ apiKey: env('ANTHROPIC_API_KEY') }) : null,
  };
  const results = [];
  for (const c of conns as Conn[]) results.push(await syncConnection(ctx, c));
  return json({ results });
});

async function syncConnection(ctx: Ctx, conn: Conn) {
  const { admin } = ctx;
  const runStart = new Date();
  // Take the lock unless another sync started in the last 3 minutes.
  const { data: locked } = await admin.from('integration_connections')
    .update({ status: 'syncing', sync_started_at: runStart.toISOString() })
    .eq('id', conn.id)
    .or(`sync_started_at.is.null,sync_started_at.lt.${new Date(runStart.getTime() - 3 * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')}`)
    .select('id');
  if (!locked?.length) return { email: conn.account_email, skipped: 'already syncing' };

  try {
    const token = await googleAccessToken(admin, ctx.key, conn.id, { id: env('GOOGLE_CLIENT_ID'), secret: env('GOOGLE_CLIENT_SECRET') });
    const { data: contacts } = await ctx.userDb.from('contacts').select('id,contact_identities(kind,value,created_at)').limit(5000);
    const idx = buildContactIndex(contacts ?? []);
    // Addresses saved since the last sync get their past 30 days of email, not just new mail.
    const added = new Set((contacts ?? []).flatMap(c => (c.contact_identities ?? [])
      .filter(i => i.kind === 'email' && (!conn.last_synced_at || new Date(i.created_at) > new Date(conn.last_synced_at)))
      .map(i => i.value.trim().toLowerCase())));
    const has = (s: string) => conn.scopes.some(x => x.endsWith(s));
    const cal = has('/calendar.readonly') ? await syncCalendar(ctx, conn, token, idx, runStart) : null;
    const mail = has('/gmail.readonly') ? await syncGmail(ctx, conn, token, idx, added, runStart, cal?.timeZone ?? 'UTC') : null;
    await admin.from('integration_connections').update({
      status: 'connected', last_synced_at: runStart.toISOString(), last_error: null, sync_started_at: null,
      // Only replace the last check's result when this sync actually checked something.
      ...(mail?.check.note ? { last_check: mail.check.note } : {}),
    }).eq('id', conn.id);
    return {
      email: conn.account_email, events: cal?.events ?? null, messages: mail?.messages ?? null, threads: mail?.threads ?? null,
      suggestions: mail?.check.promises ?? null, meetings: mail?.check.meetings ?? null, checked: mail?.check.checked ?? null,
      check_error: mail?.check.error, warning: mail?.warning,
    };
  } catch (e) {
    const message = needsReconnect(e) ? 'Google access expired or was removed. Reconnect this account.'
      : e instanceof GoogleError && e.code === 'api_disabled' ? e.message
      : 'Sync failed. It will try again next time.';
    console.error('google-sync failed', conn.id, e instanceof Error ? e.message : e);
    await admin.from('integration_connections').update({ status: 'error', last_error: message, sync_started_at: null }).eq('id', conn.id);
    return { email: conn.account_email, error: message };
  }
}

/** Inserts timeline entries that aren't there yet (the unique index is partial, so no upsert). */
async function addInteractions(ctx: Ctx, source: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return 0;
  const refs = rows.map(r => r.source_ref as string);
  const known = new Set<string>();
  for (let i = 0; i < refs.length; i += 200) {
    const { data } = await ctx.admin.from('interactions').select('source_ref').eq('owner_id', ctx.userId).eq('source', source).in('source_ref', refs.slice(i, i + 200));
    (data ?? []).forEach(d => known.add(d.source_ref));
  }
  const fresh = rows.filter(r => !known.has(r.source_ref as string)).map(r => ({ ...r, owner_id: ctx.userId, team_id: null, visibility: 'private', source }));
  for (let i = 0; i < fresh.length; i += 200) await ctx.admin.from('interactions').insert(fresh.slice(i, i + 200));
  return fresh.length;
}

/** Moves a contact's last outreach / engagement forward. Uses the user's own permissions. */
async function bumpContacts(ctx: Ctx, field: 'last_outreach_at' | 'last_engagement_at', latest: Map<string, string>) {
  for (const [id, at] of latest) {
    const iso = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');
    await ctx.userDb.from('contacts').update({ [field]: iso }).eq('id', id).or(`${field}.is.null,${field}.lt.${iso}`);
  }
}

// ---------------------------------------------------------------------------------------
async function syncCalendar(ctx: Ctx, conn: Conn, token: string, idx: ContactIndex, runStart: Date) {
  const timeMin = new Date(runStart.getTime() - 30 * DAY).toISOString();
  const timeMax = new Date(runStart.getTime() + 45 * DAY).toISOString();
  const events: GEvent[] = [];
  let page = '';
  for (let i = 0; i < 4; i++) {
    const q = new URLSearchParams({ timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '250', ...(page ? { pageToken: page } : {}) });
    const res = await gapi<{ items?: GEvent[]; nextPageToken?: string }>(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
    events.push(...(res.items ?? []));
    if (!res.nextPageToken) break;
    page = res.nextPageToken;
  }
  // The calendar's time zone turns "Tuesday at 2" in an email into the right moment.
  const tz = await gapi<{ value?: string }>(token, 'https://www.googleapis.com/calendar/v3/users/me/settings/timezone').then(r => r.value || 'UTC', () => 'UTC');
  const rows = events.filter(e => e.status !== 'cancelled' && e.eventType !== 'workingLocation' && e.eventType !== 'outOfOffice')
    .map(e => mapEvent(e, idx)).filter((e): e is NonNullable<typeof e> => !!e)
    .map(e => ({ ...e, owner_id: ctx.userId, connection_id: conn.id, synced_at: runStart.toISOString() }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await ctx.admin.from('calendar_events').upsert(rows.slice(i, i + 200), { onConflict: 'connection_id,source_ref' });
    if (error) throw new Error(error.message);
  }
  // Events deleted or cancelled in Google since the last sync.
  await ctx.admin.from('calendar_events').delete().eq('connection_id', conn.id).gte('starts_at', timeMin).lt('starts_at', timeMax).lt('synced_at', runStart.toISOString());

  // Meetings with contacts that already happened go on the contacts' timelines.
  const now = runStart.toISOString();
  const past = rows.filter(r => r.contact_ids.length && (r.ends_at ?? r.starts_at) < now && r.my_response !== 'declined' && !r.all_day);
  const latest = new Map<string, string>();
  const timeline = past.flatMap(r => r.contact_ids.map(cid => {
    if ((latest.get(cid) ?? '') < r.starts_at) latest.set(cid, r.starts_at);
    const mins = r.ends_at ? Math.round((new Date(r.ends_at).getTime() - new Date(r.starts_at).getTime()) / 60_000) : null;
    return { contact_id: cid, kind: 'calendar', direction: null, occurred_at: r.starts_at, title: r.title, summary: r.location ? `Calendar meeting · ${r.location}` : 'Calendar meeting', source_ref: `${r.source_ref}:${cid}`, duration_sec: mins ? mins * 60 : null, qualifies_engagement: true };
  }));
  await addInteractions(ctx, 'google_calendar', timeline);
  await bumpContacts(ctx, 'last_engagement_at', latest);
  return { events: rows.length, timeZone: tz };
}

// ---------------------------------------------------------------------------------------
async function syncGmail(ctx: Ctx, conn: Conn, token: string, idx: ContactIndex, added: Set<string>, runStart: Date, timeZone: string) {
  const emails = [...idx.keys()];
  if (!emails.length) return { messages: 0, threads: 0, check: NO_CHECK, warning: 'Add email addresses to your contacts to see their emails here.' };
  const backfill = new Date(runStart.getTime() - 30 * DAY);
  const recent = conn.last_synced_at ? new Date(new Date(conn.last_synced_at).getTime() - 2 * 3600_000) : backfill;
  const older = emails.filter(e => !added.has(e)), newer = emails.filter(e => added.has(e));
  const since = newer.length ? backfill : recent;
  const queries = [...gmailQueries(older, Math.floor(recent.getTime() / 1000)), ...gmailQueries(newer, Math.floor(backfill.getTime() / 1000))];

  // 1. Ids of matching messages (Gmail does the contact filtering).
  const ids = new Map<string, string>(); // message id -> thread id
  for (const q of queries) {
    let page = '';
    do {
      const p = new URLSearchParams({ q, maxResults: '100', ...(page ? { pageToken: page } : {}) });
      const res = await gapi<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${p}`);
      (res.messages ?? []).forEach(m => ids.set(m.id, m.threadId));
      page = ids.size < MAX_MESSAGES * 2 ? res.nextPageToken ?? '' : '';
    } while (page);
  }

  // 2. Skip messages already on the timeline.
  const known = new Set<string>();
  const { data: seen } = await ctx.admin.from('interactions').select('source_ref').eq('owner_id', ctx.userId).eq('source', 'gmail').gte('occurred_at', since.toISOString()).limit(5000);
  (seen ?? []).forEach(s => known.add(String(s.source_ref).split(':')[0]));
  const todo = [...ids.keys()].filter(id => !known.has(id));

  // 3. Fetch the new ones (newest first: Gmail lists newest first).
  const fetched = await pool(todo.slice(0, MAX_MESSAGES), 6, id =>
    gapi<GMessage>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`).catch(e => { if (needsReconnect(e)) throw e; return null; }));
  const full = fetched.filter((m): m is GMessage => !!m && !(m.labelIds ?? []).some(l => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT'));
  const parsed = full.map(m => parseMessage(m, conn.account_email, idx)).filter(m => m.contactIds.length);
  if (!parsed.length) return { messages: 0, threads: 0, check: NO_CHECK, warning: todo.length > MAX_MESSAGES ? 'More email to catch up on next sync.' : undefined };

  // 4. Threads: fold new messages into what we already know.
  const byThread = new Map<string, ParsedMessage[]>();
  parsed.forEach(m => byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]));
  const { data: existing } = await ctx.admin.from('email_threads').select('thread_id,last_message_at,message_count,dismissed_at,contact_ids')
    .eq('connection_id', conn.id).in('thread_id', [...byThread.keys()]);
  const prev = new Map((existing ?? []).map(t => [t.thread_id, t as ThreadState]));
  const threadRows = [...byThread].map(([tid, msgs]) => {
    const { row } = foldThread(prev.get(tid) ?? null, msgs);
    return { owner_id: ctx.userId, connection_id: conn.id, thread_id: tid, web_link: threadLink(conn.account_email, tid), synced_at: runStart.toISOString(), ...row };
  });
  // New threads need every column; existing ones may only update some.
  const fresh = threadRows.filter(t => !prev.has(t.thread_id));
  const updates = threadRows.filter(t => prev.has(t.thread_id));
  if (fresh.length) { const { error } = await ctx.admin.from('email_threads').insert(fresh); if (error) throw new Error(error.message); }
  for (const t of updates) await ctx.admin.from('email_threads').update(t).eq('connection_id', conn.id).eq('thread_id', t.thread_id);

  // 5. Timeline entries and last outreach / engagement.
  const outreach = new Map<string, string>(), engagement = new Map<string, string>();
  const timeline = parsed.flatMap(m => m.contactIds.map(cid => {
    const map = m.direction === 'outbound' ? outreach : engagement;
    if ((map.get(cid) ?? '') < m.at) map.set(cid, m.at);
    return { contact_id: cid, kind: 'email', direction: m.direction, occurred_at: m.at, title: m.subject, summary: m.snippet, source_ref: `${m.id}:${cid}`, qualifies_outreach: m.direction === 'outbound', qualifies_engagement: m.direction === 'inbound' };
  }));
  await addInteractions(ctx, 'gmail', timeline);
  await bumpContacts(ctx, 'last_outreach_at', outreach);
  await bumpContacts(ctx, 'last_engagement_at', engagement);

  // 6. Suggested promises and meetings from the newest new emails (one AI pass).
  const check = await checkEmails(ctx, conn, parsed, full, timeZone);
  return { messages: parsed.length, threads: threadRows.length, check, warning: todo.length > MAX_MESSAGES ? 'More email to catch up on next sync.' : undefined };
}

// ---------------------------------------------------------------------------------------
type Check = { checked: number; promises: number; meetings: number; error?: string; note?: string };
const NO_CHECK: Check = { checked: 0, promises: 0, meetings: 0 };
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One AI pass over the newest new emails: suggested promises and suggested meetings. */
async function checkEmails(ctx: Ctx, conn: Conn, parsed: ParsedMessage[], full: GMessage[], timeZone: string): Promise<Check> {
  if (!ctx.anthropic) return { ...NO_CHECK, note: 'Promise and meeting check is off: the AI key isn’t set on the server.' };
  const fullById = new Map(full.map(m => [m.id, m]));
  const review: EmailForReview[] = [...parsed].sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_CHECK_EMAILS)
    .map(m => ({ id: m.id, at: m.at, direction: m.direction, fromName: m.fromName, subject: m.subject, text: messageText(fullById.get(m.id)!) }))
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
        title: p.title, direction: p.direction, due_on: p.due_on, status: 'suggested', source: 'gmail', source_ref: p.message_id,
        evidence: p.evidence, owner_label: p.direction === 'made_by_me' ? 'You' : byId.get(p.message_id)?.fromName ?? 'Contact',
      });
      if (!error) promises++;
    }

    let meetings = 0;
    const drafts = sanitizeEmailMeetings(found.meetings, review, timeZone);
    if (drafts.length) {
      const { data: events } = await ctx.admin.from('calendar_events').select('starts_at,contact_ids').eq('owner_id', ctx.userId)
        .gte('starts_at', new Date(Date.now() - 86400_000).toISOString());
      for (const d of drafts) {
        const msg = byId.get(d.source_ref);
        const row = { ...d, contact_ids: msg?.contactIds ?? [], attendee_emails: msg?.contactEmails ?? [] };
        if (alreadyOnCalendar(row, events ?? [])) continue;   // e.g. they already sent an invite
        const { error } = await ctx.admin.from('meeting_suggestions').insert({
          ...row, owner_id: ctx.userId, connection_id: conn.id, source: 'gmail',
          thread_link: msg ? threadLink(conn.account_email, msg.threadId) : null,
        });
        if (!error) meetings++;
      }
    }
    return { checked: review.length, promises, meetings,
      note: `${when}|Checked ${plural(review.length, 'new email')}: ${plural(promises, 'promise')}, ${plural(meetings, 'meeting')} found.` };
  } catch (e) {
    // Email still syncs if the AI step fails; these messages aren't checked again.
    const msg = e instanceof Error ? e.message : 'unknown error';
    console.error('email check failed', msg);
    return { ...NO_CHECK, error: msg, note: `${when}|Promise and meeting check failed: ${msg.slice(0, 200)}` };
  }
}
