// Crash reporting to LuMaCo's own error log (public.app_errors via log_client_error).
// The database removes email addresses and tokens; here we also drop query strings and cap volume.
import { supabase } from './supabase';

declare const __RELEASE__: string;
const RELEASE = typeof __RELEASE__ === 'string' ? __RELEASE__ : 'local';
const MAX_PER_PAGE_LOAD = 10;
const seen = new Set<string>();

/** Sends one error to the log. Never throws, and only runs in production builds. */
export function reportError(err: unknown, where?: string): void {
  if (!import.meta.env.PROD || !supabase) return;
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-error thrown');
  const key = `${e.message}|${where ?? location.pathname}`;
  if (seen.has(key) || seen.size >= MAX_PER_PAGE_LOAD) return;
  seen.add(key);
  // Noise from browser extensions and cancelled requests isn't ours to fix.
  if (/ResizeObserver loop|AbortError|extension:\/\//i.test(`${e.message} ${e.stack ?? ''}`)) return;
  void supabase.rpc('log_client_error', {
    p_message: e.message.slice(0, 1000),
    p_stack: e.stack?.slice(0, 4000) ?? null,
    p_location: where ?? location.pathname,
    p_release: RELEASE,
    p_user_agent: navigator.userAgent.slice(0, 300),
  }).then(() => {}, () => {});
}

/** Catches errors that escape React and promise chains. */
export function installErrorReporting(): void {
  window.addEventListener('error', ev => reportError(ev.error ?? ev.message));
  window.addEventListener('unhandledrejection', ev => reportError(ev.reason));
}
