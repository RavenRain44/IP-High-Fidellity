import { useCallback, useEffect, useState } from 'react';
import { friendlyError } from './supabase';

export type TeamRole = 'owner' | 'manager' | 'member';
export type Membership = { team_id: string; role: TeamRole; teams: { id: string; name: string } | null };
export type Invite = { id: string; team_id: string; team_name: string; role: TeamRole; invited_by_name: string | null; created_at: string };
export type Connection = { id: string; provider: 'google' | 'microsoft' | 'twilio'; status: string; account_email: string | null; last_synced_at: string | null; last_error: string | null };
export type Promise_ = { id: string; title: string; due_on: string | null; status: string; direction: string; contact_id: string | null };

/** Small query hook: runs `fn`, exposes data/error/loading and a reload. */
export function useQuery<T>(fn: () => PromiseLike<{ data: T | null; error: unknown }>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const run = useCallback(async () => {
    setLoading(true);
    const res = await fn();
    if (res.error) setError(friendlyError(res.error)); else { setError(''); setData(res.data); }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void run(); }, [run]);
  return { data, error, loading, reload: run };
}

export function dueLabel(due: string | null): string {
  if (!due) return 'No due date';
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const d = new Date(due + 'T00:00:00');
  const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
  if (diff < 0) return `${-diff}d overdue`;
  if (diff === 0) return 'Due today';
  if (diff === 1) return 'Due tomorrow';
  return `Due ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
}
