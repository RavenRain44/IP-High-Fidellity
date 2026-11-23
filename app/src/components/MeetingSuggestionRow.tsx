import { useState } from 'react';
import { requireSupabase, friendlyError } from '../lib/supabase';
import { addMeetingToCalendar, calendarTemplateLink, connectGoogle, type MeetingSuggestion } from '../lib/google';
import { Icon } from './Icon';

const pad = (n: number) => String(n).padStart(2, '0');
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const DURATIONS = [15, 30, 45, 60, 90, 120];

function when(m: MeetingSuggestion): string {
  const d = new Date(m.starts_at);
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  return m.time_known ? `${day} · ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}` : `${day} · time not set`;
}

/**
 * A meeting LuMaCo found in an email. Nothing happens until the user reviews it: they can fix the
 * details, choose whether to invite the contact, and then add it to Google Calendar (or dismiss it).
 */
export function MeetingSuggestionRow({ m, names, canWrite, onDone }: {
  m: MeetingSuggestion; names: string[]; canWrite: boolean; onDone: (message: string) => void;
}) {
  const sb = requireSupabase();
  const start = new Date(m.starts_at);
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(m.title);
  const [date, setDate] = useState(localDate(start));
  const [time, setTime] = useState(m.time_known ? localTime(start) : '');
  const [minutes, setMinutes] = useState(() => {
    const mins = m.ends_at ? Math.round((new Date(m.ends_at).getTime() - start.getTime()) / 60000) : 60;
    return DURATIONS.includes(mins) ? mins : 60;
  });
  const [location, setLocation] = useState(m.location ?? '');
  const [invite, setInvite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsPermission, setNeedsPermission] = useState(false);

  const startsAt = date && time ? new Date(`${date}T${time}`) : null;
  const valid = !!title.trim() && !!startsAt && !isNaN(startsAt.getTime());
  const endsAt = startsAt ? new Date(startsAt.getTime() + minutes * 60000) : null;
  const who = names.length ? names.join(', ') : m.attendee_emails.join(', ');

  async function add() {
    if (!valid || !startsAt || !endsAt) return;
    setBusy(true); setError('');
    const r = await addMeetingToCalendar({ suggestion_id: m.id, title: title.trim(), starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), location, invite });
    setBusy(false);
    if (r.ok) onDone(r.invited ? `“${title.trim()}” added to your calendar and ${who} invited.` : `“${title.trim()}” added to your calendar.`);
    else { setError(r.error ?? 'Couldn’t add the meeting.'); setNeedsPermission(!!r.needsPermission); }
  }
  async function setStatus(status: 'dismissed' | 'added', message: string) {
    const { error } = await sb.from('meeting_suggestions').update({ status }).eq('id', m.id);
    if (error) setError(friendlyError(error)); else onDone(message);
  }
  async function allow() {
    setBusy(true);
    const err = await connectGoogle({ calendarWrite: true, returnTo: '/app' });
    if (err) { setError(err); setBusy(false); }
  }
  const template = valid && startsAt && endsAt ? calendarTemplateLink({
    title: title.trim(), starts_at: startsAt.toISOString(), ends_at: endsAt.toISOString(), location,
    details: m.evidence ? `From an email: “${m.evidence}”` : undefined, guests: invite ? m.attendee_emails : undefined,
  }) : null;

  return (
    <div className="row suggestion">
      <span className="row-icon"><Icon name="calendar" size="sm" /></span>
      <div className="grow">
        <div className="title">{m.title}</div>
        <div className="small muted">Meeting found in email · {when(m)}{who ? ` · ${who}` : ''}</div>
        {m.evidence && !open && <div className="small muted clamp1">“{m.evidence}”</div>}
        {open && (
          <form className="suggest-form" onSubmit={e => { e.preventDefault(); void add(); }}>
            {m.evidence && <p className="small muted">From the email: “{m.evidence}”{m.thread_link && <> · <a href={m.thread_link} target="_blank" rel="noopener noreferrer">Open email</a></>}</p>}
            <label className="field"><span>Title</span><input value={title} onChange={e => setTitle(e.target.value)} required maxLength={300} /></label>
            <div className="field-row">
              <label className="field"><span>Date</span><input type="date" value={date} onChange={e => setDate(e.target.value)} required /></label>
              <label className="field"><span>Start time{!m.time_known && ' (not in the email)'}</span><input type="time" value={time} onChange={e => setTime(e.target.value)} required /></label>
              <label className="field"><span>Length</span>
                <select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>{DURATIONS.map(d => <option key={d} value={d}>{d < 60 ? `${d} min` : `${d / 60} hr`}</option>)}</select></label>
            </div>
            <label className="field"><span>Location (optional)</span><input value={location} onChange={e => setLocation(e.target.value)} maxLength={300} /></label>
            {m.attendee_emails.length > 0 && (
              <label className="check-line"><input type="checkbox" checked={invite} onChange={e => setInvite(e.target.checked)} />
                <span>Send a calendar invitation to {who} ({m.attendee_emails.join(', ')})</span></label>
            )}
            {error && <p className="mic-error" role="alert">{error}</p>}
            {needsPermission ? (
              <div className="permission-box">
                <p className="small">LuMaCo can only read your calendar right now. Allow it to add meetings you confirm (Google will ask), or add this one yourself in Google Calendar.</p>
                <div className="btn-row">
                  <button type="button" className="btn sm primary" onClick={allow} disabled={busy}>{busy ? 'Opening Google…' : 'Allow adding events'}</button>
                  {template && <a className="btn sm" href={template} target="_blank" rel="noopener noreferrer"
                    onClick={() => void setStatus('added', 'Opened in Google Calendar. Save it there to finish.')}>Open in Google Calendar</a>}
                </div>
              </div>
            ) : (
              <div className="btn-row">
                <button className="btn sm primary" type="submit" disabled={!valid || busy}><Icon name="calendar" size="sm" /> {busy ? 'Adding…' : invite ? 'Add and send invite' : 'Add to my calendar'}</button>
                <button type="button" className="btn sm" onClick={() => setOpen(false)} disabled={busy}>Cancel</button>
                {!canWrite && <span className="small muted">Google will ask once for permission to add events.</span>}
              </div>
            )}
          </form>
        )}
      </div>
      {!open && (
        <div className="btn-row nowrap">
          <button className="btn sm primary" onClick={() => setOpen(true)} aria-label={`Review meeting: ${m.title}`}>Review</button>
          <button className="btn sm" onClick={() => void setStatus('dismissed', 'Meeting suggestion dismissed.')} aria-label={`Dismiss meeting: ${m.title}`}>Dismiss</button>
        </div>
      )}
    </div>
  );
}
