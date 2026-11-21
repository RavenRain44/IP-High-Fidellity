import { useState } from 'react';
import { Link } from 'react-router-dom';
import { requireSupabase } from '../lib/supabase';
import { dateTime, duration, PROCESSING, useQuery, type Meeting } from '../lib/data';
import { Icon } from '../components/Icon';

type Row = Pick<Meeting, 'id' | 'kind' | 'title' | 'started_at' | 'duration_sec' | 'status' | 'team_id' | 'visibility'> & { meeting_contacts: { contact_id: string }[] };
const STATUS_LABEL: Record<string, [string, string]> = {
  uploaded: ['Processing', 'blue'], transcribing: ['Transcribing', 'blue'], extracting: ['Drafting notes', 'blue'],
  ready: ['Needs review', 'gold'], reviewed: ['Filed', 'ok'], failed: ['Failed', ''], recording: ['Recording', 'blue'],
};

export function Meetings() {
  const sb = requireSupabase();
  const [filter, setFilter] = useState<'all' | 'review'>('all');
  const [q, setQ] = useState('');
  const rows = useQuery<Row[]>(() => sb.from('meetings').select('id,kind,title,started_at,duration_sec,status,team_id,visibility,meeting_contacts(contact_id)').order('started_at', { ascending: false }).limit(200).overrideTypes<Row[], { merge: false }>(), []);
  const list = (rows.data ?? [])
    .filter(r => filter === 'all' || r.status === 'ready' || r.status === 'failed' || PROCESSING.includes(r.status))
    .filter(r => !q || (r.title ?? '').toLowerCase().includes(q.toLowerCase()));
  const pending = (rows.data ?? []).filter(r => r.status === 'ready').length;

  return (
    <>
      <div className="page-head">
        <div><h1>Meetings</h1><p>Recorded meetings and voice notes. Drafts wait here until you review them.</p></div>
        <Link className="btn primary" to="/app/capture"><Icon name="mic" size="sm" /> Record</Link>
      </div>
      {rows.error && <div className="alert error" role="alert">{rows.error}</div>}
      <section className="card">
        <div className="toolbar">
          <div className="segmented small" role="tablist" aria-label="Filter">
            <button role="tab" aria-selected={filter === 'all'} className={filter === 'all' ? 'on' : ''} onClick={() => setFilter('all')}>All</button>
            <button role="tab" aria-selected={filter === 'review'} className={filter === 'review' ? 'on' : ''} onClick={() => setFilter('review')}>Needs review {pending ? `(${pending})` : ''}</button>
          </div>
          <input className="search" type="search" placeholder="Search titles" value={q} onChange={e => setQ(e.target.value)} aria-label="Search meetings" />
        </div>
        {rows.loading ? <p className="muted">Loading…</p> : list.length ? list.map(r => {
          const [label, tone] = STATUS_LABEL[r.status] ?? [r.status, ''];
          return (
            <Link className="list-row" key={r.id} to={`/app/meetings/${r.id}`}>
              <span className="row-icon"><Icon name={r.kind === 'notes' ? 'edit' : 'mic'} size="sm" /></span>
              <span className="grow"><span className="title">{r.title || (r.kind === 'notes' ? 'Voice note' : 'Meeting')}</span>
                <span className="small muted">{dateTime(r.started_at)}{r.duration_sec ? ` · ${duration(r.duration_sec)}` : ''}{r.meeting_contacts.length ? ` · ${r.meeting_contacts.length} ${r.meeting_contacts.length === 1 ? 'person' : 'people'}` : ''}</span></span>
              <span className={`pill ${tone}`}>{label}</span>
            </Link>
          );
        }) : (
          <div className="empty"><strong>{filter === 'review' ? 'Nothing waiting for review' : 'No meetings yet'}</strong>
            {filter === 'review' ? 'New recordings appear here once their draft is ready.' : <>Record a meeting or a voice note to get started. <Link to="/app/capture">Record now</Link></>}</div>
        )}
      </section>
    </>
  );
}
