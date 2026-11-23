// Microsoft 365 / Outlook.com: sign-in (Microsoft identity platform) and mail + calendar through
// Microsoft Graph. Works for work/school accounts and personal accounts ("common" endpoint).
import { decodeEntities, displayName, matchContacts, newText, type ContactIndex } from './mail-common.ts';
import { ProviderError, type Adapter, type NormEvent, type NormMessage, type TokenResponse } from './provider.ts';

const AUTHORITY = 'https://login.microsoftonline.com/common/oauth2/v2.0';
const GRAPH = 'https://graph.microsoft.com/v1.0';

// Delegated permissions. Read-only by default; adding events is asked for separately when the user opts in.
export const MS_SCOPES = ['openid', 'email', 'profile', 'offline_access', 'User.Read', 'Mail.Read', 'Calendars.Read'];
export const MS_CALENDAR_WRITE = 'Calendars.ReadWrite';

export class GraphError extends ProviderError {}

/** "https://graph.microsoft.com/Mail.Read" and "Mail.Read" both become "Mail.Read". */
export const normalizeScopes = (scope: string | undefined) =>
  [...new Set((scope ?? '').split(/\s+/).filter(Boolean).map(s => s.replace(/^https:\/\/graph\.microsoft\.com\//i, '')))];

export function msAuthUrl(o: { clientId: string; redirectUri: string; state: string; loginHint?: string; calendarWrite?: boolean }): string {
  const p = new URLSearchParams({
    client_id: o.clientId, response_type: 'code', redirect_uri: o.redirectUri, response_mode: 'query',
    scope: [...MS_SCOPES, ...(o.calendarWrite ? [MS_CALENDAR_WRITE] : [])].join(' '),
    state: o.state, prompt: 'select_account',
  });
  if (o.loginHint) p.set('login_hint', o.loginHint);
  return `${AUTHORITY}/authorize?${p}`;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${AUTHORITY}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GraphError(data.error_description?.split('\n')[0] || data.error || `Microsoft token request failed (${res.status})`, res.status, data.error ?? '');
  return data as TokenResponse;
}

export const msExchangeCode = (o: { code: string; clientId: string; clientSecret: string; redirectUri: string; scopes: string[] }) =>
  tokenRequest({ client_id: o.clientId, client_secret: o.clientSecret, code: o.code, redirect_uri: o.redirectUri, grant_type: 'authorization_code', scope: o.scopes.join(' ') });

export const msRefresh = (o: { refreshToken: string; clientId: string; clientSecret: string; scopes: string[] }) =>
  tokenRequest({ client_id: o.clientId, client_secret: o.clientSecret, refresh_token: o.refreshToken, grant_type: 'refresh_token', scope: o.scopes.join(' ') });

/** Account email from the ID token (email claim, else the sign-in name, which is the address for most accounts). */
export function msIdTokenEmail(idToken: string | undefined): string | null {
  if (!idToken) return null;
  try {
    const part = idToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const c = JSON.parse(atob(part + '='.repeat((4 - part.length % 4) % 4)));
    const v = c.email || c.preferred_username;
    return typeof v === 'string' && v.includes('@') ? v.toLowerCase() : null;
  } catch { return null; }
}

export async function graph<T>(token: string, pathOrUrl: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }): Promise<T> {
  const res = await fetch(pathOrUrl.startsWith('http') ? pathOrUrl : `${GRAPH}${pathOrUrl}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bearer ${token}`,
      Prefer: 'outlook.timezone="UTC", outlook.body-content-type="text", IdType="ImmutableId"',
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const code = data.error?.code ?? '';
    throw new GraphError(data.error?.message || `Microsoft Graph request failed (${res.status})`, res.status, code === 'InvalidAuthenticationToken' ? 'invalid_grant' : code);
  }
  return (res.status === 204 ? {} : await res.json()) as T;
}

// ---------------------------------------------------------------------------------------
// Pure mapping (unit-tested)
// ---------------------------------------------------------------------------------------
export type MsAddress = { emailAddress?: { address?: string; name?: string } };
export type MsEvent = {
  id: string; subject?: string; isAllDay?: boolean; isCancelled?: boolean; webLink?: string; showAs?: string;
  start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string };
  location?: { displayName?: string }; onlineMeeting?: { joinUrl?: string } | null; onlineMeetingUrl?: string | null;
  organizer?: MsAddress; responseStatus?: { response?: string };
  attendees?: (MsAddress & { type?: string; status?: { response?: string } })[];
};

const MS_RESPONSE: Record<string, string | null> = {
  organizer: 'accepted', accepted: 'accepted', declined: 'declined', tentativelyAccepted: 'tentative', notResponded: 'needsAction', none: null,
};
/** Graph returns "2026-11-24T20:00:00.0000000" in the zone asked for (UTC here). */
const utc = (dt: string | undefined) => (dt ? new Date(/[zZ]|[+-]\d\d:\d\d$/.test(dt) ? dt : `${dt}Z`).toISOString() : null);

export function mapMsEvent(ev: MsEvent, idx: ContactIndex): NormEvent | null {
  const starts = utc(ev.start?.dateTime);
  if (!starts || ev.isCancelled) return null;
  const people = (ev.attendees ?? []).filter(a => a.emailAddress?.address && a.type !== 'resource');
  const organizer = ev.organizer?.emailAddress?.address?.toLowerCase() ?? null;
  const emails = [...people.map(a => a.emailAddress!.address!), ...(organizer ? [organizer] : [])];
  return {
    source_ref: ev.id,
    title: ev.subject?.slice(0, 300) || '(No title)',
    starts_at: starts,
    ends_at: utc(ev.end?.dateTime),
    all_day: !!ev.isAllDay,
    location: ev.location?.displayName?.slice(0, 300) || null,
    meeting_url: ev.onlineMeeting?.joinUrl ?? ev.onlineMeetingUrl ?? null,
    html_link: ev.webLink ?? null,
    organizer_email: organizer,
    attendees: people.slice(0, 50).map(a => ({ email: a.emailAddress!.address!.toLowerCase(), name: a.emailAddress!.name ?? null, response: a.status?.response ?? null })),
    contact_ids: matchContacts(emails, idx),
    my_response: MS_RESPONSE[ev.responseStatus?.response ?? 'none'] ?? null,
  };
}

/** KQL searches matching mail to/from/cc any of these addresses since a date, in small chunks. */
export function outlookSearches(emails: string[], after: Date, chunk = 8): string[] {
  const list = [...new Set(emails.map(e => e.toLowerCase()))].filter(e => /^[^\s"()]+@[^\s"()]+$/.test(e));
  const day = after.toISOString().slice(0, 10);
  const out: string[] = [];
  for (let i = 0; i < list.length; i += chunk) {
    out.push(`(${list.slice(i, i + chunk).map(e => `participants:${e}`).join(' OR ')}) AND received>=${day}`);
  }
  return out;
}

export type MsMessage = {
  id: string; conversationId?: string; subject?: string; bodyPreview?: string; body?: { content?: string };
  from?: MsAddress; toRecipients?: MsAddress[]; ccRecipients?: MsAddress[];
  receivedDateTime?: string; sentDateTime?: string; webLink?: string; isDraft?: boolean; parentFolderId?: string;
};
const addr = (a: MsAddress | undefined) => a?.emailAddress?.address?.toLowerCase() ?? '';

export function parseMsMessage(m: MsMessage, accountEmail: string, idx: ContactIndex, sentFolderId?: string): NormMessage {
  const from = addr(m.from);
  const outbound = from === accountEmail.toLowerCase() || (!!sentFolderId && m.parentFolderId === sentFolderId);
  const others = outbound ? [...(m.toRecipients ?? []), ...(m.ccRecipients ?? [])].map(addr).filter(Boolean) : [from];
  const name = m.from?.emailAddress?.name;
  return {
    id: m.id, threadId: m.conversationId ?? m.id,
    at: new Date(m.receivedDateTime ?? m.sentDateTime ?? Date.now()).toISOString(),
    direction: outbound ? 'outbound' : 'inbound',
    from, fromName: name ? displayName(`${name} <${from}>`) : from,
    subject: m.subject?.slice(0, 300) || '(No subject)',
    snippet: decodeEntities(m.bodyPreview ?? '').slice(0, 300),
    contactIds: matchContacts(others, idx),
    contactEmails: others.filter(e => idx.has(e)),
    text: newText(m.body?.content ?? m.bodyPreview ?? ''),
    link: m.webLink ?? null,
  };
}

// ---------------------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------------------
const MSG_FIELDS = 'id,conversationId,subject,bodyPreview,body,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,webLink,isDraft,parentFolderId';

export function microsoftAdapter(client: { id: string; secret: string }): Adapter {
  return {
    id: 'microsoft', name: 'Microsoft', mailSource: 'outlook', calendarSource: 'microsoft_calendar',
    canReadMail: s => s.includes('Mail.Read'),
    canReadCalendar: s => s.includes('Calendars.Read') || s.includes(MS_CALENDAR_WRITE),
    canWriteCalendar: s => s.includes(MS_CALENDAR_WRITE),
    // Ask for the same permissions back; Microsoft keeps any extra ones already granted.
    refresh: rt => msRefresh({ refreshToken: rt, clientId: client.id, clientSecret: client.secret, scopes: ['offline_access', 'https://graph.microsoft.com/.default'] }),
    // Graph's time zone needs an extra permission; the app sends the browser's zone instead.
    timeZone: () => Promise.resolve(null),

    async events(token, from, to, idx) {
      const p = new URLSearchParams({ startDateTime: from.toISOString(), endDateTime: to.toISOString(), $top: '200',
        $select: 'id,subject,isAllDay,isCancelled,start,end,location,onlineMeeting,onlineMeetingUrl,webLink,organizer,attendees,responseStatus,showAs' });
      let next: string | undefined = `/me/calendarView?${p}`;
      const out: NormEvent[] = [];
      for (let i = 0; next && i < 5; i++) {
        const res: { value?: MsEvent[]; '@odata.nextLink'?: string } = await graph(token, next);
        for (const ev of res.value ?? []) { const m = mapMsEvent(ev, idx); if (m) out.push(m); }
        next = res['@odata.nextLink'];
      }
      return out;
    },

    async messages(token, q) {
      // Folders whose mail doesn't count (junk, deleted, drafts) and the Sent folder.
      const folder = (name: string) => graph<{ id?: string }>(token, `/me/mailFolders/${name}?$select=id`).then(r => r.id, () => undefined);
      const [junk, deleted, drafts, sent] = await Promise.all(['junkemail', 'deleteditems', 'drafts', 'sentitems'].map(folder));
      const skipFolders = new Set([junk, deleted, drafts].filter(Boolean));

      const found = new Map<string, MsMessage>();
      let more = false;
      const run = async (kql: string, after: Date) => {
        let next: string | undefined = `/me/messages?${new URLSearchParams({ $search: `"${kql}"`, $top: '50', $select: MSG_FIELDS })}`;
        while (next) {
          const res: { value?: MsMessage[]; '@odata.nextLink'?: string } = await graph(token, next);
          for (const m of res.value ?? []) {
            if (m.isDraft || (m.parentFolderId && skipFolders.has(m.parentFolderId)) || q.skip.has(m.id)) continue;
            if (m.receivedDateTime && new Date(m.receivedDateTime) < after) continue;
            found.set(m.id, m);
          }
          next = found.size < q.cap ? res['@odata.nextLink'] : undefined;
          if (found.size >= q.cap && res['@odata.nextLink']) more = true;
        }
      };
      for (const [list, after] of [[q.recent, q.recentAfter], [q.backfill, q.backfillAfter]] as const) {
        for (const kql of outlookSearches(list, after)) {
          try { await run(kql, after); }
          catch (e) {
            // Some mailboxes reject grouped searches: fall back to one simple search per address.
            if (!(e instanceof GraphError) || e.status !== 400) throw e;
            for (const email of list) await run(`participants:${email}`, after);
            break;
          }
        }
      }
      const messages = [...found.values()]
        .sort((a, b) => (b.receivedDateTime ?? '').localeCompare(a.receivedDateTime ?? ''))
        .slice(0, q.cap)
        .map(m => parseMsMessage(m, q.account, q.idx, sent))
        .filter(m => m.contactIds.length);
      return { messages, more: more || found.size > q.cap };
    },

    async createEvent(token, ev) {
      const strip = (iso: string) => new Date(iso).toISOString().replace(/Z$/, '');
      const event = await graph<MsEvent>(token, '/me/events', { method: 'POST', body: {
        subject: ev.title,
        body: { contentType: 'text', content: ev.description + (ev.source_link ? `\n\nEmail: ${ev.source_link}` : '') },
        start: { dateTime: strip(ev.starts_at), timeZone: 'UTC' },
        end: { dateTime: strip(ev.ends_at), timeZone: 'UTC' },
        ...(ev.location ? { location: { displayName: ev.location } } : {}),
        // Outlook emails invitations to attendees; leave them off unless the user chose to invite.
        ...(ev.invite.length ? { attendees: ev.invite.map(address => ({ emailAddress: { address }, type: 'required' })) } : {}),
      } });
      return mapMsEvent(event, new Map());
    },
  };
}
