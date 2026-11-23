// Team Dashboard for owners and managers: built only from records shared with the team
// (visibility "team" or "managers"), plus which sources each member has connected.
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { requireSupabase } from '../lib/supabase';
import { daysAgo, dueLabel, useQuery, useWorkspaces, type Visibility } from '../lib/data';
import { AUDIT_SELECT, type AuditEvent } from '../lib/audit';
import { Icon } from '../components/Icon';
import { AuditList } from '../components/AuditList';
import { CoverageLine, useCoverage } from '../components/Coverage';

type TeamContact = {
  id: string; owner_id: string; full_name: string; visibility: Visibility; outreach_cadence_days: number; engagement_alert_days: number;
  last_outreach_at: string | null; last_engagement_at: string | null; companies: { name: string } | null;
};
type TeamPromise = { id: string; owner_id: string; title: string; due_on: string | null; contact_id: string | null };
type Member = { user_id: string; role: string };
type Profile = { id: string; full_name: string | null; email: string | null };

const DAY = 86_400_000;
const overdueBy = (iso: string | null, days: number) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / DAY) - days : null;
const isPastDue = (due: string | null) => !!due && new Date(due + 'T23:59:59') < new Date();

export function TeamDashboard() {
  const sb = requireSupabase();
  const { user } = useAuth();
  const workspaces = useWorkspaces(user?.id, sb);
  const adminTeams = workspaces.filter(w => w.id && (w.role === 'owner' || w.role === 'manager'));
  const [picked, setPicked] = useState<string | null>(null);
  const teamId = picked && adminTeams.some(t => t.id === picked) ? picked : adminTeams[0]?.id ?? null;

  if (!adminTeams.length) {
    return (
      <>
        <div className="page-head"><div><h1>Team Dashboard</h1></div></div>
        <section className="card empty"><strong>For team owners and managers</strong>
          The Team Dashboard shows a team’s shared contacts, promises and source coverage. Create a team or ask an owner to make you a manager on the <Link to="/app/teams">Teams</Link> page.</section>
      </>
    );
  }
  return <TeamView key={teamId} teamId={teamId!} teams={adminTeams.map(t => ({ id: t.id!, name: t.name }))} onPick={setPicked} />;
}

