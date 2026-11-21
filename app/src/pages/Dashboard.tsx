import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { dateTime, dueLabel, useQuery } from '../lib/data';
import { Icon } from '../components/Icon';

type Counts = { connections: number; contacts: number; meetings: number; teams: number };
type OpenPromise = { id: string; title: string; due_on: string | null; direction: string; contacts: { id: string; full_name: string } | null };
type Pending = { id: string; title: string | null; kind: string; status: string; started_at: string; error: string | null };

/** Ultrawide screens get a third dashboard column (see .dash in app.css). */
const WIDE = '(min-width: 1800px)';
function useWide() {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const mq = window.matchMedia(WIDE);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
}

export function Dashboard() {
  const wide = useWide();
  const { profile, user } = useAuth();
  const sb = requireSupabase();
  const uid = user!.id;
  const [error, setError] = useState('');

  const counts = useQuery<Counts>(async () => {
    const head = { count: 'exact' as const, head: true };
    const [c, k, m, t] = await Promise.all([
      sb.from('integration_connections').select('id', head),
      sb.from('contacts').select('id', head),
      sb.from('meetings').select('id', head).eq('owner_id', uid),
      sb.from('team_members').select('team_id', head).eq('user_id', uid),
    ]);
    return { data: { connections: c.count ?? 0, contacts: k.count ?? 0, meetings: m.count ?? 0, teams: t.count ?? 0 }, error: c.error || k.error || m.error || t.error };
  }, [uid]);
  const promises = useQuery<OpenPromise[]>(() => sb.from('promises').select('id,title,due_on,direction,contacts(id,full_name)').eq('status', 'open')
    .order('due_on', { ascending: true, nullsFirst: false }).limit(30).overrideTypes<OpenPromise[], { merge: false }>(), []);
  const pending = useQuery<Pending[]>(() => sb.from('meetings').select('id,title,kind,status,started_at,error').eq('owner_id', uid)
    .in('status', ['ready', 'failed']).order('started_at', { ascending: false }).limit(10), [uid]);

  async function complete(id: string) {
    const { error } = await sb.from('promises').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', id);
    if (error) setError(friendlyError(error)); else void promises.reload();
  }

  const hour = new Date().getHours();
  const greet = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const first = (profile?.full_name || '').split(' ')[0];
  const n = counts.data;
  const steps = [
    { done: !!n?.contacts, title: 'Add your first contacts', sub: 'The customers and partners LuMaCo should keep up to date.', to: '/app/contacts?c=new', cta: 'Add contact' },
    { done: !!n?.meetings, title: 'Record a meeting or voice note', sub: 'Transcribed and turned into notes and promises for you to review.', to: '/app/capture', cta: 'Record' },
    { done: !!n?.connections, title: 'Connect your email and calendar', sub: 'Gmail or Outlook. Coming in the next release.', to: '/app/integrations', cta: 'See integrations' },
    { done: !!n?.teams, title: 'Create or join a team (optional)', sub: 'Share work records with your team. Private notes stay private.', to: '/app/teams', cta: 'Teams' },
  ];
  const remaining = steps.filter(s => !s.done).length;
  const open = promises.data ?? [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const urgent = open.filter(p => p.due_on && new Date(p.due_on + 'T00:00:00').getTime() - today.getTime() <= 86400000);
  const review = pending.data ?? [];
  const loadErr = error || counts.error || promises.error || pending.error;

  return (
    <>
      <div className="page-head">
        <div><h1>{greet}{first ? `, ${first}` : ''}.</h1><p>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
      </div>
      {loadErr && <div className="alert error" role="alert">{loadErr}</div>}

      <div className="grid2 dash">
        <div className="stack dash-left">
          <section className="card" aria-labelledby="na-h">
            <div className="card-head"><h2 id="na-h"><Icon name="alert" /> Needs Attention</h2></div>
            {review.map(m => (
              <Link className="row link-row" key={m.id} to={`/app/meetings/${m.id}`}>
                <span className="row-icon"><Icon name={m.status === 'failed' ? 'alert' : 'sparkle'} size="sm" /></span>
                <div className="grow"><div className="title">{m.status === 'failed' ? 'Recording needs attention' : 'Review meeting notes'}: {m.title || (m.kind === 'notes' ? 'Voice note' : 'Meeting')}</div>
                  <div className="small muted">{m.status === 'failed' ? m.error : `Recorded ${dateTime(m.started_at)}`}</div></div>
                <span className={`pill ${m.status === 'failed' ? '' : 'gold'}`}>{m.status === 'failed' ? 'Failed' : 'Draft ready'}</span>
              </Link>
            ))}
            {urgent.map(p => (
              <div className="row" key={p.id}>
                <span className="row-icon"><Icon name="clipboard" size="sm" /></span>
                <div className="grow"><div className="title">{p.title}</div><div className="small muted">Open Promise{p.contacts ? ` · ${p.contacts.full_name}` : ''}</div></div>
                <span className={`pill ${dueLabel(p.due_on).includes('overdue') ? '' : 'gold'}`}>{dueLabel(p.due_on)}</span>
              </div>
            ))}
            {!review.length && !urgent.length && !promises.loading && (
              <div className="empty"><strong>Nothing urgent</strong>Drafts to review, promises due soon and, once connected, unanswered customer emails appear here.</div>
            )}
          </section>
          <section className="card" aria-labelledby="op-h">
            <div className="card-head"><h2 id="op-h"><Icon name="clipboard" /> Open Promises</h2><span className="pill">{open.length}</span></div>
            {promises.loading ? <p className="muted">Loading…</p> : open.length ? open.slice(0, wide ? 25 : 10).map(p => (
              <div className="row" key={p.id}>
                <div className="grow"><div className="title">{p.title}</div>
                  <div className="small muted">{p.direction === 'made_by_me' ? 'You promised' : 'They promised'}{p.contacts ? <> · <Link to={`/app/contacts?c=${p.contacts.id}`}>{p.contacts.full_name}</Link></> : ''}</div></div>
                <span className="pill">{dueLabel(p.due_on)}</span>
                <button className="btn sm" onClick={() => complete(p.id)} aria-label={`Mark “${p.title}” done`}><Icon name="check" size="sm" /> Done</button>
              </div>
            )) : <div className="empty"><strong>No open promises</strong>Commitments from your meetings are tracked here with their source.</div>}
          </section>
        </div>

        <div className="stack">
          <section className="card capture-card" aria-labelledby="cap-h">
            <div className="card-head"><h2 id="cap-h"><Icon name="mic" /> Capture</h2><Link className="small" to="/app/meetings">Meetings →</Link></div>
            <p className="small muted" style={{ marginBottom: 12 }}>Record a meeting or a voice note any time. Everything is reviewed before it’s filed.</p>
            <div className="capture-actions">
              <Link className="btn primary big" to="/app/capture?kind=meeting"><Icon name="mic" /> Record meeting</Link>
              <Link className="btn big" to="/app/capture?kind=notes"><Icon name="edit" /> Record notes</Link>
            </div>
          </section>
          {remaining > 0 && !counts.loading && (
            <section className="card checklist" aria-labelledby="setup-h">
              <div className="card-head"><h2 id="setup-h"><Icon name="check" /> Get set up</h2><span className="pill blue">{steps.length - remaining} of {steps.length} done</span></div>
              {steps.map(s => (
                <div className={`row ${s.done ? 'done' : ''}`} key={s.title}>
                  <span className="dot">{s.done && <Icon name="check" size="sm" />}</span>
                  <div className="grow"><div className="title">{s.title}</div>{!s.done && <div className="small muted">{s.sub}</div>}</div>
                  {!s.done && <Link className="btn sm" to={s.to}>{s.cta}</Link>}
                </div>
              ))}
            </section>
          )}
        </div>
      </div>
    </>
  );
}
