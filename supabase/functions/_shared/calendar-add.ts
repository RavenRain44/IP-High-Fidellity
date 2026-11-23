// Puts a meeting the user confirmed onto their Google or Outlook calendar.
//
// POST { action: "add", suggestion_id, title, starts_at, ends_at, location?, invite? }   (signed in)
//   The user reviewed (and possibly edited) a meeting LuMaCo found in their email.
//   - Needs the optional add-events permission; without it responds 409 { needs_permission: true }
//     and the app offers to grant it or to open a pre-filled event in the calendar instead.
//   - Guests (the contacts on that email) are invited only when invite = true; otherwise the event
//     goes on the user's calendar alone and nobody is emailed.
import { createClient } from '@supabase/supabase-js';
import { importKey } from './crypto.ts';
import { accessToken } from './tokens.ts';
import { needsReconnect, ProviderError } from './provider.ts';
import { adapterFor, CORS, env, json } from './sync-core.ts';

export async function calendarAddHandler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'), { auth: { persistSession: false } });
  const { data: { user } } = await admin.auth.getUser((req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, ''));
  if (!user) return json({ error: 'Sign in required' }, 401);
  if (!env('TOKEN_ENCRYPTION_KEY')) return json({ error: 'Calendars aren’t set up on the server yet.' }, 503);

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

  const { data: conn } = await admin.from('integration_connections').select('id,provider,scopes').eq('id', sug.connection_id).eq('user_id', user.id).maybeSingle();
  if (!conn) return json({ error: 'That account is no longer connected.' }, 409);
  const a = adapterFor(conn.provider);
  if (!a) return json({ error: 'This calendar isn’t set up on the server yet.' }, 503);
  if (!a.canWriteCalendar(conn.scopes ?? [])) return json({ error: 'LuMaCo needs permission to add events to your calendar.', needs_permission: true }, 409);

  try {
    const token = await accessToken(admin, await importKey(env('TOKEN_ENCRYPTION_KEY')), conn.id, a.refresh, () => new ProviderError('No refresh token', 401, 'invalid_grant'));
    const invite = body.invite === true ? (sug.attendee_emails ?? []) as string[] : [];
    const event = await a.createEvent(token, {
      title, starts_at: start.toISOString(), ends_at: end.toISOString(), time_zone: sug.time_zone || 'UTC', location,
      description: `Added by LuMaCo from an email you confirmed.${sug.evidence ? `\n\n“${sug.evidence}”` : ''}`,
      invite, source_link: sug.thread_link,
    });
    // Show it right away (the next sync would bring it in too).
    let calendarEventId: string | null = null;
    if (event) {
      const { data: saved } = await admin.from('calendar_events').upsert({
        ...event, contact_ids: sug.contact_ids ?? [], owner_id: user.id, connection_id: conn.id, synced_at: new Date().toISOString(),
      }, { onConflict: 'connection_id,source_ref' }).select('id').single();
      calendarEventId = saved?.id ?? null;
    }
    await admin.from('meeting_suggestions').update({ status: 'added', calendar_event_id: calendarEventId }).eq('id', sug.id);
    return json({ ok: true, invited: invite.length > 0, html_link: event?.html_link ?? null });
  } catch (e) {
    console.error('calendar add failed', a.id, e instanceof Error ? e.message : e);
    if (needsReconnect(e)) return json({ error: `${a.name} access expired. Reconnect the account on the Integrations page.` }, 409);
    if (e instanceof ProviderError && e.status === 403) return json({ error: `${a.name} refused to add the event. Allow calendar access again and retry.`, needs_permission: true }, 409);
    return json({ error: `Couldn’t add the meeting to your ${a.id === 'google' ? 'Google' : 'Outlook'} calendar. Try again.` }, 502);
  }
}
