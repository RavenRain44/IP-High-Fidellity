import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { companyName, dateTime, dueLabel, useQuery, useWorkspaces, type Company, type Contact, type Project, type Visibility } from '../lib/data';
import { PeoplePicker, WorkspaceFields } from '../components/Fields';
import { Icon } from '../components/Icon';

const PROJECT_SELECT = 'id,owner_id,team_id,visibility,name,description,status,progress,company_id,updated_at,companies(id,name),project_contacts(contact_id)';
const STATUSES = ['Planning', 'Active', 'At risk', 'On hold', 'Won', 'Lost', 'Complete'];

export function Projects() {
  const sb = requireSupabase();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('p');
  const editing = params.get('edit') === '1' || selectedId === 'new';
  const projects = useQuery<Project[]>(() => sb.from('projects').select(PROJECT_SELECT).order('updated_at', { ascending: false }).overrideTypes<Project[], { merge: false }>(), []);
  const contacts = useQuery<Contact[]>(() => sb.from('contacts').select('id,full_name,title,owner_id,team_id,visibility,companies(id,name)').order('full_name').overrideTypes<Contact[], { merge: false }>(), []);
  const selected = (projects.data ?? []).find(p => p.id === selectedId) ?? null;
  const open = (id: string | null, edit = false) => setParams(id ? { p: id, ...(edit ? { edit: '1' } : {}) } : {});
  const done = (id: string) => { void projects.reload(); open(id); };

  return (
    <>
      <div className="page-head">
        <div><h1>Projects</h1><p>Each project keeps a file of the meetings, promises and activity linked to it.</p></div>
        <button className="btn primary" onClick={() => open('new')}><Icon name="plus" size="sm" /> New project</button>
      </div>
      {projects.error && <div className="alert error" role="alert">{projects.error}</div>}
      <div className={`split ${selectedId ? 'has-detail' : ''}`}>
        <section className="card list-pane" aria-label="Project list">
          {projects.loading ? <p className="muted">Loading…</p> : (projects.data ?? []).length ? projects.data!.map(p => (
            <button key={p.id} className={`list-row ${p.id === selectedId ? 'active' : ''}`} onClick={() => open(p.id)}>
              <span className="row-icon"><Icon name="briefcase" size="sm" /></span>
              <span className="grow"><span className="title">{p.name}</span><span className="small muted">{[companyName(p), p.status].filter(Boolean).join(' · ')}</span></span>
              <span className="small muted">{p.progress}%</span>
            </button>
          )) : <div className="empty"><strong>No projects yet</strong>Create one to group meetings, promises and people.</div>}
        </section>
        <section className="detail-pane">
          {selectedId === 'new' ? <ProjectForm contacts={contacts.data ?? []} onDone={done} onCancel={() => open(null)} />
            : selected && editing ? <ProjectForm project={selected} contacts={contacts.data ?? []} onDone={done} onCancel={() => open(selected.id)} />
            : selected ? <ProjectFile project={selected} contacts={contacts.data ?? []} onEdit={() => open(selected.id, true)} onBack={() => open(null)} onDeleted={() => { void projects.reload(); open(null); }} />
            : <div className="card empty"><strong>Select a project</strong>Its file shows everything filed to it, newest first.</div>}
        </section>
      </div>
    </>
  );
}

