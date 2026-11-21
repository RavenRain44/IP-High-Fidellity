import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { dateTime, duration, dueLabel, PROCESSING, useQuery, useWorkspaces, type Contact, type DraftPromise, type Meeting as MeetingRow, type Project, type Visibility } from '../lib/data';
import { startProcessing } from '../lib/meetings';
import { PeoplePicker, WorkspaceFields } from '../components/Fields';
import { Icon } from '../components/Icon';
import { Loading } from '../components/AppShell';

const MEETING_SELECT = 'id,owner_id,team_id,visibility,kind,title,started_at,duration_sec,project_id,status,transcript_text,notes,typed_notes,audio_path,keep_audio,error,suggestions,reviewed_at,meeting_contacts(contact_id)';
const STEPS: { status: string; label: string }[] = [
  { status: 'uploaded', label: 'Uploaded' }, { status: 'transcribing', label: 'Transcribing' },
  { status: 'extracting', label: 'Drafting notes' }, { status: 'ready', label: 'Ready to review' },
];

export function Meeting() {
  const { id } = useParams();
  const sb = requireSupabase();
  const nav = useNavigate();
  const loc = useLocation();
  const meeting = useQuery<MeetingRow | null>(() => sb.from('meetings').select(MEETING_SELECT).eq('id', id!).maybeSingle().overrideTypes<MeetingRow | null, { merge: false }>(), [id]);
  const contacts = useQuery<Contact[]>(() => sb.from('contacts').select('id,full_name,title,owner_id,team_id,visibility,companies(id,name)').order('full_name').overrideTypes<Contact[], { merge: false }>(), []);
  const projects = useQuery<Project[]>(() => sb.from('projects').select('id,name,owner_id,team_id,visibility,status,progress,company_id,updated_at,description').order('name').overrideTypes<Project[], { merge: false }>(), []);
  const [startError, setStartError] = useState<string>((loc.state as { processError?: string } | null)?.processError ?? '');
  const [editing, setEditing] = useState(false);
  const m = meeting.data;

  // Poll while the server is working.
  useEffect(() => {
    if (!m || !PROCESSING.includes(m.status)) return;
    const t = setInterval(() => void meeting.reload(), 2500);
    return () => clearInterval(t);
  }, [m?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  if (meeting.loading && !m) return <Loading />;
  if (meeting.error) return <div className="alert error" role="alert">{meeting.error}</div>;
  if (!m) return <div className="card empty"><strong>Meeting not found</strong><Link to="/app/meetings">Back to meetings</Link></div>;

  async function retry() {
    setStartError('');
    const r = await startProcessing(m!.id);
    if (r.error) setStartError(r.error); else void meeting.reload();
  }
  async function remove() {
    if (!confirm('Delete this meeting? Its recording, transcript and draft are deleted. Filed promises and timeline entries stay.')) return;
    if (m!.audio_path) await sb.storage.from('recordings').remove([m!.audio_path]);
    const { error } = await sb.from('meetings').delete().eq('id', m!.id);
    if (error) setStartError(friendlyError(error)); else nav('/app/meetings', { replace: true });
  }

  const head = (
    <div className="page-head">
      <div>
        <Link to="/app/meetings" className="small">← Meetings</Link>
        <h1>{m.title || (m.kind === 'notes' ? 'Voice note' : 'Meeting')}</h1>
        <p>{dateTime(m.started_at)}{m.duration_sec ? ` · ${duration(m.duration_sec)}` : ''} · {m.kind === 'notes' ? 'Voice note' : 'Meeting'}</p>
      </div>
      <button className="btn danger" onClick={remove}><Icon name="trash" size="sm" /> Delete</button>
    </div>
  );

  if (PROCESSING.includes(m.status) || m.status === 'failed') {
    const idx = STEPS.findIndex(s => s.status === m.status);
    return (
      <>
        {head}
        <section className="card processing" aria-live="polite">
          {m.status === 'failed' ? (
            <><div className="alert error" role="alert"><strong>Processing failed.</strong> {m.error}</div>
              <div className="btn-row"><button className="btn primary" onClick={retry}><Icon name="refresh" size="sm" /> Try again</button></div></>
          ) : (
            <>
              <div className="spinner" />
              <h2>{STEPS[idx]?.label ?? 'Working'}…</h2>
              <p className="muted">This usually takes under a minute. You can leave this page; the meeting will wait in Meetings for review.</p>
              <ol className="progress-steps">{STEPS.map((s, i) => <li key={s.status} className={i < idx ? 'done' : i === idx ? 'on' : ''}>{s.label}</li>)}</ol>
              {(startError || m.status === 'uploaded') && (
                <div className="alert info" style={{ marginTop: 14 }}>{startError || 'Waiting for the processing service to start.'}
                  <div className="btn-row" style={{ marginTop: 8 }}><button className="btn sm" onClick={retry}><Icon name="refresh" size="sm" /> Retry</button></div></div>
              )}
            </>
          )}
          {startError && m.status === 'failed' && <div className="alert error">{startError}</div>}
        </section>
      </>
    );
  }

  if (m.status === 'ready' || editing) {
    return <>{head}<Review meeting={m} contacts={contacts.data ?? []} projects={projects.data ?? []} onFiled={() => { setEditing(false); void meeting.reload(); }} onCancel={editing ? () => setEditing(false) : undefined} /></>;
  }
  return <>{head}<Filed meeting={m} contacts={contacts.data ?? []} projects={projects.data ?? []} onEdit={() => setEditing(true)} /></>;
}

type EditablePromise = DraftPromise & { include: boolean };

function Review({ meeting, contacts, projects, onFiled, onCancel }: {
  meeting: MeetingRow; contacts: Contact[]; projects: Project[]; onFiled: () => void; onCancel?: () => void;
}) {
  const sb = requireSupabase();
  const { user } = useAuth();
  const workspaces = useWorkspaces(user?.id, sb);
  const s = meeting.suggestions;
  const filed = meeting.status === 'reviewed';
  const [title, setTitle] = useState(meeting.title || s?.title || '');
  const [notes, setNotes] = useState(filed ? meeting.notes ?? '' : s?.notes || meeting.typed_notes || '');
  const [people, setPeople] = useState<string[]>(filed ? (meeting.meeting_contacts ?? []).map(x => x.contact_id) : s?.contact_ids ?? []);
  const [projectId, setProjectId] = useState<string>((filed ? meeting.project_id : s?.project_id) ?? '');
  const [transcript, setTranscript] = useState(meeting.transcript_text ?? '');
  const [promises, setPromises] = useState<EditablePromise[]>(filed ? [] : (s?.promises ?? []).map(p => ({ ...p, include: true })));
  const [teamId, setTeamId] = useState<string | null>(meeting.team_id);
  const [visibility, setVisibility] = useState<Visibility>(meeting.visibility);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const why = s?.why;
  // Editing a filed meeting: start from its current open promises (re-filing replaces them).
  useEffect(() => {
    if (!filed) return;
    void sb.from('promises').select('title,direction,due_on,contact_id,evidence').eq('source', 'meeting').eq('source_ref', meeting.id).eq('status', 'open')
      .then(({ data }) => setPromises((data ?? []).map(p => ({ ...(p as DraftPromise), evidence: p.evidence ?? '', include: true }))));
  }, [filed, meeting.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const hint = (kind: 'contacts' | 'project') => {
    if (filed || !why) return null;
    const w = why[kind];
    if (w === 'transcript') return <p className="hint ok"><Icon name="sparkle" size="sm" /> Found in the {meeting.transcript_text ? 'conversation' : 'notes'}</p>;
    if (w === 'recent') return <p className="hint"><Icon name="calendar" size="sm" /> Not mentioned, so suggested from your last meeting{why.recent_title ? `: ${why.recent_title}` : ''}</p>;
    return <p className="hint">{kind === 'contacts' ? 'No one identified. Pick people, or leave it as a personal note.' : 'No project identified.'}</p>;
  };
  const setP = (i: number, patch: Partial<EditablePromise>) => setPromises(list => list.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function file() {
    setError('');
    const chosen = promises.filter(p => p.include && p.title.trim());
    if (chosen.length && !people.length) { setError('Pick at least one person so the promises have someone to belong to, or untick them.'); return; }
    setBusy(true);
    const { error } = await sb.rpc('finalize_meeting', {
      p_meeting: meeting.id, p_title: title, p_notes: notes, p_transcript: transcript || null,
      p_contact_ids: people, p_project_id: projectId || null, p_team_id: teamId, p_visibility: teamId ? visibility : 'private',
      p_promises: chosen.map(({ include: _include, ...p }) => ({ ...p, contact_id: p.contact_id || people[0] || null })),
    });
    setBusy(false);
    if (error) setError(friendlyError(error)); else onFiled();
  }

  return (
    <div className="grid2 review">
      <div className="stack">
        <section className="card">
          <div className="card-head"><h2><Icon name="sparkle" /> {filed ? 'Edit meeting' : 'Review the draft'}</h2>{!filed && <span className="pill gold">AI draft · check before filing</span>}</div>
          <label className="field"><span>Title</span><input value={title} onChange={e => setTitle(e.target.value)} /></label>
          <label className="field"><span>Notes</span><textarea rows={14} value={notes} onChange={e => setNotes(e.target.value)} className="notes-box" /></label>
        </section>
        {(
          <section className="card">
            <div className="card-head"><h2><Icon name="clipboard" /> {filed ? 'Open promises from this meeting' : 'Promises heard'}</h2><button className="btn sm" onClick={() => setPromises(l => [...l, { title: '', direction: 'made_by_me', due_on: null, contact_id: people[0] ?? null, evidence: '', include: true }])}><Icon name="plus" size="sm" /> Add</button></div>
            {promises.length ? promises.map((p, i) => (
              <div className={`promise-edit ${p.include ? '' : 'off'}`} key={i}>
                <label className="check-line"><input type="checkbox" checked={p.include} onChange={e => setP(i, { include: e.target.checked })} /> Keep</label>
                <input aria-label="Promise" value={p.title} onChange={e => setP(i, { title: e.target.value })} placeholder="What was promised" />
                <div className="field-row tight">
                  <select aria-label="Who promised" value={p.direction} onChange={e => setP(i, { direction: e.target.value as DraftPromise['direction'] })}><option value="made_by_me">You promised</option><option value="made_to_me">They promised</option></select>
                  <input aria-label="Due date" type="date" value={p.due_on ?? ''} onChange={e => setP(i, { due_on: e.target.value || null })} />
                  <select aria-label="With" value={p.contact_id ?? ''} onChange={e => setP(i, { contact_id: e.target.value || null })}>
                    <option value="">{people.length ? 'First person' : 'Choose person'}</option>
                    {contacts.filter(c => people.includes(c.id)).map(c => <option key={c.id} value={c.id}>{c.full_name}</option>)}
                  </select>
                </div>
                {p.evidence && <p className="hint">“{p.evidence}”</p>}
              </div>
            )) : <p className="small muted">No commitments were heard. Add one if something was promised.</p>}
          </section>
        )}
      </div>
      <div className="stack">
        <section className="card">
          <div className="card-head"><h2><Icon name="users" /> People & project</h2></div>
          <PeoplePicker contacts={contacts} selected={people} onChange={setPeople} highlight={why?.contacts === 'transcript' ? s?.contact_ids : []} />
          {hint('contacts')}
          <label className="field"><span>Project</span>
            <select value={projectId} onChange={e => setProjectId(e.target.value)}>
              <option value="">No project</option>{projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select></label>
          {hint('project')}
          <WorkspaceFields workspaces={workspaces} teamId={teamId} visibility={visibility} onChange={(t, v) => { setTeamId(t); setVisibility(v); }} />
          {error && <div className="alert error" role="alert">{error}</div>}
          <div className="btn-row">
            <button className="btn primary" onClick={file} disabled={busy}>{busy ? 'Filing…' : filed ? 'Save changes' : 'Approve & file'}</button>
            {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>Filing adds this to each person’s timeline{projectId ? ' and the project file' : ''}{promises.some(p => p.include) ? ', and saves the promises you kept' : ''}.</p>
        </section>
        {meeting.transcript_text != null && (
          <details className="card">
            <summary><b>Transcript</b> <span className="small muted">(edit to fix names or mistakes)</span></summary>
            <textarea rows={14} value={transcript} onChange={e => setTranscript(e.target.value)} className="notes-box" style={{ width: '100%', marginTop: 10 }} />
          </details>
        )}
      </div>
    </div>
  );
}

function Filed({ meeting, contacts, projects, onEdit }: { meeting: MeetingRow; contacts: Contact[]; projects: Project[]; onEdit: () => void }) {
  const sb = requireSupabase();
  const { user } = useAuth();
  const promises = useQuery<{ id: string; title: string; due_on: string | null; status: string; direction: string }[]>(() =>
    sb.from('promises').select('id,title,due_on,status,direction').eq('source', 'meeting').eq('source_ref', meeting.id), [meeting.id, meeting.reviewed_at]);
  const people = (meeting.meeting_contacts ?? []).map(x => contacts.find(c => c.id === x.contact_id)).filter(Boolean) as Contact[];
  const project = projects.find(p => p.id === meeting.project_id);
  return (
    <div className="grid2">
      <section className="card">
        <div className="card-head"><h2><Icon name="file" /> Notes</h2>{meeting.owner_id === user?.id && <button className="btn sm" onClick={onEdit}><Icon name="edit" size="sm" /> Edit</button>}</div>
        <div className="notes-view">{meeting.notes || 'No notes.'}</div>
        {meeting.transcript_text && <details style={{ marginTop: 14 }}><summary><b>Transcript</b></summary><pre className="transcript">{meeting.transcript_text}</pre></details>}
      </section>
      <div className="stack">
        <section className="card">
          <div className="card-head"><h2><Icon name="users" /> Filed to</h2><span className="pill ok">Filed</span></div>
          {people.length ? <div className="chips">{people.map(c => <Link key={c.id} className="chip" to={`/app/contacts?c=${c.id}`}>{c.full_name}</Link>)}</div> : <p className="small muted">No people (personal note).</p>}
          {project && <p style={{ marginTop: 10 }}><Icon name="briefcase" size="sm" /> <Link to={`/app/projects?p=${project.id}`}>{project.name}</Link></p>}
          <p className="small muted" style={{ marginTop: 10 }}>{meeting.team_id ? (meeting.visibility === 'team' ? 'Shared with the team' : meeting.visibility === 'managers' ? 'Visible to managers' : 'Only you') : 'Personal workspace (only you)'}</p>
        </section>
        <section className="card">
          <div className="card-head"><h2><Icon name="clipboard" /> Promises</h2></div>
          {(promises.data ?? []).length ? promises.data!.map(p => (
            <div className="row" key={p.id}><div className="grow"><div className="title">{p.title}</div><div className="small muted">{p.direction === 'made_by_me' ? 'You promised' : 'They promised'} · {p.status}</div></div><span className="pill">{dueLabel(p.due_on)}</span></div>
          )) : <p className="small muted">None from this meeting.</p>}
        </section>
      </div>
    </div>
  );
}
