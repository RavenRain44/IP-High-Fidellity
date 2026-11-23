import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { requireSupabase } from '../lib/supabase';
import { useQuery, type Connection } from '../lib/data';
import { canAddEvents, connectGoogle, connectResult, disconnectGoogle, lastCheck, syncGoogle, type SyncResult } from '../lib/google';
import { GoogleLogo, Icon, MicrosoftLogo } from '../components/Icon';

type Card = {
  id: Connection['provider'] | 'ai';
  name: string;
  logo: ReactNode;
  what: string[];
  note: string;
  live?: boolean;
};

const CARDS: Card[] = [
  { id: 'google', name: 'Google', logo: <GoogleLogo />, live: true,
    what: ['Gmail: email with your contacts on their timelines, replies you owe in Needs Attention, promises suggested for review', 'Google Calendar: upcoming meetings with contacts, one tap to record'],
    note: 'Read-only. LuMaCo only downloads email to or from addresses saved on your contacts; nothing else in your inbox is read.' },
  { id: 'microsoft', name: 'Microsoft 365', logo: <MicrosoftLogo />, what: ['Outlook mail: sort conversations, detect replies and promises', 'Outlook calendar: meetings, briefings, attendance'],
    note: 'Coming next. Work accounts may need your IT admin to approve LuMaCo.' },
  { id: 'twilio', name: 'Business phone & SMS', logo: <Icon name="phone" />, what: ['A LuMaCo business number for calls and texts', 'Calls over 2:00 count as engagement; consent prompt on recorded calls'],
    note: 'Coming later. Phones don’t let apps read your normal call log or texts, so calls and texts go through a business number.' },
  { id: 'ai', name: 'Transcription & AI notes', logo: <Icon name="sparkle" />, live: true, what: ['Speech-to-text with speaker labels (Deepgram)', 'Notes, people, project and promises extracted for your review (Claude)'],
    note: 'Audio is deleted after transcription unless you choose to keep it.' },
];

function summary(r: SyncResult): string {
  if (r.error) return r.error;
  if (r.skipped) return 'A sync is already running.';
  const parts = [
    r.events != null && `${r.events} calendar event${r.events === 1 ? '' : 's'}`,
    r.messages != null && `${r.messages} new email${r.messages === 1 ? '' : 's'} with contacts`,
    r.suggestions ? `${r.suggestions} promise${r.suggestions === 1 ? '' : 's'} to review` : null,
    r.meetings ? `${r.meetings} meeting${r.meetings === 1 ? '' : 's'} to review` : null,
  ].filter(Boolean);
  const check = r.check_error ? ` The promise and meeting check failed: ${r.check_error}`
    : r.checked ? ` Checked ${r.checked} new email${r.checked === 1 ? '' : 's'} for promises and meetings.` : '';
  return `Synced ${r.email}: ${parts.join(', ') || 'nothing new'}.${check}${r.warning ? ` ${r.warning}` : ''}`;
}

