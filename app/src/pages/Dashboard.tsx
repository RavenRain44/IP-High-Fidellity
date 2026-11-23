import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { dateTime, dueLabel, useQuery, type Connection } from '../lib/data';
import { canAddEvents, connectResult, useAutoSync, type MeetingSuggestion } from '../lib/google';
import { MeetingSuggestionRow } from '../components/MeetingSuggestionRow';
import { Icon } from '../components/Icon';

type Counts = { connections: number; contacts: number; meetings: number; teams: number };
type OpenPromise = { id: string; title: string; due_on: string | null; direction: string; contacts: { id: string; full_name: string } | null };
type Pending = { id: string; title: string | null; kind: string; status: string; started_at: string; error: string | null };
type Thread = { id: string; subject: string | null; snippet: string | null; last_from: string | null; last_message_at: string; web_link: string | null };
type Suggested = { id: string; title: string; due_on: string | null; direction: string; evidence: string | null; contacts: { id: string; full_name: string } | null };
type CalEvent = { id: string; title: string | null; starts_at: string; ends_at: string | null; all_day: boolean; location: string | null; meeting_url: string | null; html_link: string | null; contact_ids: string[] };

function eventTime(e: CalEvent): string {
  const d = new Date(e.starts_at);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const days = Math.floor((new Date(d).setHours(0, 0, 0, 0) - today.getTime()) / 86400000);
  const day = days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return e.all_day ? `${day} · all day` : `${day} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
}

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

  const conns = useQuery<Connection[]>(() => sb.from('integration_connections').select('id,provider,status,account_email,last_synced_at,last_error,scopes,last_check'), []);
  const threads = useQuery<Thread[]>(() => sb.from('email_threads').select('id,subject,snippet,last_from,last_message_at,web_link')
    .eq('needs_reply', true).is('dismissed_at', null).order('last_message_at', { ascending: false }).limit(wide ? 15 : 8), [wide]);
  const suggested = useQuery<Suggested[]>(() => sb.from('promises').select('id,title,due_on,direction,evidence,contacts(id,full_name)').eq('owner_id', uid).eq('status', 'suggested')
    .order('created_at', { ascending: false }).limit(10).overrideTypes<Suggested[], { merge: false }>(), [uid]);
  const events = useQuery<CalEvent[]>(() => sb.from('calendar_events').select('id,title,starts_at,ends_at,all_day,location,meeting_url,html_link,contact_ids')
    .gte('starts_at', new Date(Date.now() - 60 * 60_000).toISOString()).lt('starts_at', new Date(Date.now() + 7 * 86400000).toISOString())
    .or('my_response.is.null,my_response.neq.declined').order('starts_at').limit(wide ? 14 : 6), [wide]);
  const meetingSugg = useQuery<MeetingSuggestion[]>(() => sb.from('meeting_suggestions')
    .select('id,title,starts_at,ends_at,time_known,location,attendee_emails,contact_ids,evidence,thread_link,connection_id')
    .eq('status', 'suggested').gte('starts_at', new Date(Date.now() - 86400000).toISOString()).order('starts_at').limit(10), []);
  const eventContactIds = [...new Set([...(events.data ?? []), ...(meetingSugg.data ?? [])].flatMap(e => e.contact_ids))];
  const names = useQuery<{ id: string; full_name: string }[]>(() => sb.from('contacts').select('id,full_name').in('id', eventContactIds.length ? eventContactIds : ['00000000-0000-0000-0000-000000000000']), [eventContactIds.join()]);
  const nameOf = (id: string) => names.data?.find(n => n.id === id)?.full_name;
  const google = (conns.data ?? []).filter(c => c.provider === 'google');
  useAutoSync(conns.data, () => { void threads.reload(); void suggested.reload(); void events.reload(); void promises.reload(); void meetingSugg.reload(); void conns.reload(); });

  // Back from Google (e.g. after allowing LuMaCo to add events): show the result once.
  const [params, setParams] = useSearchParams();
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(() => connectResult(params));
  const cleared = useRef(false);
  useEffect(() => { if (!cleared.current && params.get('google')) { cleared.current = true; setParams({}, { replace: true }); } }, [params, setParams]);
  const meetingDone = (text: string) => { setNotice({ ok: true, text }); void meetingSugg.reload(); void events.reload(); };

  async function dismissThread(id: string) {
    const { error } = await sb.from('email_threads').update({ dismissed_at: new Date().toISOString() }).eq('id', id);
    if (error) setError(friendlyError(error)); else void threads.reload();
  }
  async function decide(id: string, keep: boolean) {
    const { error } = await sb.from('promises').update({ status: keep ? 'open' : 'dismissed' }).eq('id', id);
    if (error) setError(friendlyError(error)); else { void suggested.reload(); if (keep) void promises.reload(); }
  }

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
    { done: !!n?.connections, title: 'Connect your email and calendar', sub: 'Google now; Outlook next. Only email with your contacts is read.', to: '/app/integrations', cta: 'Connect' },
    { done: !!n?.teams, title: 'Create or join a team (optional)', sub: 'Share work records with your team. Private notes stay private.', to: '/app/teams', cta: 'Teams' },
  ];
  const remaining = steps.filter(s => !s.done).length;
  const open = promises.data ?? [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const urgent = open.filter(p => p.due_on && new Date(p.due_on + 'T00:00:00').getTime() - today.getTime() <= 86400000);
  const review = pending.data ?? [];
  const loadErr = error || counts.error || promises.error || pending.error || threads.error || suggested.error || events.error || meetingSugg.error;
  const plannedMeetings = meetingSugg.data ?? [];
  const replies = threads.data ?? [];
  const toReview = suggested.data ?? [];

  return (
    <>
      <div className="page-head">
        <div><h1>{greet}{first ? `, ${first}` : ''}.</h1><p>{new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}</p></div>
      </div>
      {loadErr && <div className="alert error" role="alert">{loadErr}</div>}
      {notice && <div className={`alert ${notice.ok ? 'ok' : 'error'}`} role="status">{notice.text}</div>}

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
            {plannedMeetings.map(m => (
              <MeetingSuggestionRow key={m.id} m={m} names={m.contact_ids.map(nameOf).filter(Boolean) as string[]}
                canWrite={canAddEvents(google.find(c => c.id === m.connection_id))} onDone={meetingDone} />
            ))}
            {replies.map(t => (
              <div className="row" key={t.id}>
                <span className="row-icon"><Icon name="mail" size="sm" /></span>
                <div className="grow"><div className="title">Reply to {t.last_from || 'contact'}: {t.subject || '(No subject)'}</div>
                  <div className="small muted clamp1">{dateTime(t.last_message_at)}{t.snippet ? ` · ${t.snippet}` : ''}</div></div>
                <div className="btn-row nowrap">
                  {t.web_link && <a className="btn sm" href={t.web_link} target="_blank" rel="noopener noreferrer">Open</a>}
                  <button className="btn sm" onClick={() => dismissThread(t.id)} aria-label={`No reply needed: ${t.subject ?? ''}`} title="No reply needed">Done</button>
                </div>
              </div>
            ))}
            {toReview.map(p => (
              <div className="row" key={p.id}>
                <span className="row-icon"><Icon name="sparkle" size="sm" /></span>
                <div className="grow"><div className="title">{p.title}</div>
                  <div className="small muted">Found in email · {p.direction === 'made_by_me' ? 'You promised' : 'They promised'}{p.contacts ? ` · ${p.contacts.full_name}` : ''}{p.due_on ? ` · ${dueLabel(p.due_on)}` : ''}</div>
                  {p.evidence && <div className="small muted clamp1">“{p.evidence}”</div>}</div>
                <div className="btn-row nowrap">
                  <button className="btn sm primary" onClick={() => decide(p.id, true)} aria-label={`Keep promise: ${p.title}`}>Keep</button>
                  <button className="btn sm" onClick={() => decide(p.id, false)} aria-label={`Dismiss promise: ${p.title}`}>Dismiss</button>
                </div>
              </div>
            ))}
            {!review.length && !urgent.length && !replies.length && !toReview.length && !plannedMeetings.length && !promises.loading && (
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
          {google.length > 0 && (
            <section className="card" aria-labelledby="up-h">
              <div className="card-head"><h2 id="up-h"><Icon name="calendar" /> Upcoming meetings</h2><span className="small muted">Next 7 days</span></div>
              {(events.data ?? []).length ? events.data!.map(e => {
                const people = e.contact_ids.map(nameOf).filter(Boolean) as string[];
                return (
                  <div className="row" key={e.id}>
                    <div className="grow"><div className="title">{e.title || '(No title)'}</div>
                      <div className="small muted">{eventTime(e)}{people.length ? ` · ${people.join(', ')}` : ''}</div></div>
                    <div className="btn-row nowrap">
                      {e.meeting_url && <a className="btn sm" href={e.meeting_url} target="_blank" rel="noopener noreferrer">Join</a>}
                      <Link className="btn sm" to={`/app/capture?kind=meeting&event=${e.id}&title=${encodeURIComponent(e.title ?? '')}`} aria-label={`Record ${e.title ?? 'meeting'}`}><Icon name="mic" size="sm" /> Record</Link>
                    </div>
                  </div>
                );
              }) : <p className="muted small">{events.loading ? 'Loading…' : 'No meetings in the next 7 days.'}</p>}
            </section>
          )}
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
