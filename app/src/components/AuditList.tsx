import { useState } from 'react';
import { Link } from 'react-router-dom';
import { dateTime } from '../lib/data';
import { describeEvent, undoChange, type AuditEvent } from '../lib/audit';

/**
 * A list of automatic changes. With canUndo (your own changes) each one has Undo and shows the entry's
 * title from titles; otherwise (a manager's team view) only the kind of change, never the content.
 */
export function AuditList({ events, titles, canUndo, ownerName, onUndone, empty }: {
  events: AuditEvent[]; titles?: Map<string, string | null>; canUndo?: boolean;
  ownerName?: (id: string) => string; onUndone?: () => void; empty: string;
}) {
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  async function undo(id: string) {
    setBusy(id); setError('');
    const err = await undoChange(id);
    setBusy('');
    if (err) setError(err); else onUndone?.();
  }
  if (!events.length) return <p className="muted small">{empty}</p>;
  return (
    <>
      {error && <div className="alert error" role="alert">{error}</div>}
      {events.map(e => {
        const { what, changed } = describeEvent(e);
        const title = e.entity_id ? titles?.get(e.entity_id) : null;
        return (
          <div className="row" key={e.id}>
            <div className="grow">
              <div className={`title clamp1 ${e.undone_at ? 'muted' : ''}`}>{what}{title ? ` · “${title}”` : ''}</div>
              <div className="small muted">
                {ownerName ? `${ownerName(e.owner_id)} · ` : ''}{changed ? `${changed} · ` : ''}{dateTime(e.created_at)}
                {e.undone_at && ' · undone'}
                {e.contact_id && <> · <Link to={`/app/contacts?c=${e.contact_id}`}>Open contact</Link></>}
              </div>
            </div>
            {canUndo && !e.undone_at && (
              <button className="btn sm" onClick={() => undo(e.id)} disabled={!!busy} aria-label={`Undo: ${what}`}>{busy === e.id ? 'Undoing…' : 'Undo'}</button>
            )}
          </div>
        );
      })}
    </>
  );
}
