import { useEffect, useRef } from 'react';
import { FunctionsHttpError } from '@supabase/supabase-js';
import { requireSupabase } from './supabase';
import type { Connection } from './data';

async function call<T>(fn: string, body: Record<string, unknown>): Promise<{ data?: T; error?: string }> {
  const { data, error } = await requireSupabase().functions.invoke(fn, { body });
  if (!error) return { data: data as T };
  if (error instanceof FunctionsHttpError) {
    try { const b = await error.context.json(); return { error: b?.error ?? 'Something went wrong.' }; } catch { /* fall through */ }
  }
  return { error: /failed to send|fetch/i.test(error.message) ? 'The Google service isn’t reachable. It may not be deployed yet.' : error.message };
}

/**
 * Sends the browser to Google's consent screen. Returns an error message if it can't start.
 * calendarWrite also asks to add events; returnTo is where Google sends you back ('/app' or the integrations page).
 */
export async function connectGoogle(opts: { calendarWrite?: boolean; returnTo?: '/app' | '/app/integrations' } = {}): Promise<string | undefined> {
  const r = await call<{ url: string }>('google-connect', { action: 'start', calendar_write: !!opts.calendarWrite, return_to: opts.returnTo ?? '/app/integrations' });
  if (r.data?.url) { window.location.assign(r.data.url); return; }
  return r.error ?? 'Could not start connecting to Google.';
}

export async function disconnectGoogle(connectionId: string): Promise<string | undefined> {
  return (await call('google-connect', { action: 'disconnect', connection_id: connectionId })).error;
}

export type SyncResult = { email: string; events?: number | null; messages?: number | null; threads?: number | null; suggestions?: number | null; meetings?: number | null; checked?: number | null; check_error?: string; warning?: string; error?: string; skipped?: string };
export async function syncGoogle(): Promise<{ results?: SyncResult[]; error?: string }> {
  const r = await call<{ results: SyncResult[] }>('google-sync', {});
  return r.error ? { error: r.error } : { results: r.data?.results ?? [] };
}

/** Readable messages for the ?google=… result Google's redirect brings back. */
export function connectResult(params: URLSearchParams): { ok: boolean; text: string } | null {
  const g = params.get('google');
  if (g === 'connected') {
    const partial = params.get('partial');
    return { ok: true, text: partial === 'no_gmail' ? 'Google Calendar connected. Gmail wasn’t allowed; connect again and tick Gmail to include email.'
      : partial === 'no_calendar' ? 'Gmail connected. Calendar wasn’t allowed; connect again and tick Calendar to include meetings.'
      : params.get('calendar_write') ? 'Done. LuMaCo can now add meetings you confirm to your Google Calendar.'
      : 'Google connected. Your calendar and email with contacts are syncing now.' };
  }
  if (g === 'error') {
    const reason = params.get('reason');
    return { ok: false, text: reason === 'denied' ? 'Google connection cancelled.'
      : reason === 'expired' ? 'That connection attempt expired. Try again.'
      : reason === 'no_scopes' ? 'LuMaCo needs permission to read Gmail or Calendar. Try again and tick the boxes on Google’s screen.'
      : 'Google couldn’t be connected. Try again in a minute.' };
  }
  return null;
}

const STALE_MS = 15 * 60_000;

/** Syncs Google in the background when the newest sync is older than 15 minutes, then calls onDone. */
export function useAutoSync(connections: Connection[] | null, onDone: () => void) {
  const started = useRef(false);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (started.current || !connections) return;
    const google = connections.filter(c => c.provider === 'google' && c.status !== 'revoked' && !/reconnect/i.test(c.last_error ?? ''));
    if (!google.length) return;
    const stale = google.some(c => c.status !== 'syncing' && (!c.last_synced_at || Date.now() - new Date(c.last_synced_at).getTime() > STALE_MS));
    if (!stale) return;
    started.current = true;
    void syncGoogle().then(() => done.current());
  }, [connections]);
}

export const CALENDAR_WRITE = 'https://www.googleapis.com/auth/calendar.events';
export const canAddEvents = (c: Pick<Connection, 'scopes'> | undefined) => !!c?.scopes?.includes(CALENDAR_WRITE);

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
  const { data, error } = await requireSupabase().functions.invoke('google-calendar', { body: { action: 'add', ...input } });
  if (!error) return { ok: true, invited: (data as { invited?: boolean })?.invited };
  if (error instanceof FunctionsHttpError) {
    try { const b = await error.context.json(); return { error: b?.error ?? 'Couldn’t add the meeting.', needsPermission: !!b?.needs_permission }; } catch { /* fall through */ }
  }
  return { error: 'Couldn’t reach the calendar service. Try again.' };
}

/** A Google Calendar "new event" page, pre-filled. The user saves it there themselves. */
export function calendarTemplateLink(m: { title: string; starts_at: string; ends_at: string; location?: string; details?: string; guests?: string[] }): string {
  const fmt = (iso: string) => new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const p = new URLSearchParams({ action: 'TEMPLATE', text: m.title, dates: `${fmt(m.starts_at)}/${fmt(m.ends_at)}` });
  if (m.location) p.set('location', m.location);
  if (m.details) p.set('details', m.details);
  if (m.guests?.length) p.set('add', m.guests.join(','));
  return `https://calendar.google.com/calendar/render?${p}`;
}
