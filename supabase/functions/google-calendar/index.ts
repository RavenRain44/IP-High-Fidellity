// google-calendar: put a meeting the user confirmed onto their Google Calendar.
//
// POST { action: "add", suggestion_id, title, starts_at, ends_at, location?, invite? }   (signed in)
//   The user has reviewed (and possibly edited) a meeting LuMaCo found in their email.
//   - Needs the optional calendar.events permission; without it responds 409 { needs_permission: true }
//     and the app offers to grant it or to open a pre-filled Google Calendar event instead.
//   - Guests (the contacts on that email) are invited only when invite = true; otherwise the event
//     is created on the user's calendar alone and nobody is emailed.
// Secrets: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY.
import { createClient } from '@supabase/supabase-js';
import { importKey } from '../_shared/crypto.ts';
import { canWriteCalendar, gapi, GoogleError, mapEvent, needsReconnect, type GEvent } from '../_shared/google.ts';
import { googleAccessToken } from '../_shared/google-token.ts';

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
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
  const { data: { user } } = await admin.auth.getUser((req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''));
  if (!user) return json({ error: 'Sign in required' }, 401);
  if (!env('GOOGLE_CLIENT_ID') || !env('GOOGLE_CLIENT_SECRET') || !env('TOKEN_ENCRYPTION_KEY')) return json({ error: 'Google isn’t set up on the server yet.' }, 503);

  const body = await req.json().catch(() => ({}));
  if (body.action !== 'add') return json({ error: 'Unknown action' }, 400);

  // Validate what the user confirmed.
  const title = String(body.title ?? '').trim().slice(0, 300);
  const start = new Date(String(body.starts_at ?? ''));
  const end = new Date(String(body.ends_at ?? ''));
  const location = String(body.location ?? '').trim().slice(0, 300) || null;
  if (!title) return json({ error: 'Give the meeting a title.' }, 400);
  if (isNaN(start.getTime()) || isNaN(end.getTime()) || end <= start) return json({ error: 'Check the meeting’s start and end time.' }, 400);
  if (end.getTime() - start.getTime() > 24 * 3600_000) return json({ error: 'Meetings can be at most 24 hours long.' }, 400);

  const { data: sug } = await admin.from('meeting_suggestions')
    .select('id,connection_id,status,attendee_emails,contact_ids,time_zone,thread_link,evidence')
    .eq('id', String(body.suggestion_id ?? '')).eq('owner_id', user.id).maybeSingle();
  if (!sug) return json({ error: 'Suggestion not found' }, 404);
  if (sug.status === 'added') return json({ error: 'This meeting is already on your calendar.' }, 409);

  const { data: conn } = await admin.from('integration_connections').select('id,scopes,account_email').eq('id', sug.connection_id).eq('user_id', user.id).maybeSingle();
  if (!conn) return json({ error: 'That Google account is no longer connected.' }, 409);
  if (!canWriteCalendar(conn.scopes ?? [])) return json({ error: 'LuMaCo needs permission to add events to your calendar.', needs_permission: true }, 409);

  try {
    const token = await googleAccessToken(admin, await importKey(env('TOKEN_ENCRYPTION_KEY')), conn.id, { id: env('GOOGLE_CLIENT_ID'), secret: env('GOOGLE_CLIENT_SECRET') });
    const invite = body.invite === true && (sug.attendee_emails ?? []).length > 0;
    const tz = sug.time_zone || 'UTC';
    const event = await gapi<GEvent>(token,
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=${invite ? 'all' : 'none'}`,
      { method: 'POST', body: {
        summary: title,
        location,
        description: `Added by LuMaCo from an email you confirmed.${sug.evidence ? `\n\n“${sug.evidence}”` : ''}`,
        start: { dateTime: start.toISOString(), timeZone: tz },
        end: { dateTime: end.toISOString(), timeZone: tz },
        ...(invite ? { attendees: (sug.attendee_emails as string[]).map(email => ({ email })) } : {}),
        source: sug.thread_link ? { title: 'Email in Gmail', url: sug.thread_link } : undefined,
      } });

    // Show it right away (the next sync would bring it in too).
    const mapped = mapEvent(event, new Map());
    let calendarEventId: string | null = null;
    if (mapped) {
      const { data: saved } = await admin.from('calendar_events').upsert({
        ...mapped, contact_ids: sug.contact_ids ?? [], owner_id: user.id, connection_id: conn.id, synced_at: new Date().toISOString(),
      }, { onConflict: 'connection_id,source_ref' }).select('id').single();
      calendarEventId = saved?.id ?? null;
    }
    await admin.from('meeting_suggestions').update({ status: 'added', calendar_event_id: calendarEventId }).eq('id', sug.id);
    return json({ ok: true, invited: invite, html_link: event.htmlLink ?? null });
  } catch (e) {
    console.error('google-calendar add failed', e instanceof Error ? e.message : e);
    if (needsReconnect(e)) return json({ error: 'Google access expired. Reconnect your Google account on the Integrations page.' }, 409);
    if (e instanceof GoogleError && e.status === 403) return json({ error: 'Google refused to add the event. Allow calendar access again and retry.', needs_permission: true }, 409);
    return json({ error: 'Couldn’t add the meeting to Google Calendar. Try again.' }, 502);
  }
});
