// Google OAuth, Calendar and Gmail helpers shared by google-connect and google-sync.
// Pure functions (parsing, queries, mapping) are exported separately so they can be unit-tested.

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

export class GoogleError extends Error {
  constructor(message: string, public status = 0, public code = '') { super(message); }
}
/** The refresh token was revoked or expired (Google "Testing" apps: after 7 days). Needs reconnecting. */
export const needsReconnect = (e: unknown) => e instanceof GoogleError && (e.code === 'invalid_grant' || e.status === 401);

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

export type TokenResponse = { access_token: string; expires_in: number; refresh_token?: string; scope?: string; id_token?: string };

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

/** Runs `fn` over items with at most `limit` in flight. */
export async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

// ---------------------------------------------------------------------------------------
// Contacts: approved contacts are matched by their saved email addresses
// ---------------------------------------------------------------------------------------
export type ContactIndex = Map<string, string[]>;   // email (lowercase) -> contact ids

export function buildContactIndex(contacts: { id: string; contact_identities?: { kind: string; value: string }[] | null }[]): ContactIndex {
  const idx: ContactIndex = new Map();
  for (const c of contacts) for (const i of c.contact_identities ?? []) {
    if (i.kind !== 'email') continue;
    const e = i.value.trim().toLowerCase();
    if (!e) continue;
    idx.set(e, [...(idx.get(e) ?? []), c.id]);
  }
  return idx;
}

export function matchContacts(emails: string[], idx: ContactIndex): string[] {
  return [...new Set(emails.flatMap(e => idx.get(e.toLowerCase()) ?? []))];
}

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
export const emailsIn = (header: string | undefined | null) => [...new Set((header ?? '').match(EMAIL_RE)?.map(e => e.toLowerCase()) ?? [])];
export function displayName(from: string | undefined | null): string {
  const s = (from ?? '').trim();
  const m = /^"?([^"<]+?)"?\s*</.exec(s);
  return m ? m[1].trim() : (emailsIn(s)[0] ?? s);
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

export function mapEvent(ev: GEvent, idx: ContactIndex) {
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

const decodeEntities = (s: string) => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

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
  const lines: string[] = [];
  for (const line of text.replace(/\r/g, '').split('\n')) {
    if (/^On .{4,200}wrote:\s*$/.test(line.trim()) || /^-{2,}\s*(Original|Forwarded) Message/i.test(line.trim()) || /^From: .+@/.test(line.trim()) && lines.length > 2) break;
    if (line.trimStart().startsWith('>')) continue;
    lines.push(line);
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
}

export type ParsedMessage = {
  id: string; threadId: string; at: string; direction: 'inbound' | 'outbound';
  from: string; fromName: string; subject: string; snippet: string; contactIds: string[];
  contactEmails: string[];   // the addresses on this message that belong to approved contacts
};

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

export type ThreadState = { last_message_at: string; message_count: number; dismissed_at: string | null; contact_ids: string[] };

/** Folds newly synced messages into a thread's stored state. */
export function foldThread(existing: ThreadState | null, msgs: ParsedMessage[]) {
  const sorted = [...msgs].sort((a, b) => a.at.localeCompare(b.at));
  const last = sorted[sorted.length - 1];
  const newer = !existing || last.at > existing.last_message_at;
  const contacts = [...new Set([...(existing?.contact_ids ?? []), ...msgs.flatMap(m => m.contactIds)])];
  return {
    newer,
    row: {
      contact_ids: contacts,
      message_count: (existing?.message_count ?? 0) + msgs.length,
      ...(newer ? {
        subject: last.subject, snippet: last.snippet, last_message_at: last.at, last_from: last.fromName,
        last_direction: last.direction, needs_reply: last.direction === 'inbound',
        // They wrote again after you dismissed it: bring it back.
        dismissed_at: last.direction === 'inbound' ? null : existing?.dismissed_at ?? null,
      } : {}),
    },
  };
}

export const threadLink = (accountEmail: string, threadId: string) =>
  `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(accountEmail)}#all/${threadId}`;
