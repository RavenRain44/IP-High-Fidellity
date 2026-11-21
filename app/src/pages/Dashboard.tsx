import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { requireSupabase } from '../lib/supabase';
import { dueLabel, useQuery, type Promise_ } from '../lib/data';
import { Icon } from '../components/Icon';

type Counts = { connections: number; contacts: number; meetings: number; teams: number };

export function Dashboard() {
  const { profile, user } = useAuth();
  const sb = requireSupabase();
  const uid = user!.id;

  const counts = useQuery<Counts>(async () => {
    const head = { count: 'exact' as const, head: true };
    const [c, k, m, t] = await Promise.all([
      sb.from('integration_connections').select('id', head),
      sb.from('contacts').select('id', head).eq('owner_id', uid),
      sb.from('meetings').select('id', head).eq('owner_id', uid),
      sb.from('team_members').select('team_id', head).eq('user_id', uid),
    ]);
    const error = c.error || k.error || m.error || t.error;
    return { data: { connections: c.count ?? 0, contacts: k.count ?? 0, meetings: m.count ?? 0, teams: t.count ?? 0 }, error };
  }, [uid]);

  const promises = useQuery<Promise_[]>(() =>
    sb.from('promises').select('id,title,due_on,status,direction,contact_id').eq('status', 'open').order('due_on', { ascending: true, nullsFirst: false }).limit(20), []);

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = (profile?.full_name || '').split(' ')[0];
  const n = counts.data;
  const steps = [
    { done: !!n?.connections, title: 'Connect your email and calendar', sub: 'Gmail/Google Calendar or Outlook. LuMaCo only tracks contacts you approve.', to: '/app/integrations', cta: 'Connect' },
    { done: !!n?.contacts, title: 'Approve your first contacts', sub: 'Pick the customers and partners LuMaCo should keep up to date.', to: '/app', cta: 'Coming next' },
    { done: !!n?.meetings, title: 'Record a meeting or voice note', sub: 'Transcribed and turned into notes and promises for you to review.', to: '/app', cta: 'Coming next' },
    { done: !!n?.teams, title: 'Create or join a team (optional)', sub: 'Share work records with your team. Private notes stay private.', to: '/app/teams', cta: 'Teams' },
  ];
  const remaining = steps.filter(s => !s.done).length;
  const open = promises.data ?? [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const urgent = open.filter(p => p.due_on && new Date(p.due_on + 'T00:00:00').getTime() - today.getTime() <= 86400000);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{greet}{first ? `, ${first}` : ''}.</h1>
          <p>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p>
        </div>
      </div>

      {(counts.error || promises.error) && <div className="alert error" role="alert">{counts.error || promises.error}</div>}

      {remaining > 0 && !counts.loading && (
        <section className="card checklist" aria-labelledby="setup-h" style={{ marginBottom: 12 }}>
          <div className="card-head"><h2 id="setup-h"><Icon name="check" /> Get set up</h2><span className="pill blue">{steps.length - remaining} of {steps.length} done</span></div>
          {steps.map(s => (
            <div className={`row ${s.done ? 'done' : ''}`} key={s.title}>
              <span className="dot">{s.done && <Icon name="check" size="sm" />}</span>
              <div className="grow"><div className="title">{s.title}</div>{!s.done && <div className="small muted">{s.sub}</div>}</div>
              {!s.done && (s.cta === 'Coming next' ? <span className="pill">Coming next</span> : <Link className="btn sm" to={s.to}>{s.cta}</Link>)}
            </div>
          ))}
        </section>
      )}

      <div className="grid2">
        <section className="card" aria-labelledby="na-h">
          <div className="card-head"><h2 id="na-h"><Icon name="alert" /> Needs Attention</h2></div>
          {promises.loading ? <p className="muted">Loading…</p> : urgent.length ? urgent.map(p => (
            <div className="row" key={p.id}>
              <div className="grow"><div className="title">{p.title}</div><div className="small muted">Open Promise</div></div>
              <span className={`pill ${dueLabel(p.due_on).includes('overdue') ? '' : 'gold'}`}>{dueLabel(p.due_on)}</span>
            </div>
          )) : (
            <div className="empty"><strong>Nothing urgent</strong>Overdue follow-ups, unanswered customer emails and promises due soon will appear here once your accounts are connected.</div>
          )}
        </section>
        <section className="card" aria-labelledby="op-h">
          <div className="card-head"><h2 id="op-h"><Icon name="clipboard" /> Open Promises</h2><span className="pill">{open.length}</span></div>
          {promises.loading ? <p className="muted">Loading…</p> : open.length ? open.slice(0, 8).map(p => (
            <div className="row" key={p.id}>
              <div className="grow"><div className="title">{p.title}</div><div className="small muted">{p.direction === 'made_by_me' ? 'Made by you' : 'Made to you'}</div></div>
              <span className="pill">{dueLabel(p.due_on)}</span>
            </div>
          )) : (
            <div className="empty"><strong>No open promises yet</strong>Commitments from your meetings, emails and calls are tracked here with their source.</div>
          )}
        </section>
      </div>
    </>
  );
}
