import type { ReactNode } from 'react';
import { requireSupabase } from '../lib/supabase';
import { useQuery, type Connection } from '../lib/data';
import { GoogleLogo, Icon, MicrosoftLogo } from '../components/Icon';

type Card = {
  id: Connection['provider'] | 'ai';
  name: string;
  logo: ReactNode;
  what: string[];
  note: string;
};

const CARDS: Card[] = [
  { id: 'google', name: 'Google', logo: <GoogleLogo />, what: ['Gmail: sort conversations, detect replies and promises', 'Google Calendar: meetings, briefings, attendance'],
    note: 'Read-only access. Only approved contacts are tracked.' },
  { id: 'microsoft', name: 'Microsoft 365', logo: <MicrosoftLogo />, what: ['Outlook mail: sort conversations, detect replies and promises', 'Outlook calendar: meetings, briefings, attendance'],
    note: 'Work accounts may need your IT admin to approve LuMaCo.' },
  { id: 'twilio', name: 'Business phone & SMS', logo: <Icon name="phone" />, what: ['A LuMaCo business number for calls and texts', 'Calls over 2:00 count as engagement; consent prompt on recorded calls'],
    note: 'Phones don’t let apps read your normal call log or texts, so calls and texts go through a business number.' },
  { id: 'ai', name: 'Transcription & AI notes', logo: <Icon name="sparkle" />, what: ['Speech-to-text with speaker labels (Deepgram)', 'Notes, people, project and promises extracted for your review (Claude)'],
    note: 'Audio is deleted after transcription unless you choose to keep it.' },
];

export function Integrations() {
  const sb = requireSupabase();
  const conns = useQuery<Connection[]>(() => sb.from('integration_connections').select('id,provider,status,account_email,last_synced_at,last_error'), []);
  const byProvider = (p: string) => (conns.data ?? []).filter(c => c.provider === p);

  return (
    <>
      <div className="page-head">
        <div><h1>Integrations</h1><p>Connect the tools you already use. LuMaCo reads them so you don’t have to update a CRM.</p></div>
      </div>
      {conns.error && <div className="alert error" role="alert">{conns.error}</div>}
      <div className="alert info" role="status">
        Connecting accounts is the next part of the build. Sign-in, teams and your secure workspace are live now; the Connect buttons below switch on as each integration is released.
      </div>
      <div className="grid3">
        {CARDS.map(card => {
          const mine = card.id === 'ai' ? [] : byProvider(card.id);
          return (
            <section className="card integration" key={card.id} aria-labelledby={`int-${card.id}`}>
              <div className="head"><span className="logo">{card.logo}</span><h2 id={`int-${card.id}`}>{card.name}</h2></div>
              <ul>{card.what.map(w => <li key={w}>{w}</li>)}</ul>
              <p className="small muted">{card.note}</p>
              {mine.map(c => (
                <div className="row" key={c.id}>
                  <div className="grow"><div className="title">{c.account_email ?? 'Connected account'}</div>
                    <div className="small muted">{c.last_error ? `Error: ${c.last_error}` : c.last_synced_at ? `Synced ${new Date(c.last_synced_at).toLocaleString()}` : 'Waiting for first sync'}</div></div>
                  <span className={`pill ${c.status === 'connected' ? 'ok' : ''}`}>{c.status}</span>
                </div>
              ))}
              <div className="foot">
                <span className="pill">{card.id === 'ai' ? 'Included' : mine.length ? `${mine.length} connected` : 'Not connected'}</span>
                <button className="btn sm" disabled title="Available in the next release">{card.id === 'ai' ? 'Set up' : 'Connect'}</button>
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
