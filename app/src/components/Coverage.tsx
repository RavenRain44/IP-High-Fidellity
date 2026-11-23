// Which sources a team member has connected (types and sync freshness only, never addresses).
import { requireSupabase } from '../lib/supabase';
import { daysAgo, useQuery } from '../lib/data';

export type CoverageRow = { user_id: string; provider: string; mail: boolean; calendar: boolean; status: string; last_synced_at: string | null; needs_reconnect: boolean };
const NAMES: Record<string, string> = { google: 'Google', microsoft: 'Microsoft' };

/** team_coverage(): managers get every member, members only themselves. */
export function useCoverage(teamId: string) {
  const q = useQuery<CoverageRow[]>(() => requireSupabase().rpc('team_coverage', { p_team: teamId }), [teamId]);
  return { ...q, forUser: (id: string) => (q.data ?? []).filter(r => r.user_id === id) };
}

function ago(iso: string | null): string {
  if (!iso) return 'not synced yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  return m < 2 ? 'synced just now' : m < 60 ? `synced ${m} min ago` : m < 24 * 60 ? `synced ${Math.round(m / 60)} h ago` : `synced ${daysAgo(iso).toLowerCase()}`;
}

export function CoverageLine({ rows, loading }: { rows: CoverageRow[]; loading?: boolean }) {
  if (loading) return <div className="small muted">Checking sources…</div>;
  if (!rows.length) return <div className="small muted">No email or calendar connected</div>;
  return (
    <div className="small">
      {rows.map((r, i) => {
        const parts = [r.mail && 'email', r.calendar && 'calendar'].filter(Boolean).join(' + ') || 'no access';
        const bad = r.needs_reconnect || r.status === 'error';
        return (
          <span key={i} className={bad ? 'error-text' : 'muted'}>
            {i > 0 && ' · '}{NAMES[r.provider] ?? r.provider}: {parts}, {r.needs_reconnect ? 'needs reconnecting' : r.status === 'error' ? 'sync failing' : ago(r.last_synced_at)}
          </span>
        );
      })}
    </div>
  );
}
