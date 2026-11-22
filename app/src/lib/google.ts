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

/** Sends the browser to Google's consent screen. Returns an error message if it can't start. */
export async function connectGoogle(): Promise<string | undefined> {
  const r = await call<{ url: string }>('google-connect', { action: 'start' });
  if (r.data?.url) { window.location.assign(r.data.url); return; }
  return r.error ?? 'Could not start connecting to Google.';
}

export async function disconnectGoogle(connectionId: string): Promise<string | undefined> {
  return (await call('google-connect', { action: 'disconnect', connection_id: connectionId })).error;
}

export type SyncResult = { email: string; events?: number | null; messages?: number | null; threads?: number | null; suggestions?: number | null; warning?: string; error?: string; skipped?: string };
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
