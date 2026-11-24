// Records a server-side failure in public.app_errors (service role). Emails and tokens are removed,
// and logging never throws: a failure to log must not hide the original error.
import type { SupabaseClient } from '@supabase/supabase-js';

export function scrub(text: string, max: number): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)?/g, '[token]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .slice(0, max);
}

export async function logError(admin: SupabaseClient, fn: string, err: unknown, userId?: string | null): Promise<void> {
  try {
    const message = err instanceof Error ? err.message : typeof err === 'string' ? err : JSON.stringify(err);
    await admin.from('app_errors').insert({
      source: 'function', location: fn, user_id: userId ?? null,
      message: scrub(message || 'Unknown error', 1000),
      stack: err instanceof Error && err.stack ? scrub(err.stack, 4000) : null,
    });
  } catch { /* never let logging fail the request */ }
}
