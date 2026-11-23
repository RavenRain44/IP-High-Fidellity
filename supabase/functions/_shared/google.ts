// Google OAuth, Calendar and Gmail helpers shared by google-connect and google-sync.
// Pure functions (parsing, queries, mapping) are exported separately so they can be unit-tested.
import { decodeEntities, displayName, emailsIn, matchContacts, newText, type ContactIndex, type ParsedMessage } from './mail-common.ts';
export * from './mail-common.ts';
import { needsReconnect, ProviderError, type Adapter, type NormEvent, type TokenResponse } from './provider.ts';
export { needsReconnect } from './provider.ts';
export type { TokenResponse } from './provider.ts';
import { pool } from './mail-common.ts';

export const SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://www.googleapis.com/auth/gmail.readonly',
];
/** Asked for only when the user chooses to let LuMaCo add confirmed meetings to their calendar. */
export const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events';
export const KNOWN_SCOPES = [...SCOPES, CALENDAR_WRITE];
export const canWriteCalendar = (scopes: string[]) => scopes.includes(CALENDAR_WRITE);

/** Google API errors. In "Testing" mode Google revokes refresh tokens after 7 days (needsReconnect). */
export class GoogleError extends ProviderError {}

// ---------------------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------------------
export function authUrl(opts: { clientId: string; redirectUri: string; state: string; loginHint?: string; calendarWrite?: boolean }): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: 'code',
    scope: [...SCOPES, ...(opts.calendarWrite ? [CALENDAR_WRITE] : [])].join(' '),
    access_type: 'offline',          // ask for a refresh token
    prompt: 'consent',               // always return one, even on reconnect
    include_granted_scopes: 'true',
    state: opts.state,
  });
  if (opts.loginHint) p.set('login_hint', opts.loginHint);
  return `https://accounts.google.com/o/oauth2/v2/auth?${p}`;
}


async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleError(data.error_description || data.error || `Google token request failed (${res.status})`, res.status, data.error ?? '');
  return data as TokenResponse;
}

export const exchangeCode = (o: { code: string; clientId: string; clientSecret: string; redirectUri: string }) =>
  tokenRequest({ code: o.code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: o.redirectUri, grant_type: 'authorization_code' });

export const refreshAccessToken = (o: { refreshToken: string; clientId: string; clientSecret: string }) =>
  tokenRequest({ refresh_token: o.refreshToken, client_id: o.clientId, client_secret: o.clientSecret, grant_type: 'refresh_token' });

export async function revokeToken(token: string): Promise<void> {
  await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {});
}

/** Email from an ID token received directly from Google's token endpoint over TLS. */
export function idTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4)));
    return payload.email_verified === false ? null : (payload.email ?? null);
  } catch { return null; }
}

export async function gapi<T>(token: string, url: string, init?: { method: string; body: unknown }): Promise<T> {
  const res = await fetch(url, init
    ? { method: init.method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(init.body) }
    : { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = data.error?.message || `Google request failed (${res.status})`;
    if (res.status === 403 && /has not been used|is disabled/i.test(msg)) throw new GoogleError('The Gmail or Calendar API is not enabled in Google Cloud yet.', 403, 'api_disabled');
    throw new GoogleError(msg, res.status, data.error?.status ?? '');
  }
  return res.json() as Promise<T>;
}

// ---------------------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------------------
export type GEvent = {
  id: string; status?: string; summary?: string; location?: string; htmlLink?: string; hangoutLink?: string;
  start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; self?: boolean; resource?: boolean }[];
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
  eventType?: string;
};

