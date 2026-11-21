import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

/** True once VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY are set (see app/.env.example). */
export const isConfigured = Boolean(url && key && !url.includes('YOUR-PROJECT-REF'));

/**
 * The browser client. Only the public anon/publishable key is used here; every table is
 * protected by row-level security, and secret keys live only in Supabase Edge Functions.
 */
export const supabase: SupabaseClient | null = isConfigured
  ? createClient(url!, key!, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'pkce' },
    })
  : null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error('LuMaCo is not connected to a Supabase project yet. See docs/REAL_MODE_SETUP.md.');
  return supabase;
}

/** Turns Supabase/Auth errors into short, user-facing messages. */
export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : 'Something went wrong.';
  if (/invalid login credentials/i.test(msg)) return 'That email and password don’t match an account.';
  if (/email not confirmed/i.test(msg)) return 'Please confirm your email first. Check your inbox for the link.';
  if (/user already registered/i.test(msg)) return 'An account with this email already exists. Try signing in.';
  if (/password should be at least/i.test(msg)) return 'Use a password with at least 8 characters.';
  if (/rate limit/i.test(msg)) return 'Too many attempts. Please wait a minute and try again.';
  if (/failed to fetch|network/i.test(msg)) return 'Can’t reach LuMaCo’s servers. Check your connection.';
  return msg;
}
