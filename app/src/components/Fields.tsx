import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Contact, Visibility, Workspace } from '../lib/data';
import { companyName } from '../lib/data';
import { Icon } from './Icon';

/** "Save to" (personal workspace or a team) and, for teams, who can see it. */
export function WorkspaceFields({ workspaces, teamId, visibility, onChange }: {
  workspaces: Workspace[]; teamId: string | null; visibility: Visibility;
  onChange: (teamId: string | null, visibility: Visibility) => void;
}) {
  if (workspaces.length <= 1) return <p className="small muted" style={{ marginBottom: 14 }}><Icon name="shield" size="sm" /> Saved to your personal workspace (only you can see it).</p>;
  return (
    <div className="field-row">
      <label className="field"><span>Save to</span>
        <select value={teamId ?? ''} onChange={e => onChange(e.target.value || null, e.target.value ? (visibility === 'private' ? 'team' : visibility) : 'private')}>
          {workspaces.map(w => <option key={w.id ?? 'personal'} value={w.id ?? ''}>{w.id ? `Team: ${w.name}` : 'Personal workspace'}</option>)}
        </select>
      </label>
      {teamId && (
        <label className="field"><span>Who can see it</span>
          <select value={visibility} onChange={e => onChange(teamId, e.target.value as Visibility)}>
            <option value="team">Everyone on the team</option>
            <option value="managers">Managers only</option>
            <option value="private">Only me</option>
          </select>
        </label>
      )}
    </div>
  );
}

/** Multi-select for contacts: chips for the selection and a searchable checklist. */
export function PeoplePicker({ contacts, selected, onChange, highlight = [], label = 'People' }: {
  contacts: Contact[]; selected: string[]; onChange: (ids: string[]) => void; highlight?: string[]; label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);
  const byId = useMemo(() => new Map(contacts.map(c => [c.id, c])), [contacts]);
  const list = contacts.filter(c => !q || `${c.full_name} ${companyName(c)}`.toLowerCase().includes(q.toLowerCase()));
  const toggle = (cid: string) => onChange(selected.includes(cid) ? selected.filter(x => x !== cid) : [...selected, cid]);

  return (
    <div className="field" ref={box}>
      <span id={`${id}-l`}>{label}</span>
      <button type="button" className="picker-btn" aria-haspopup="listbox" aria-expanded={open} aria-labelledby={`${id}-l`} onClick={() => setOpen(o => !o)}>
        <span className="chips">
          {selected.length ? selected.map((cid, i) => (
            <span className="chip" key={cid}>{byId.get(cid)?.full_name ?? 'Unknown'}{i === 0 && selected.length > 1 && <small> primary</small>}</span>
          )) : <span className="muted">No one selected</span>}
        </span>
        <Icon name="down" size="sm" />
      </button>
      {open && (
        <div className="picker-menu" role="listbox" aria-multiselectable="true" aria-labelledby={`${id}-l`}>
          <input autoFocus type="search" placeholder="Search contacts" value={q} onChange={e => setQ(e.target.value)} aria-label="Search contacts" />
          {list.length ? list.map(c => (
            <label className="picker-opt" key={c.id}>
              <input type="checkbox" checked={selected.includes(c.id)} onChange={() => toggle(c.id)} />
              <span className="grow"><b>{c.full_name}</b><small className="muted">{[c.title, companyName(c)].filter(Boolean).join(' · ')}</small></span>
              {highlight.includes(c.id) && <span className="pill ok">Mentioned</span>}
            </label>
          )) : <p className="small muted" style={{ padding: 8 }}>{contacts.length ? 'No matches.' : 'No contacts yet. Add them on the Contacts page.'}</p>}
        </div>
      )}
    </div>
  );
}