export function mapEvent(ev: GEvent, idx: ContactIndex): NormEvent | null {
  const allDay = !ev.start?.dateTime;
  const starts = ev.start?.dateTime ?? (ev.start?.date ? `${ev.start.date}T00:00:00Z` : null);
  if (!starts) return null;
  const ends = ev.end?.dateTime ?? (ev.end?.date ? `${ev.end.date}T00:00:00Z` : null);
  const people = (ev.attendees ?? []).filter(a => a.email && !a.resource);
  const emails = [...people.map(a => a.email!), ...(ev.organizer?.email ? [ev.organizer.email] : [])];
  return {
    source_ref: ev.id,
    title: ev.summary?.slice(0, 300) ?? '(No title)',
    starts_at: starts,
    ends_at: ends,
    all_day: allDay,
    location: ev.location?.slice(0, 300) ?? null,
    meeting_url: ev.hangoutLink ?? ev.conferenceData?.entryPoints?.find(p => p.entryPointType === 'video')?.uri ?? null,
    html_link: ev.htmlLink ?? null,
    organizer_email: ev.organizer?.email?.toLowerCase() ?? null,
    attendees: people.slice(0, 50).map(a => ({ email: a.email!.toLowerCase(), name: a.displayName ?? null, response: a.responseStatus ?? null })),
    contact_ids: matchContacts(emails, idx),
    my_response: people.find(a => a.self)?.responseStatus ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// Gmail
// ---------------------------------------------------------------------------------------
/** Gmail search queries that only match mail to or from approved contacts, in chunks Gmail accepts. */
export function gmailQueries(emails: string[], afterUnix: number, chunk = 15): string[] {
  const list = [...new Set(emails.map(e => e.toLowerCase()))].filter(e => /^[^\s{}()"]+@[^\s{}()"]+$/.test(e));
  const out: string[] = [];
  for (let i = 0; i < list.length; i += chunk) {
    const terms = list.slice(i, i + chunk).flatMap(e => [`from:${e}`, `to:${e}`, `cc:${e}`]);
    out.push(`{${terms.join(' ')}} after:${afterUnix}`);
  }
  return out;
}

export type GPart = { mimeType?: string; body?: { data?: string; size?: number }; parts?: GPart[]; headers?: { name: string; value: string }[] };
export type GMessage = { id: string; threadId: string; labelIds?: string[]; snippet?: string; internalDate?: string; payload?: GPart };

export const header = (m: GMessage, name: string) =>
  m.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? '';

function decodeB64Url(data: string): string {
  const bin = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0)));
}

function findPart(p: GPart | undefined, type: string): GPart | null {
  if (!p) return null;
  if (p.mimeType === type && p.body?.data) return p;
  for (const c of p.parts ?? []) { const f = findPart(c, type); if (f) return f; }
  return null;
}

/** The new text of a message: plain text preferred, quoted replies and signatures-after-quote removed. */
export function messageText(m: GMessage, max = 2500): string {
  let text = '';
  const plain = findPart(m.payload, 'text/plain');
  if (plain?.body?.data) text = decodeB64Url(plain.body.data);
  else {
    const html = findPart(m.payload, 'text/html');
    if (html?.body?.data) text = decodeEntities(decodeB64Url(html.body.data)
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '').replace(/<blockquote[\s\S]*?<\/blockquote>/gi, '')
      .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ''));
  }
  if (!text) text = m.snippet ?? '';
  return newText(text, max);
}

export function parseMessage(m: GMessage, accountEmail: string, idx: ContactIndex): ParsedMessage {
  const from = header(m, 'From');
  const fromEmails = emailsIn(from);
  const outbound = (m.labelIds ?? []).includes('SENT') || fromEmails.includes(accountEmail.toLowerCase());
  const others = outbound ? [...emailsIn(header(m, 'To')), ...emailsIn(header(m, 'Cc'))] : fromEmails;
  const date = m.internalDate ? new Date(Number(m.internalDate)) : new Date(header(m, 'Date') || Date.now());
  return {
    id: m.id, threadId: m.threadId, at: date.toISOString(), direction: outbound ? 'outbound' : 'inbound',
    from: fromEmails[0] ?? '', fromName: displayName(from),
    subject: header(m, 'Subject').slice(0, 300) || '(No subject)',
    snippet: decodeEntities(m.snippet ?? '').slice(0, 300),
    contactIds: matchContacts(others, idx),
    contactEmails: others.filter(e => idx.has(e)),
  };
}

