// Connected email/calendar accounts (Google and Microsoft): connect, disconnect, sync, add meetings.
import { useEffect, useRef } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { requireSupabase } from './supabase';
import type { Connection } from './data';

export type MailProvider = 'google' | 'microsoft';
export const PROVIDER_NAME: Record<MailProvider, string> = { google: 'Google', microsoft: 'Microsoft' };
export const isMailProvider = (p: string): p is MailProvider => p === 'google' || p === 'microsoft';

async function call<T>(fn: string, body: Record<string, unknown>): Promise<{ data?: T; error?: string; status?: number; raw?: Record<string, unknown> }> {
  const { data, error } = await requireSupabase().functions.invoke(fn, { body });
  if (!error) return { data: data as T };
  if (error instanceof FunctionsHttpError) {
    try { const b = await error.context.json(); return { error: b?.error ?? 'Something went wrong.', status: error.context.status, raw: b }; } catch { /* fall through */ }
  }
  return { error: /failed to send|fetch/i.test(error.message) ? 'The account service isn’t reachable. It may not be deployed yet.' : error.message };
}

/**
 * Sends the browser to Google's or Microsoft's consent screen. Returns an error message if it can't start.
 * calendarWrite also asks to add events; returnTo is where you come back to.
 */
export async function connectAccount(provider: MailProvider, opts: { calendarWrite?: boolean; returnTo?: '/app' | '/app/integrations' } = {}): Promise<string | undefined> {
  const r = await call<{ url: string }>(`${provider}-connect`, { action: 'start', calendar_write: !!opts.calendarWrite, return_to: opts.returnTo ?? '/app/integrations' });
  if (r.data?.url) { window.location.assign(r.data.url); return; }
  return r.error ?? `Could not start connecting to ${PROVIDER_NAME[provider]}.`;
}

export async function disconnectAccount(provider: MailProvider, connectionId: string): Promise<string | undefined> {
  return (await call(`${provider}-connect`, { action: 'disconnect', connection_id: connectionId })).error;
}

export type SyncResult = {
  provider?: MailProvider; email: string; events?: number | null; messages?: number | null; threads?: number | null;
  suggestions?: number | null; meetings?: number | null; checked?: number | null; check_error?: string; warning?: string; error?: string; skipped?: string;
};
/** Syncs every connected account. Sends the browser's time zone (used to read meeting times in Outlook mail). */
export async function syncAccounts(): Promise<{ results?: SyncResult[]; error?: string }> {
  let time_zone: string | undefined;
  try { time_zone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { /* leave unset */ }
  const r = await call<{ results: SyncResult[] }>('accounts-sync', { time_zone });
  return r.error ? { error: r.error } : { results: r.data?.results ?? [] };
}

/** Readable messages for the ?google=… / ?microsoft=… result the sign-in redirect brings back. */
export function connectResult(params: URLSearchParams): { ok: boolean; text: string } | null {
  const provider: MailProvider | null = params.get('google') ? 'google' : params.get('microsoft') ? 'microsoft' : null;
  if (!provider) return null;
  const name = PROVIDER_NAME[provider];
  const mail = provider === 'google' ? 'Gmail' : 'Outlook mail';
  const result = params.get(provider);
  if (result === 'connected') {
    const partial = params.get('partial');
    return { ok: true, text: partial === 'no_gmail' || partial === 'no_mail' ? `${name} calendar connected. ${mail} wasn’t allowed; connect again and allow it to include email.`
      : partial === 'no_calendar' ? `${mail} connected. The calendar wasn’t allowed; connect again and allow it to include meetings.`
      : params.get('calendar_write') ? `Done. LuMaCo can now add meetings you confirm to your ${provider === 'google' ? 'Google' : 'Outlook'} calendar.`
      : `${name} connected. Your calendar and email with contacts are syncing now.` };
  }
  if (result === 'error') {
    const reason = params.get('reason');
    return { ok: false, text: reason === 'denied' ? `${name} connection cancelled.`
      : reason === 'expired' ? 'That connection attempt expired. Try again.'
      : reason === 'admin' ? 'Your organization requires an IT admin to approve LuMaCo before you can connect this work account. Ask your IT admin, or connect a personal account.'
      : reason === 'no_scopes' ? `LuMaCo needs permission to read ${mail} or the calendar. Try again and allow access.`
      : `${name} couldn’t be connected. Try again in a minute.` };
  }
  return null;
}

const STALE_MS = 15 * 60_000;

/** Syncs connected accounts in the background when the newest sync is older than 15 minutes, then calls onDone. */
export function useAutoSync(connections: Connection[] | null, onDone: () => void) {
  const started = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (started.current || !connections) return;
    const live = connections.filter(c => isMailProvider(c.provider) && c.status !== 'revoked' && !/reconnect/i.test(c.last_error ?? ''));
    if (!live.length) return;
    const stale = live.some(c => c.status !== 'syncing' && (!c.last_synced_at || Date.now() - new Date(c.last_synced_at).getTime() > STALE_MS));
    if (!stale) return;
    started.current = true;
    void syncAccounts().then(() => done.current());
  }, [connections]);
}