export function Integrations() {
  const sb = requireSupabase();
  const [params, setParams] = useSearchParams();
  const conns = useQuery<Connection[]>(() => sb.from('integration_connections').select('id,provider,status,account_email,last_synced_at,last_error,scopes,last_check').order('connected_at'), []);
  const byProvider = (p: string) => (conns.data ?? []).filter(c => c.provider === p);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(() => connectResult(params));
  const [busy, setBusy] = useState('');

  async function sync() {
    setBusy('sync');
    const r = await syncGoogle();
    setBusy('');
    if (r.error) setNotice({ ok: false, text: r.error });
    else setNotice({ ok: !(r.results ?? []).some(x => x.error || x.check_error), text: (r.results ?? []).map(summary).join(' ') || 'No Google account connected.' });
    void conns.reload();
  }

  // Back from Google's consent screen: show the result once, then run the first sync.
  const handled = useRef(false);
  useEffect(() => {
    if (handled.current || !params.get('google')) return;
    handled.current = true;
    const ok = params.get('google') === 'connected';
    setParams({}, { replace: true });
    if (ok) void sync();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function connect(calendarWrite = false) {
    setBusy('connect');
    const err = await connectGoogle({ calendarWrite });
    if (err) { setNotice({ ok: false, text: err }); setBusy(''); }
  }

  async function disconnect(c: Connection) {
    if (!confirm(`Disconnect ${c.account_email}? LuMaCo stops reading it and deletes its synced calendar events, email threads and email timeline entries. Promises you kept stay.`)) return;
    setBusy(c.id);
    const err = await disconnectGoogle(c.id);
    setBusy('');
    setNotice(err ? { ok: false, text: err } : { ok: true, text: `${c.account_email} disconnected.` });
    void conns.reload();
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Integrations</h1><p>Connect the tools you already use. LuMaCo reads them so you don’t have to update a CRM.</p></div>
      </div>
      {conns.error && <div className="alert error" role="alert">{conns.error}</div>}
      {notice && <div className={`alert ${notice.ok ? 'ok' : 'error'}`} role="status">{notice.text}</div>}
      <div className="grid3">
        {CARDS.map(card => {
          const mine = card.id === 'ai' ? [] : byProvider(card.id);
          return (
            <section className="card integration" key={card.id} aria-labelledby={`int-${card.id}`}>
              <div className="head"><span className="logo">{card.logo}</span><h2 id={`int-${card.id}`}>{card.name}</h2></div>
              <ul>{card.what.map(w => <li key={w}>{w}</li>)}</ul>
              <p className="small muted">{card.note}</p>
              {mine.map(c => (
                <div className="row conn-row" key={c.id}>
                  <div className="grow"><div className="title">{c.account_email ?? 'Connected account'}</div>
                    <div className={`small ${c.last_error ? 'error-text' : 'muted'}`}>{c.status === 'syncing' ? 'Syncing…' : c.last_error ? c.last_error : c.last_synced_at ? `Synced ${new Date(c.last_synced_at).toLocaleString()}` : 'Waiting for first sync'}</div>
                    {(() => { const lc = lastCheck(c); return lc && <div className={`small ${lc.failed ? 'error-text' : 'muted'}`}>Email check{lc.at.getTime() ? ` (${lc.at.toLocaleString()})` : ''}: {lc.text}</div>; })()}
                    {card.id === 'google' && <div className="small muted">Calendar: {canAddEvents(c) ? 'can add meetings you confirm' : <>read-only · <button className="link-btn" onClick={() => connect(true)} disabled={!!busy}>Allow adding events</button></>}</div>}
                  </div>
                  {/reconnect/i.test(c.last_error ?? '')
                    ? <button className="btn sm primary" onClick={() => connect()} disabled={!!busy}>Reconnect</button>
                    : <span className={`pill ${c.status === 'connected' ? 'ok' : ''}`}>{c.status === 'error' ? 'Error' : c.status === 'syncing' ? 'Syncing' : 'Connected'}</span>}
                  {card.id === 'google' && <button className="btn sm" onClick={() => disconnect(c)} disabled={!!busy} aria-label={`Disconnect ${c.account_email}`}>{busy === c.id ? 'Disconnecting…' : 'Disconnect'}</button>}
                </div>
              ))}
              <div className="foot">
                <span className="pill">{card.id === 'ai' ? 'Included' : mine.length ? `${mine.length} connected` : card.live ? 'Not connected' : 'Coming soon'}</span>
                {card.id === 'google' ? (
                  <div className="btn-row">
                    {mine.length > 0 && <button className="btn sm" onClick={sync} disabled={!!busy}><Icon name="refresh" size="sm" /> {busy === 'sync' ? 'Syncing…' : 'Sync now'}</button>}
                    <button className={`btn sm ${mine.length ? '' : 'primary'}`} onClick={() => connect()} disabled={!!busy}>{busy === 'connect' ? 'Opening Google…' : mine.length ? 'Add account' : 'Connect Google'}</button>
                  </div>
                ) : card.id !== 'ai' && <button className="btn sm" disabled title="Coming in a later release">Connect</button>}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
