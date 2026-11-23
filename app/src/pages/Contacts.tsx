import { useEffect, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { companyName, dateTime, daysAgo, dueLabel, useQuery, useWorkspaces, type Company, type Contact, type Visibility } from '../lib/data';
import { WorkspaceFields } from '../components/Fields';
import { Icon } from '../components/Icon';
import { initials } from '../components/AppShell';
import { undoChange } from '../lib/audit';

const CONTACT_SELECT = 'id,owner_id,team_id,visibility,full_name,title,company_id,priority,starred,notes,last_engagement_at,last_outreach_at,companies(id,name),contact_identities(id,kind,value)';

export function Contacts() {
  const sb = requireSupabase();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get('c');
  const editing = params.get('edit') === '1' || selectedId === 'new';
  const [q, setQ] = useState('');
  const contacts = useQuery<Contact[]>(() => sb.from('contacts').select(CONTACT_SELECT).order('starred', { ascending: false }).order('full_name').overrideTypes<Contact[], { merge: false }>(), []);
  const list = (contacts.data ?? []).filter(c => !q || `${c.full_name} ${c.title ?? ''} ${companyName(c)}`.toLowerCase().includes(q.toLowerCase()));
  const selected = (contacts.data ?? []).find(c => c.id === selectedId) ?? null;
  const open = (id: string | null, edit = false) => setParams(id ? { c: id, ...(edit ? { edit: '1' } : {}) } : {});

  return (
    <>
      <div className="page-head">
        <div><h1>Contacts</h1><p>Only approved contacts get relationship history, promises and reports.</p></div>
        <button className="btn primary" onClick={() => open('new')}><Icon name="plus" size="sm" /> Add contact</button>
      </div>
      {contacts.error && <div className="alert error" role="alert">{contacts.error}</div>}
      <div className={`split ${selectedId ? 'has-detail' : ''}`}>
        <section className="card list-pane" aria-label="Contact list">
          <input className="search" type="search" placeholder="Search contacts" value={q} onChange={e => setQ(e.target.value)} aria-label="Search contacts" />
          {contacts.loading ? <p className="muted">Loading…</p> : list.length ? list.map(c => (
            <button key={c.id} className={`list-row ${c.id === selectedId ? 'active' : ''}`} onClick={() => open(c.id)}>
              <span className="avatar sm">{initials(c.full_name)}</span>
              <span className="grow"><span className="title">{c.full_name} {c.starred && <Icon name="star" size="sm" label="Starred" />}</span>
                <span className="small muted">{[c.title, companyName(c)].filter(Boolean).join(' · ') || 'No company'}</span></span>
              {c.team_id && <span className="pill blue">Team</span>}
            </button>
          )) : (
            <div className="empty"><strong>{q ? 'No matches' : 'No contacts yet'}</strong>{q ? 'Try a different search.' : 'Add the customers and partners LuMaCo should keep up to date.'}</div>
          )}
        </section>
        <section className="detail-pane">
          {selectedId === 'new' ? <ContactForm onDone={id => { void contacts.reload(); open(id); }} onCancel={() => open(null)} />
            : selected && editing ? <ContactForm contact={selected} onDone={id => { void contacts.reload(); open(id); }} onCancel={() => open(selected.id)} />
            : selected ? <ContactDetail contact={selected} onEdit={() => open(selected.id, true)} onDeleted={() => { void contacts.reload(); open(null); }} onBack={() => open(null)} onChanged={() => void contacts.reload()} />
            : <div className="card empty"><strong>Select a contact</strong>Or add a new one to start tracking a relationship.</div>}
        </section>
      </div>
    </>
  );
}

function ContactForm({ contact, onDone, onCancel }: { contact?: Contact; onDone: (id: string) => void; onCancel: () => void }) {
  const sb = requireSupabase();
  const { user } = useAuth();
  const workspaces = useWorkspaces(user?.id, sb);
  const companies = useQuery<Company[]>(() => sb.from('companies').select('id,name').order('name'), []);
  const mine = !contact || contact.owner_id === user?.id;
  const [f, setF] = useState(() => ({
    full_name: contact?.full_name ?? '', title: contact?.title ?? '', company: contact ? companyName(contact) : '',
    emails: (contact?.contact_identities ?? []).filter(i => i.kind === 'email').map(i => i.value).join(', '),
    phone: (contact?.contact_identities ?? []).find(i => i.kind === 'phone')?.value ?? '',
    priority: contact?.priority ?? 'Medium', starred: contact?.starred ?? false, notes: contact?.notes ?? '',
    team_id: contact?.team_id ?? null as string | null, visibility: (contact?.visibility ?? 'private') as Visibility,
  }));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF(x => ({ ...x, [k]: e.target.value }));

  async function save(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!f.full_name.trim()) { setError('Name is required.'); return; }
    const emails = f.emails.split(/[,\s;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    const bad = emails.find(em => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em));
    if (bad) { setError(`“${bad}” isn’t a valid email address.`); return; }
    setBusy(true);
    try {
      const scope = { team_id: f.team_id, visibility: f.team_id ? f.visibility : 'private' as Visibility };
      let company_id: string | null = null;
      const cname = f.company.trim();
      if (cname) {
        const existing = (companies.data ?? []).find(c => c.name.toLowerCase() === cname.toLowerCase());
        if (existing) company_id = existing.id;
        else {
          const { data, error } = await sb.from('companies').insert({ name: cname, ...scope }).select('id').single();
          if (error) throw error; company_id = data.id;
        }
      }
      const row = { full_name: f.full_name.trim(), title: f.title.trim() || null, company_id, priority: f.priority, starred: f.starred, notes: f.notes.trim() || null, ...scope };
      const res = contact
        ? await sb.from('contacts').update(row).eq('id', contact.id).select('id').single()
        : await sb.from('contacts').insert(row).select('id').single();
      if (res.error) throw res.error;
      const id = res.data.id as string;
      // Replace verified identities used to match emails, calls and texts.
      await sb.from('contact_identities').delete().eq('contact_id', id);
      const ids = [...emails.map(v => ({ contact_id: id, kind: 'email', value: v, verified: true })),
        ...(f.phone.trim() ? [{ contact_id: id, kind: 'phone', value: f.phone.replace(/[^\d+]/g, ''), verified: true }] : [])];
      if (ids.length) { const { error } = await sb.from('contact_identities').insert(ids); if (error) throw error; }
      onDone(id);
    } catch (err) { setError(friendlyError(err)); setBusy(false); }
  }

  if (!mine) return <div className="card"><div className="alert info">This contact belongs to a teammate. Only its creator can edit it.</div><button className="btn" onClick={onCancel}>Back</button></div>;
  return (
    <form className="card" onSubmit={save}>
      <div className="card-head"><h2><Icon name="users" /> {contact ? 'Edit contact' : 'New contact'}</h2></div>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="field-row">
        <label className="field"><span>Full name</span><input required value={f.full_name} onChange={set('full_name')} autoFocus={!contact} /></label>
        <label className="field"><span>Title</span><input value={f.title} onChange={set('title')} placeholder="e.g. Project Manager" /></label>
      </div>
      <label className="field"><span>Company</span>
        <input list="company-list" value={f.company} onChange={set('company')} placeholder="Type to pick or create" />
        <datalist id="company-list">{(companies.data ?? []).map(c => <option key={c.id} value={c.name} />)}</datalist>
      </label>
      <div className="field-row">
        <label className="field"><span>Email addresses</span><input value={f.emails} onChange={set('emails')} placeholder="name@company.com, other@company.com" />
          <span className="hint">Used to match their emails and calendar invites.</span></label>
        <label className="field"><span>Phone</span><input type="tel" value={f.phone} onChange={set('phone')} placeholder="(402) 555-0148" /></label>
      </div>
      <div className="field-row">
        <label className="field"><span>Priority</span><select value={f.priority} onChange={set('priority')}><option>High</option><option>Medium</option><option>Low</option></select></label>
        <label className="field check"><input type="checkbox" checked={f.starred} onChange={e => setF(x => ({ ...x, starred: e.target.checked }))} /><span>Starred (detailed reports)</span></label>
      </div>
      <label className="field"><span>Notes</span><textarea rows={3} value={f.notes} onChange={set('notes')} /></label>
      <WorkspaceFields workspaces={workspaces} teamId={f.team_id} visibility={f.visibility} onChange={(team_id, visibility) => setF(x => ({ ...x, team_id, visibility }))} />
      <div className="btn-row">
        <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : contact ? 'Save changes' : 'Add contact'}</button>
        <button type="button" className="btn" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

type TimelineRow = { id: string; kind: string; occurred_at: string; title: string | null; summary: string | null; source: string };
type PromiseRow = { id: string; title: string; due_on: string | null; direction: string; status: string };
type MeetingLink = { meetings: { id: string; title: string | null; started_at: string; kind: string; status: string } | null };

function ContactDetail({ contact, onEdit, onDeleted, onBack, onChanged }: { contact: Contact; onEdit: () => void; onDeleted: () => void; onBack: () => void; onChanged: () => void }) {
  const sb = requireSupabase();
  const { user } = useAuth();
  const timeline = useQuery<TimelineRow[]>(() => sb.from('interactions').select('id,kind,occurred_at,title,summary,source').eq('contact_id', contact.id).is('undone_at', null).order('occurred_at', { ascending: false }).limit(30), [contact.id]);
  // Your automatic (synced) entries can be undone from here.
  const tIds = (timeline.data ?? []).map(t => t.id);
  const undoable = useQuery<{ id: string; entity_id: string }[]>(() => tIds.length && user
    ? sb.from('audit_events').select('id,entity_id').eq('owner_id', user.id).eq('action', 'interaction_added').is('undone_at', null).in('entity_id', tIds)
    : Promise.resolve({ data: [], error: null }), [tIds.join(','), user?.id]);
  const undoFor = new Map((undoable.data ?? []).map(u => [u.entity_id, u.id]));
  const promises = useQuery<PromiseRow[]>(() => sb.from('promises').select('id,title,due_on,direction,status').eq('contact_id', contact.id).eq('status', 'open').order('due_on'), [contact.id]);
  const meetings = useQuery<MeetingLink[]>(() => sb.from('meeting_contacts').select('meetings(id,title,started_at,kind,status)').eq('contact_id', contact.id).overrideTypes<MeetingLink[], { merge: false }>(), [contact.id]);
  const [error, setError] = useState('');
  useEffect(() => setError(''), [contact.id]);
  const emails = (contact.contact_identities ?? []).filter(i => i.kind === 'email');
  const phone = (contact.contact_identities ?? []).find(i => i.kind === 'phone');
  const mine = contact.owner_id === user?.id;

  async function remove() {
    if (!confirm(`Delete ${contact.full_name}? Their timeline entries and promises are deleted too. This can’t be undone.`)) return;
    const { error } = await sb.from('contacts').delete().eq('id', contact.id);
    if (error) setError(friendlyError(error)); else onDeleted();
  }
  async function undo(eventId: string) {
    if (!confirm('Remove this entry from the timeline? The contact’s last outreach and engagement go back to what they were without it, and later syncs won’t add it again.')) return;
    const err = await undoChange(eventId);
    if (err) setError(err); else { void timeline.reload(); onChanged(); }
  }
  async function complete(id: string) {
    const { error } = await sb.from('promises').update({ status: 'completed', completed_at: new Date().toISOString() }).eq('id', id);
    if (error) setError(friendlyError(error)); else void promises.reload();
  }

  return (
    <div className="stack">
      <section className="card">
        <button className="btn sm back-btn" onClick={onBack}>← All contacts</button>
        <div className="profile-head">
          <span className="avatar lg">{initials(contact.full_name)}</span>
          <div className="grow">
            <h2>{contact.full_name} {contact.starred && <Icon name="star" size="sm" label="Starred" />}</h2>
            <p className="muted">{[contact.title, companyName(contact)].filter(Boolean).join(' · ') || 'No company'}</p>
            <div className="pill-line"><span className="pill">{contact.priority} priority</span><span className="pill">{contact.team_id ? (contact.visibility === 'team' ? 'Shared with team' : contact.visibility === 'managers' ? 'Managers can see' : 'Only you') : 'Personal'}</span></div>
          </div>
          {mine && <div className="btn-row"><button className="btn sm" onClick={onEdit}><Icon name="edit" size="sm" /> Edit</button><button className="btn sm danger" onClick={remove}><Icon name="trash" size="sm" /> Delete</button></div>}
        </div>
        {error && <div className="alert error" role="alert">{error}</div>}
        <div className="facts">
          <div><span>Last engagement</span><b>{daysAgo(contact.last_engagement_at)}</b></div>
          <div><span>Email</span><b>{emails.length ? emails.map(e => <a key={e.id} href={`mailto:${e.value}`}>{e.value}</a>) : '—'}</b></div>
          <div><span>Phone</span><b>{phone ? <a href={`tel:${phone.value}`}>{phone.value}</a> : '—'}</b></div>
        </div>
        {contact.notes && <p className="small" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{contact.notes}</p>}
      </section>
      <section className="card">
        <div className="card-head"><h2><Icon name="clipboard" /> Open Promises</h2><Link className="btn sm" to="/app/capture"><Icon name="mic" size="sm" /> Record</Link></div>
        {(promises.data ?? []).length ? promises.data!.map(p => (
          <div className="row" key={p.id}>
            <div className="grow"><div className="title">{p.title}</div><div className="small muted">{p.direction === 'made_by_me' ? 'You promised' : 'They promised'}</div></div>
            <span className="pill">{dueLabel(p.due_on)}</span>
            <button className="btn sm" onClick={() => complete(p.id)}><Icon name="check" size="sm" /> Done</button>
          </div>
        )) : <p className="muted small">No open promises.</p>}
      </section>
      <section className="card">
        <div className="card-head"><h2><Icon name="calendar" /> Timeline</h2></div>
        {(timeline.data ?? []).length ? timeline.data!.map(t => (
          <div className="row" key={t.id}>
            <span className="row-icon"><Icon name={t.kind === 'meeting' ? 'mic' : t.kind === 'email' ? 'mail' : t.kind === 'call' ? 'phone' : 'file'} size="sm" /></span>
            <div className="grow"><div className="title">{t.title || t.kind}</div>{t.summary && <div className="small muted">{t.summary}</div>}</div>
            <span className="small muted">{dateTime(t.occurred_at)}</span>
            {undoFor.has(t.id) && <button className="btn sm" onClick={() => undo(undoFor.get(t.id)!)} title="Undo this automatic update" aria-label={`Remove “${t.title || t.kind}” from the timeline`}>Undo</button>}
          </div>
        )) : <p className="muted small">Nothing yet. Meetings, notes, emails and calls with {contact.full_name.split(' ')[0]} will appear here.</p>}
        {!!meetings.data?.length && (
          <p className="small muted" style={{ marginTop: 10 }}>Meetings: {meetings.data.filter(m => m.meetings).map((m, i) => (
            <span key={m.meetings!.id}>{i > 0 && ', '}<Link to={`/app/meetings/${m.meetings!.id}`}>{m.meetings!.title || 'Untitled'}</Link></span>
          ))}</p>
        )}
      </section>
    </div>
  );
}