const WRITE_SCOPE: Record<MailProvider, string> = { google: 'https://www.googleapis.com/auth/calendar.events', microsoft: 'Calendars.ReadWrite' };
export const canAddEvents = (c: Pick<Connection, 'provider' | 'scopes'> | undefined) =>
  !!c && isMailProvider(c.provider) && !!c.scopes?.includes(WRITE_SCOPE[c.provider]);

/** The sync's last promise/meeting check, stored as "ISO time|message". */
export function lastCheck(c: Pick<Connection, 'last_check'>): { at: Date; text: string; failed: boolean } | null {
  if (!c.last_check) return null;
  const i = c.last_check.indexOf('|');
  const text = i > 0 ? c.last_check.slice(i + 1) : c.last_check;
  return { at: new Date(i > 0 ? c.last_check.slice(0, i) : 0), text, failed: /failed|is off/i.test(text) };
}

export type MeetingSuggestion = {
  id: string; title: string; starts_at: string; ends_at: string | null; time_known: boolean; location: string | null;
  attendee_emails: string[]; contact_ids: string[]; evidence: string | null; thread_link: string | null; connection_id: string;
};

export async function addMeetingToCalendar(input: { suggestion_id: string; title: string; starts_at: string; ends_at: string; location: string; invite: boolean }):
  Promise<{ ok?: boolean; invited?: boolean; needsPermission?: boolean; error?: string }> {
  const r = await call<{ invited?: boolean }>('calendar-add', { action: 'add', ...input });
  if (!r.error) return { ok: true, invited: r.data?.invited };
  return { error: r.error, needsPermission: !!r.raw?.needs_permission };
}

const PERSONAL_MS = /@(outlook|hotmail|live|msn)\.[a-z.]+$/i;

/** A "new event" page in the account's own calendar, pre-filled. The user saves it there themselves. */
export function calendarTemplateLink(provider: MailProvider, account: string | null, m: { title: string; starts_at: string; ends_at: string; location?: string; details?: string; guests?: string[] }): string {
  if (provider === 'microsoft') {
    const host = account && PERSONAL_MS.test(account) ? 'outlook.live.com' : 'outlook.office.com';
    const p = new URLSearchParams({ path: '/calendar/action/compose', rru: 'addevent', subject: m.title, startdt: m.starts_at, enddt: m.ends_at });
    if (m.location) p.set('location', m.location);
    if (m.details) p.set('body', m.details);
    if (m.guests?.length) p.set('to', m.guests.join(','));
    return `https://${host}/calendar/0/deeplink/compose?${p}`;
  }
  const fmt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const p = new URLSearchParams({ action: 'TEMPLATE', text: m.title, dates: `${fmt(m.starts_at)}/${fmt(m.ends_at)}` });
  if (m.location) p.set('location', m.location);
  if (m.details) p.set('details', m.details);
  if (m.guests?.length) p.set('add', m.guests.join(','));
  return `https://calendar.google.com/calendar/render?${p}`;
}
