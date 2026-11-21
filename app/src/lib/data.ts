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

// ---------- Phase 2: contacts, projects, meetings ----------
export type Visibility = 'private' | 'managers' | 'team';
export type Scoped = { owner_id: string; team_id: string | null; visibility: Visibility };
export type Company = { id: string; name: string };
export type Contact = Scoped & {
  id: string; full_name: string; title: string | null; company_id: string | null; priority: 'High' | 'Medium' | 'Low';
  starred: boolean; notes: string | null; last_engagement_at: string | null; last_outreach_at: string | null;
  companies?: Company | null; contact_identities?: { id: string; kind: 'email' | 'phone'; value: string }[];
};
export type Project = Scoped & {
  id: string; name: string; description: string | null; status: string; progress: number; company_id: string | null; updated_at: string;
  companies?: Company | null; project_contacts?: { contact_id: string }[];
};
export type DraftPromise = { title: string; direction: 'made_by_me' | 'made_to_me'; due_on: string | null; contact_id: string | null; evidence: string };
export type Suggestions = {
  title: string; notes: string; contact_ids: string[]; project_id: string | null; promises: DraftPromise[];
  speakers: { label: string; name: string | null }[];
  why?: { contacts: 'transcript' | 'recent' | 'none'; project: 'transcript' | 'recent' | 'none'; recent_title: string | null };
};
export type MeetingStatus = 'recording' | 'uploaded' | 'transcribing' | 'extracting' | 'ready' | 'reviewed' | 'failed';
export type Meeting = Scoped & {
  id: string; kind: 'meeting' | 'notes' | 'call'; title: string | null; started_at: string; duration_sec: number | null;
  project_id: string | null; status: MeetingStatus; transcript_text: string | null; notes: string | null; typed_notes: string | null;
  audio_path: string | null; keep_audio: boolean; error: string | null; suggestions: Suggestions | null; reviewed_at: string | null;
  meeting_contacts?: { contact_id: string }[];
};
export const PROCESSING: MeetingStatus[] = ['uploaded', 'transcribing', 'extracting'];

/** Where a new record can be saved: your personal workspace or any team you belong to. */
export type Workspace = { id: string | null; name: string; role?: TeamRole };
export function useWorkspaces(userId: string | undefined, client: { from: (t: string) => any }) {
  const q = useQuery<Membership[]>(() => client.from('team_members').select('team_id,role,teams(id,name)').eq('user_id', userId), [userId]);
  const list: Workspace[] = [{ id: null, name: 'Personal' }, ...(q.data ?? []).filter(m => m.teams).map(m => ({ id: m.team_id, name: (m.teams as any).name ?? (m.teams as any)[0]?.name, role: m.role }))];
  return list;
}

export function companyName(x: { companies?: Company | Company[] | null }): string {
  const c = Array.isArray(x.companies) ? x.companies[0] : x.companies;
  return c?.name ?? '';
}

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function duration(sec: number | null): string {
  if (!sec) return '';
  const m = Math.floor(sec / 60), s = sec % 60;
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : m ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}
export function daysAgo(iso: string | null): string {
  if (!iso) return 'Never';
  const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  return d <= 0 ? 'Today' : d === 1 ? 'Yesterday' : `${d} days ago`;
}
