// process-meeting: transcribe a recording (Deepgram) and draft notes (Claude) for review.
//
// POST { meeting_id } with the user's session token. Responds 202 at once and keeps working in
// the background; the app watches meetings.status: transcribing -> extracting -> ready | failed.
// Secrets (set with `supabase secrets set`): DEEPGRAM_API_KEY, ANTHROPIC_API_KEY.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Anthropic from '@anthropic-ai/sdk';
import { formatTranscript, transcribe, type Utterance } from '../_shared/deepgram.ts';
import { buildPrompt, draftNotes, RefusedError, sanitize, type ContactRef, type ProjectRef } from '../_shared/notes.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
const env = (...names: string[]) => names.map(n => Deno.env.get(n)).find(Boolean) ?? '';

type Meeting = {
  id: string; owner_id: string; kind: 'meeting' | 'notes' | 'call'; title: string | null; started_at: string;
  audio_path: string | null; typed_notes: string | null; keep_audio: boolean; status: string;
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Use POST' }, 405);

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return json({ error: 'Sign in required' }, 401);

  const url = env('SUPABASE_URL');
  const anonKey = env('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY');
  const serviceKey = env('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY');
  // The user's own client: every read goes through row-level security as that user.
  const userDb = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } }, auth: { persistSession: false } });
  const { data: { user } } = await userDb.auth.getUser(authHeader.replace(/^Bearer\s+/i, ''));
  if (!user) return json({ error: 'Sign in required' }, 401);

  const { meeting_id } = await req.json().catch(() => ({}));
  if (typeof meeting_id !== 'string' || !/^[0-9a-f-]{36}$/i.test(meeting_id)) return json({ error: 'meeting_id is required' }, 400);

  const { data: meeting } = await userDb.from('meetings')
    .select('id,owner_id,kind,title,started_at,audio_path,typed_notes,keep_audio,status')
    .eq('id', meeting_id).eq('owner_id', user.id).maybeSingle<Meeting>();
  if (!meeting) return json({ error: 'Meeting not found' }, 404);
  if (meeting.status === 'transcribing' || meeting.status === 'extracting') return json({ status: meeting.status }, 202);
  if (meeting.status === 'reviewed') return json({ error: 'This meeting has already been filed' }, 409);
  if (!meeting.audio_path && !meeting.typed_notes?.trim()) return json({ error: 'Nothing to process: no recording or notes' }, 400);

  const deepgramKey = env('DEEPGRAM_API_KEY');
  const anthropicKey = env('ANTHROPIC_API_KEY');
  if (meeting.audio_path && !deepgramKey) return json({ error: 'Transcription is not set up yet (DEEPGRAM_API_KEY missing)' }, 503);
  if (!anthropicKey) return json({ error: 'AI notes are not set up yet (ANTHROPIC_API_KEY missing)' }, 503);

  // Service-role client only for storage and status writes on this one meeting.
  const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
  await admin.from('meetings').update({ status: meeting.audio_path ? 'transcribing' : 'extracting', error: null }).eq('id', meeting.id);

  EdgeRuntime.waitUntil(processMeeting({ meeting, userId: user.id, userDb, admin, deepgramKey, anthropic: new Anthropic({ apiKey: anthropicKey }) }));
  return json({ status: 'processing' }, 202);
});

async function processMeeting(ctx: {
  meeting: Meeting; userId: string; userDb: SupabaseClient; admin: SupabaseClient; deepgramKey: string; anthropic: Anthropic;
}) {
  const { meeting, userDb, admin } = ctx;
  const setStatus = (fields: Record<string, unknown>) => admin.from('meetings').update(fields).eq('id', meeting.id);
  try {
    let utterances: Utterance[] | null = null;
    if (meeting.audio_path) {
      const { data: audio, error } = await admin.storage.from('recordings').download(meeting.audio_path);
      if (error || !audio) throw new Error('The recording could not be read from storage.');
      utterances = await transcribe(audio, ctx.deepgramKey);
      if (!utterances.length && !meeting.typed_notes?.trim()) throw new Error('No speech was detected in the recording.');
      await setStatus({ status: 'extracting', transcript: utterances, transcript_text: formatTranscript(utterances) });
    }

    const [contactsRes, projectsRes, profileRes] = await Promise.all([
      userDb.from('contacts').select('id,full_name,title,companies(name),contact_identities(kind,value)').limit(1000),
      userDb.from('projects').select('id,name,companies(name)').limit(500),
      userDb.from('profiles').select('full_name').eq('id', ctx.userId).maybeSingle(),
    ]);
    const one = <T,>(x: T | T[] | null | undefined): T | undefined => (Array.isArray(x) ? x[0] : x ?? undefined);
    const contacts: ContactRef[] = (contactsRes.data ?? []).map((c: any) => ({
      id: c.id, name: c.full_name, title: c.title, company: one<{ name: string }>(c.companies)?.name ?? null,
      emails: (c.contact_identities ?? []).filter((i: any) => i.kind === 'email').map((i: any) => i.value),
    }));
    const projects: ProjectRef[] = (projectsRes.data ?? []).map((p: any) => ({ id: p.id, name: p.name, company: one<{ name: string }>(p.companies)?.name ?? null }));

    const raw = await draftNotes(ctx.anthropic, buildPrompt({
      meetingDate: new Date(meeting.started_at), kind: meeting.kind, recorderName: profileRes.data?.full_name ?? null,
      transcript: utterances ? formatTranscript(utterances) : null, typedNotes: meeting.typed_notes, contacts, projects,
    }));
    const draft = sanitize(raw, contacts, projects);

    // Nobody or no project identified: suggest the ones from your most recent filed meeting.
    const why = { contacts: draft.contact_ids.length ? 'transcript' : 'none', project: draft.project_id ? 'transcript' : 'none', recent_title: null as string | null };
    if (!draft.contact_ids.length || !draft.project_id) {
      const { data: recent } = await userDb.from('meetings').select('id,title,project_id,meeting_contacts(contact_id)')
        .eq('owner_id', ctx.userId).eq('status', 'reviewed').neq('kind', 'notes').neq('id', meeting.id)
        .order('started_at', { ascending: false }).limit(1).maybeSingle();
      if (recent) {
        const recentContacts = ((recent as any).meeting_contacts ?? []).map((r: any) => r.contact_id as string);
        if (!draft.contact_ids.length && recentContacts.length) { draft.contact_ids = recentContacts; why.contacts = 'recent'; why.recent_title = recent.title; }
        if (!draft.project_id && recent.project_id) { draft.project_id = recent.project_id; why.project = 'recent'; why.recent_title = recent.title; }
      }
    }

    const names = Object.fromEntries(draft.speakers.map(s => [s.label, s.name]));
    const update: Record<string, unknown> = {
      status: 'ready', error: null, speakers: draft.speakers,
      title: meeting.title?.trim() ? meeting.title : draft.title,
      suggestions: { ...draft, why },
      transcript_text: utterances ? formatTranscript(utterances, names) : null,
    };
    if (meeting.audio_path && !meeting.keep_audio) {
      await admin.storage.from('recordings').remove([meeting.audio_path]);
      update.audio_path = null;
    }
    await setStatus(update);
  } catch (err) {
    const message = err instanceof RefusedError || err instanceof Error ? err.message : 'Processing failed.';
    console.error('process-meeting failed', meeting.id, err);
    // Keep the audio so the user can retry.
    await setStatus({ status: 'failed', error: message.slice(0, 500) });
  }
}