function TeamView({ teamId, teams, onPick }: { teamId: string; teams: { id: string; name: string }[]; onPick: (id: string) => void }) {
  const sb = requireSupabase();
  const members = useQuery<Member[]>(() => sb.from('team_members').select('user_id,role').eq('team_id', teamId).order('joined_at'), [teamId]);
  const ids = (members.data ?? []).map(m => m.user_id);
  const profiles = useQuery<Profile[]>(() => ids.length ? sb.from('profiles').select('id,full_name,email').in('id', ids) : Promise.resolve({ data: [], error: null }), [ids.join(',')]);
  const contacts = useQuery<TeamContact[]>(() => sb.from('contacts')
    .select('id,owner_id,full_name,visibility,outreach_cadence_days,engagement_alert_days,last_outreach_at,last_engagement_at,companies(name)')
    .eq('team_id', teamId).in('visibility', ['team', 'managers']).order('full_name').overrideTypes<TeamContact[], { merge: false }>(), [teamId]);
  const promises = useQuery<TeamPromise[]>(() => sb.from('promises').select('id,owner_id,title,due_on,contact_id')
    .eq('team_id', teamId).in('visibility', ['team', 'managers']).eq('status', 'open').order('due_on', { nullsFirst: false }), [teamId]);
  const coverage = useCoverage(teamId);
  const events = useQuery<AuditEvent[]>(() => sb.from('audit_events').select(AUDIT_SELECT).eq('team_id', teamId).in('visibility', ['team', 'managers'])
    .order('created_at', { ascending: false }).limit(12).overrideTypes<AuditEvent[], { merge: false }>(), [teamId]);
  const [selected, setSelected] = useState<string | null>(null);

  const name = (id: string) => { const p = (profiles.data ?? []).find(x => x.id === id); return p?.full_name || p?.email || 'Former member'; };
  const cs = contacts.data ?? [], ps = promises.data ?? [];
  const outreachLate = cs.filter(c => (overdueBy(c.last_outreach_at, c.outreach_cadence_days) ?? -1) > 0)
    .sort((a, b) => overdueBy(b.last_outreach_at, b.outreach_cadence_days)! - overdueBy(a.last_outreach_at, a.outreach_cadence_days)!);
  const latePromises = ps.filter(p => isPastDue(p.due_on));
  const contactName = (id: string | null) => cs.find(c => c.id === id)?.full_name;
  const error = members.error || contacts.error || promises.error || coverage.error || events.error;

  const rows = (members.data ?? []).map(m => {
    const mine = cs.filter(c => c.owner_id === m.user_id);
    return {
      ...m, contacts: mine,
      late: mine.filter(c => (overdueBy(c.last_outreach_at, c.outreach_cadence_days) ?? -1) > 0).length,
      unseen: mine.filter(c => !c.last_outreach_at).length,
      warn: mine.filter(c => (overdueBy(c.last_engagement_at, c.engagement_alert_days) ?? -1) > 0).length,
      open: ps.filter(p => p.owner_id === m.user_id).length,
    };
  });
  const current = rows.find(r => r.user_id === selected) ?? null;

  return (
    <>
      <div className="page-head">
        <div><h1>Team Dashboard</h1><p>Only records shared with the team appear here. Private records and email or calendar content never do.</p></div>
        {teams.length > 1 && (
          <label className="field" style={{ minWidth: 200 }}><span>Team</span>
            <select value={teamId} onChange={e => onPick(e.target.value)}>{teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
          </label>
        )}
      </div>
      {error && <div className="alert error" role="alert">{error}</div>}

      <div className="stat-row">
        {([['Members', rows.length, 'users'], ['Shared contacts', cs.length, 'users'], ['Overdue outreach', outreachLate.length, 'calendar'], ['Open shared promises', ps.length, 'clipboard']] as const).map(([label, n, icon]) => (
          <div className="card stat" key={label}><Icon name={icon} /><b>{contacts.loading ? '…' : n}</b><span>{label}</span></div>
        ))}
      </div>

      <div className="grid2" style={{ marginTop: 12 }}>
        <section className="card" aria-labelledby="team-attention">
          <div className="card-head"><h2 id="team-attention"><Icon name="alert" /> Team Needs Attention</h2></div>
          <p className="small muted" style={{ marginBottom: 6 }}>From shared contacts’ outreach schedules and shared promises.</p>
          {[...outreachLate.slice(0, 6).map(c => (
            <div className="row" key={`c-${c.id}`}>
              <div className="grow"><div className="title"><Link to={`/app/contacts?c=${c.id}`}>{c.full_name}</Link> needs outreach</div>
                <div className="small muted">{[c.companies?.name, name(c.owner_id), `last outreach ${daysAgo(c.last_outreach_at).toLowerCase()}`].filter(Boolean).join(' · ')}</div></div>
              <span className="pill">{overdueBy(c.last_outreach_at, c.outreach_cadence_days)}d overdue</span>
            </div>
          )), ...latePromises.slice(0, 6).map(p => (
            <div className="row" key={`p-${p.id}`}>
              <div className="grow"><div className="title">{p.title}</div><div className="small muted">{[contactName(p.contact_id), name(p.owner_id)].filter(Boolean).join(' · ')}</div></div>
              <span className="pill">{dueLabel(p.due_on)}</span>
            </div>
          ))]}
          {!contacts.loading && !outreachLate.length && !latePromises.length && <p className="muted small">Nothing overdue on shared records.</p>}
        </section>

        <section className="card" aria-labelledby="team-coverage">
          <div className="card-head"><h2 id="team-coverage"><Icon name="shield" /> Data coverage</h2></div>
          <p className="small muted" style={{ marginBottom: 6 }}>Which sources each person has connected. A missing source isn’t evidence of inactivity: that work just isn’t visible to LuMaCo.</p>
          {(members.data ?? []).map(m => (
            <div className="row" key={m.user_id}>
              <div className="grow"><div className="title">{name(m.user_id)}</div><CoverageLine rows={coverage.forUser(m.user_id)} loading={coverage.loading} /></div>
            </div>
          ))}
          <p className="small muted" style={{ marginTop: 8 }}>Phone calls and texts aren’t connected yet for anyone.</p>
        </section>
      </div>

      <section className="card" style={{ marginTop: 12 }} aria-labelledby="team-people">
        <div className="card-head"><h2 id="team-people"><Icon name="users" /> Individual progress</h2><span className="small muted">From shared records, not a performance ranking</span></div>
        <div className="table-scroll"><table className="table">
          <thead><tr><th>Person</th><th>Shared contacts</th><th>Overdue outreach</th><th>No outreach seen</th><th>Engagement warnings</th><th>Open promises</th><th><span className="sr-only">Details</span></th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.user_id} className={r.user_id === selected ? 'selected' : ''}>
                <td><b>{name(r.user_id)}</b> <span className="small muted" style={{ textTransform: 'capitalize' }}>{r.role}</span></td>
                <td>{r.contacts.length}</td><td>{r.late}</td><td>{r.unseen}</td><td>{r.warn}</td><td>{r.open}</td>
                <td style={{ textAlign: 'right' }}><button className="btn sm" onClick={() => setSelected(s => s === r.user_id ? null : r.user_id)} aria-expanded={r.user_id === selected}>{r.user_id === selected ? 'Hide' : 'Accounts'}</button></td>
              </tr>
            ))}
          </tbody>
        </table></div>
        {current && (
          <div style={{ marginTop: 12 }}>
            <h3 style={{ margin: '0 0 6px' }}>Accounts · {name(current.user_id)}</h3>
            <p className="small muted" style={{ marginBottom: 6 }}>Dates come from shared activity. You see when contact happened, not what was said.</p>
            {current.contacts.length ? current.contacts.map(c => (
              <div className="row" key={c.id}>
                <div className="grow"><div className="title">{c.full_name}</div>
                  <div className="small muted">{[c.companies?.name, `Outreach: ${c.last_outreach_at ? daysAgo(c.last_outreach_at) : 'not observed'}`, `Engagement: ${c.last_engagement_at ? daysAgo(c.last_engagement_at) : 'not observed'}`, c.visibility === 'managers' ? 'managers only' : 'team'].filter(Boolean).join(' · ')}</div></div>
                <Link className="btn sm" to={`/app/contacts?c=${c.id}`}>Open</Link>
              </div>
            )) : <p className="muted small">No shared contacts owned by this person.</p>}
          </div>
        )}
      </section>

      <section className="card" style={{ marginTop: 12 }} aria-labelledby="team-audit">
        <div className="card-head"><h2 id="team-audit"><Icon name="refresh" /> Automatic updates</h2></div>
        <p className="small muted" style={{ marginBottom: 6 }}>Sync changes to shared contacts’ dates. Only the person whose account made a change can undo it.</p>
        <AuditList events={events.data ?? []} ownerName={name} empty="No automatic changes to shared contacts yet." />
      </section>
    </>
  );
}