function ProjectForm({ project, contacts, onDone, onCancel }: { project?: Project; contacts: Contact[]; onDone: (id: string) => void; onCancel: () => void }) {
  const sb = requireSupabase();
  const { user } = useAuth();
  const workspaces = useWorkspaces(user?.id, sb);
  const companies = useQuery<Company[]>(() => sb.from('companies').select('id,name').order('name'), []);
  const [f, setF] = useState(() => ({
    name: project?.name ?? '', company: project ? companyName(project) : '', description: project?.description ?? '',
    status: project?.status ?? 'Active', progress: project?.progress ?? 0,
    people: (project?.project_contacts ?? []).map(x => x.contact_id),
    team_id: project?.team_id ?? null as string | null, visibility: (project?.visibility ?? 'private') as Visibility,
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (project && project.owner_id !== user?.id) return <div className="card"><div className="alert info">Only this project’s creator can edit it.</div><button className="btn" onClick={onCancel}>Back</button></div>;

  async function save(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!f.name.trim()) { setError('Name is required.'); return; }
    setBusy(true);
    try {
      const scope = { team_id: f.team_id, visibility: f.team_id ? f.visibility : 'private' as Visibility };
      let company_id: string | null = null;
      if (f.company.trim()) {
        const hit = (companies.data ?? []).find(c => c.name.toLowerCase() === f.company.trim().toLowerCase());
        if (hit) company_id = hit.id;
        else { const r = await sb.from('companies').insert({ name: f.company.trim(), ...scope }).select('id').single(); if (r.error) throw r.error; company_id = r.data.id; }
      }
      const row = { name: f.name.trim(), description: f.description.trim() || null, status: f.status, progress: Math.max(0, Math.min(100, Number(f.progress) || 0)), company_id, ...scope };
      const res = project ? await sb.from('projects').update(row).eq('id', project.id).select('id').single() : await sb.from('projects').insert(row).select('id').single();
      if (res.error) throw res.error;
      const id = res.data.id as string;
      await sb.from('project_contacts').delete().eq('project_id', id);
      if (f.people.length) { const r = await sb.from('project_contacts').insert(f.people.map(contact_id => ({ project_id: id, contact_id }))); if (r.error) throw r.error; }
      onDone(id);
    } catch (err) { setError(friendlyError(err)); setBusy(false); }
  }

  return (
    <form className="card" onSubmit={save}>
      <div className="card-head"><h2><Icon name="briefcase" /> {project ? 'Edit project' : 'New project'}</h2></div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <label className="field"><span>Project name</span><input required value={f.name} onChange={e => setF(x => ({ ...x, name: e.target.value }))} autoFocus={!project} /></label>
      <label className="field"><span>Company</span><input list="project-company-list" value={f.company} onChange={e => setF(x => ({ ...x, company: e.target.value }))} placeholder="Type to pick or create" />
        <datalist id="project-company-list">{(companies.data ?? []).map(c => <option key={c.id} value={c.name} />)}</datalist></label>
      <label className="field"><span>Description</span><textarea rows={3} value={f.description} onChange={e => setF(x => ({ ...x, description: e.target.value }))} /></label>
      <div className="field-row">
        <label className="field"><span>Status</span><select value={f.status} onChange={e => setF(x => ({ ...x, status: e.target.value }))}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select></label>
        <label className="field"><span>Progress ({f.progress}%)</span><input type="range" min={0} max={100} step={5} value={f.progress} onChange={e => setF(x => ({ ...x, progress: Number(e.target.value) }))} /></label>
      </div>
      <PeoplePicker contacts={contacts} selected={f.people} onChange={people => setF(x => ({ ...x, people }))} />
      <WorkspaceFields workspaces={workspaces} teamId={f.team_id} visibility={f.visibility} onChange={(team_id, visibility) => setF(x => ({ ...x, team_id, visibility }))} />
      <div className="btn-row"><button className="btn primary" disabled={busy}>{busy ? 'Saving…' : project ? 'Save changes' : 'Create project'}</button><button type="button" className="btn" onClick={onCancel}>Cancel</button></div>
    </form>
  );
}

type FileEntry = { id: string; kind: string; date: string; title: string; text: string; link?: string };

function ProjectFile({ project, contacts, onEdit, onBack, onDeleted }: { project: Project; contacts: Contact[]; onEdit: () => void; onBack: () => void; onDeleted: () => void }) {
  const sb = requireSupabase();
  const { user } = useAuth();
  const meetings = useQuery<{ id: string; title: string | null; started_at: string; notes: string | null; kind: string }[]>(() =>
    sb.from('meetings').select('id,title,started_at,notes,kind').eq('project_id', project.id).eq('status', 'reviewed').order('started_at', { ascending: false }), [project.id]);
  const activity = useQuery<{ id: string; kind: string; occurred_at: string; title: string | null; summary: string | null; source: string }[]>(() =>
    sb.from('interactions').select('id,kind,occurred_at,title,summary,source').eq('project_id', project.id).neq('source', 'recording').order('occurred_at', { ascending: false }).limit(50), [project.id]);
  const promises = useQuery<{ id: string; title: string; due_on: string | null; contact_id: string | null }[]>(() =>
    sb.from('promises').select('id,title,due_on,contact_id').eq('project_id', project.id).eq('status', 'open').order('due_on'), [project.id]);
  const [error, setError] = useState('');
  const byId = new Map(contacts.map(c => [c.id, c]));
  const people = (project.project_contacts ?? []).map(x => byId.get(x.contact_id)).filter(Boolean) as Contact[];
  const firstLine = (s: string | null) => (s ?? '').split('\n').map(l => l.trim()).find(l => l && !/^summary$/i.test(l)) ?? '';
  const entries: FileEntry[] = [
    ...(meetings.data ?? []).map(m => ({ id: m.id, kind: m.kind === 'notes' ? 'Voice notes' : 'Meeting notes', date: m.started_at, title: m.title || 'Meeting', text: firstLine(m.notes), link: `/app/meetings/${m.id}` })),
    ...(activity.data ?? []).map(a => ({ id: a.id, kind: a.kind[0].toUpperCase() + a.kind.slice(1), date: a.occurred_at, title: a.title || a.kind, text: a.summary ?? '' })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const latest = entries[0];

  async function remove() {
    if (!confirm(`Delete the project “${project.name}”? Meetings and promises stay, but lose their link to it.`)) return;
    const { error } = await sb.from('projects').delete().eq('id', project.id);
    if (error) setError(friendlyError(error)); else onDeleted();
  }

  return (
    <div className="stack">
      <section className="card project-file">
        <button className="btn sm back-btn" onClick={onBack}>← All projects</button>
        <div className="profile-head">
          <span className="avatar lg"><Icon name="briefcase" /></span>
          <div className="grow">
            <div className="small muted">{companyName(project)}</div>
            <h2>{project.name}</h2>
            <div className="pill-line"><span className="pill blue">{project.status}</span>{latest && <span className="pill gold">Updated {dateTime(latest.date)} · {latest.kind}</span>}</div>
          </div>
          {project.owner_id === user?.id && <div className="btn-row"><button className="btn sm" onClick={onEdit}><Icon name="edit" size="sm" /> Edit</button><button className="btn sm danger" onClick={remove}><Icon name="trash" size="sm" /></button></div>}
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="progress" aria-label={`${project.progress}% complete`}><b style={{ width: `${project.progress}%` }} /></div>
        {project.description && <p style={{ marginTop: 10 }}>{project.description}</p>}
        {latest?.text && <div className="latest"><strong>Latest</strong><p>{latest.text}</p></div>}
      </section>
      <div className="grid2 even">
        <section className="card"><div className="card-head"><h2><Icon name="clipboard" /> Open Promises</h2></div>
          {(promises.data ?? []).length ? promises.data!.map(p => (
            <div className="row" key={p.id}><div className="grow"><div className="title">{p.title}</div><div className="small muted">{byId.get(p.contact_id ?? '')?.full_name ?? ''}</div></div><span className="pill">{dueLabel(p.due_on)}</span></div>
          )) : <p className="small muted">None open.</p>}
        </section>
        <section className="card"><div className="card-head"><h2><Icon name="users" /> People</h2></div>
          {people.length ? <div className="chips">{people.map(c => <Link key={c.id} className="chip" to={`/app/contacts?c=${c.id}`}>{c.full_name}</Link>)}</div> : <p className="small muted">No people linked.</p>}
        </section>
      </div>
      <section className="card">
        <div className="card-head"><h2><Icon name="file" /> Activity filed to this project</h2><span className="pill">{entries.length}</span></div>
        {entries.length ? entries.map(e => (
          <div className="row" key={e.kind + e.id}>
            <span className="row-icon"><Icon name={e.kind.includes('notes') ? 'mic' : e.kind === 'Email' ? 'mail' : 'file'} size="sm" /></span>
            <div className="grow"><div className="title">{e.link ? <Link to={e.link}>{e.title}</Link> : e.title}</div>{e.text && <div className="small muted">{e.text}</div>}</div>
            <span className="small muted">{dateTime(e.date)}</span>
          </div>
        )) : <p className="small muted">Nothing filed yet. Record a meeting and pick this project when you review it.</p>}
      </section>
    </div>
  );
}
