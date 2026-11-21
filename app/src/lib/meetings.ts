import { FunctionsHttpError } from '@supabase/supabase-js';
import { requireSupabase } from './supabase';

/** Asks the process-meeting Edge Function to transcribe and draft notes. Returns a readable error, if any. */
export async function startProcessing(meetingId: string): Promise<{ error?: string }> {
  const { error } = await requireSupabase().functions.invoke('process-meeting', { body: { meeting_id: meetingId } });
  if (!error) return {};
  if (error instanceof FunctionsHttpError) {
    try { const body = await error.context.json(); return { error: body?.error ?? 'Processing could not start.' }; } catch { /* fall through */ }
  }
  return { error: /failed to send|fetch/i.test(error.message) ? 'The processing service isn’t reachable yet. It may not be deployed.' : error.message };
}