export const threadLink = (accountEmail: string, threadId: string) =>
  `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(accountEmail)}#all/${threadId}`;

// ---------------------------------------------------------------------------------------
// Adapter used by the shared sync and calendar code
// ---------------------------------------------------------------------------------------
const has = (scopes: string[], suffix: string) => scopes.some(s => s.endsWith(suffix));

export function googleAdapter(client: { id: string; secret: string }): Adapter {
  return {
    id: 'google', name: 'Google', mailSource: 'gmail', calendarSource: 'google_calendar',
    canReadMail: s => has(s, '/gmail.readonly'),
    canReadCalendar: s => has(s, '/calendar.readonly') || has(s, '/calendar.events'),
    canWriteCalendar: s => s.includes(CALENDAR_WRITE),
    refresh: rt => refreshAccessToken({ refreshToken: rt, clientId: client.id, clientSecret: client.secret }),
    timeZone: token => gapi<{ value?: string }>(token, 'https://www.googleapis.com/calendar/v3/users/me/settings/timezone').then(r => r.value || null, () => null),

    async events(token, from, to, idx) {
      const events: GEvent[] = [];
      let page = '';
      for (let i = 0; i < 4; i++) {
        const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '250', ...(page ? { pageToken: page } : {}) });
        const res = await gapi<{ items?: GEvent[]; nextPageToken?: string }>(token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${q}`);
        events.push(...(res.items ?? []));
        if (!res.nextPageToken) break;
        page = res.nextPageToken;
      }
      return events.filter(e => e.status !== 'cancelled' && e.eventType !== 'workingLocation' && e.eventType !== 'outOfOffice')
        .map(e => mapEvent(e, idx)).filter((e): e is NormEvent => !!e);
    },

    async messages(token, q) {
      // 1. Ids of matching messages (Gmail search does the contact filtering).
      const queries = [...gmailQueries(q.recent, Math.floor(q.recentAfter.getTime() / 1000)), ...gmailQueries(q.backfill, Math.floor(q.backfillAfter.getTime() / 1000))];
      const ids = new Map<string, string>();
      for (const query of queries) {
        let page = '';
        do {
          const p = new URLSearchParams({ q: query, maxResults: '100', ...(page ? { pageToken: page } : {}) });
          const res = await gapi<{ messages?: { id: string; threadId: string }[]; nextPageToken?: string }>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${p}`);
          (res.messages ?? []).forEach(m => ids.set(m.id, m.threadId));
          page = ids.size < q.cap * 2 ? res.nextPageToken ?? '' : '';
        } while (page);
      }
      // 2. Download only the new ones (newest first: Gmail lists newest first).
      const todo = [...ids.keys()].filter(id => !q.skip.has(id));
      const fetched = await pool(todo.slice(0, q.cap), 6, id =>
        gapi<GMessage>(token, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`).catch(e => { if (needsReconnect(e)) throw e; return null; }));
      const messages = fetched
        .filter((m): m is GMessage => !!m && !(m.labelIds ?? []).some(l => l === 'SPAM' || l === 'TRASH' || l === 'DRAFT'))
        .map(m => ({ ...parseMessage(m, q.account, q.idx), text: messageText(m), link: threadLink(q.account, m.threadId) }))
        .filter(m => m.contactIds.length);
      return { messages, more: todo.length > q.cap };
    },

    async createEvent(token, ev) {
      const event = await gapi<GEvent>(token,
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${ev.invite.length ? 'all' : 'none'}`,
        { method: 'POST', body: {
          summary: ev.title, location: ev.location, description: ev.description,
          start: { dateTime: ev.starts_at, timeZone: ev.time_zone },
          end: { dateTime: ev.ends_at, timeZone: ev.time_zone },
          ...(ev.invite.length ? { attendees: ev.invite.map(email => ({ email })) } : {}),
          ...(ev.source_link ? { source: { title: 'Email', url: ev.source_link } } : {}),
        } });
      return mapEvent(event, new Map());
    },
  };
}
