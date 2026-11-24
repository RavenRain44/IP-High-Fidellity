import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { Icon } from '../components/Icon';
import { useQuery } from '../lib/data';
import { call } from '../lib/accounts';

const PROVIDER_NAMES: Record<string, string> = { email: 'Email and password', google: 'Google', azure: 'Microsoft' };

export function Account() {
  const { user, profile, refreshProfile, signOut } = useAuth();
  const sb = requireSupabase();
  const [name, setName] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const value = name ?? profile?.full_name ?? '';
  const providers = [...new Set((user?.identities ?? []).map(i => i.provider))];

  async function save(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    if (!value.trim()) { setMsg({ kind: 'error', text: 'Name can’t be empty.' }); return; }
    setBusy(true);
    const { error } = await sb.from('profiles').update({ full_name: value.trim() }).eq('id', user!.id);
    setBusy(false);
    if (error) setMsg({ kind: 'error', text: friendlyError(error) });
    else { setName(null); await refreshProfile(); setMsg({ kind: 'ok', text: 'Saved.' }); }
  }

  return (
    <>
      <div className="page-head"><div><h1>Account</h1><p>Your profile and how you sign in.</p></div></div>
      <div className="grid2">
        <section className="card">
          <div className="card-head"><h2><Icon name="settings" /> Profile</h2></div>
          {msg && <div className={`alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
          <form onSubmit={save}>
            <label className="field"><span>Full name</span><input autoComplete="name" value={value} onChange={e => setName(e.target.value)} /></label>
            <label className="field"><span>Email</span><input value={user?.email ?? ''} disabled /></label>
            <button className="btn primary" disabled={busy}>{busy ? 'Saving…' : 'Save'}</button>
          </form>
        </section>
        <section className="card">
          <div className="card-head"><h2><Icon name="shield" /> Sign-in methods</h2></div>
          {providers.map(p => <div className="row" key={p}><div className="grow title">{PROVIDER_NAMES[p] ?? p}</div><span className="pill ok">Active</span></div>)}
          <p className="small muted" style={{ margin: '10px 0 14px' }}>Signing in with Google or Microsoft doesn’t give LuMaCo access to your email. That only happens when you connect it under Integrations.</p>
          <button className="btn" onClick={() => void signOut()}><Icon name="out" size="sm" /> Sign out</button>
        </section>
      </div>
      <YourData />
    </>
  );
}

type TeamPlan = { team_id: string; team_name: string; my_role: string; other_members: number; successor_name: string | null; shared_records: number };

function YourData() {
  const sb = requireSupabase();
  const { user } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState<'' | 'export' | 'delete'>('');
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');
  const plan = useQuery<TeamPlan[]>(() => sb.rpc('account_deletion_preview'), [confirming]);

  async function download() {
    setBusy('export'); setError('');
    const { data, error } = await sb.rpc('export_my_data');
    setBusy('');
    if (error) { setError(friendlyError(error)); return; }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `lumaco-export-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  async function remove() {
    setBusy('delete'); setError('');
    const r = await call<{ deleted: boolean }>('account-delete', { confirm: 'DELETE' });
    if (!r.data?.deleted) { setBusy(''); setError(r.error ?? 'Your account couldn’t be deleted. Please try again.'); return; }
    await sb.auth.signOut({ scope: 'local' }).catch(() => {});
    nav('/signin?deleted=1', { replace: true });
  }

  return (
    <div className="grid2" style={{ marginTop: 12 }}>
      <section className="card" aria-labelledby="your-data">
        <div className="card-head"><h2 id="your-data"><Icon name="file" /> Your data</h2></div>
        <p className="small muted" style={{ marginBottom: 12 }}>Download everything you’ve added or that LuMaCo synced for you (contacts, notes, meetings, promises, email and calendar entries) as a JSON file. Access tokens are never included.</p>
        <button className="btn" onClick={() => void download()} disabled={!!busy}>{busy === 'export' ? 'Preparing…' : 'Download my data'}</button>
        <p className="small muted" style={{ marginTop: 12 }}>How we handle your data: <Link to="/privacy">Privacy Policy</Link> · <Link to="/terms">Terms</Link></p>
      </section>

      <section className="card danger-zone" aria-labelledby="delete-account">
        <div className="card-head"><h2 id="delete-account"><Icon name="alert" /> Delete account</h2></div>
        {error && <div className="alert error" role="alert">{error}</div>}
        {!confirming ? (
          <>
            <p className="small muted" style={{ marginBottom: 12 }}>Permanently deletes your account, recordings, private records and synced email and calendar data, and disconnects Google and Microsoft. This can’t be undone.</p>
            <button className="btn danger" onClick={() => setConfirming(true)}>Delete my account…</button>
          </>
        ) : (
          <>
            <p className="small" style={{ marginBottom: 8 }}>This permanently deletes <b>{user?.email}</b> and can’t be undone. Download your data first if you want a copy.</p>
            <ul className="small" style={{ margin: '0 0 10px', paddingLeft: 20 }}>
              <li>Private records, meetings, recordings and synced email and calendar data are deleted.</li>
              {plan.loading && <li className="muted">Checking your teams…</li>}
              {(plan.data ?? []).map(t => (
                <li key={t.team_id}>
                  <b>{t.team_name}</b>: {t.other_members === 0
                    ? 'nobody else is in this team, so it is deleted with everything in it.'
                    : <>{t.my_role === 'owner' ? <>{t.successor_name ?? 'the next member'} becomes owner. </> : null}
                      {t.shared_records ? `${t.shared_records} shared record${t.shared_records === 1 ? '' : 's'} (contacts, projects, promises, notes) pass to ${t.my_role === 'owner' ? (t.successor_name ?? 'the new owner') : (t.successor_name ?? 'the team owner')}.` : 'You have no shared records here.'}</>}
                </li>
              ))}
            </ul>
            <label className="field"><span>Type DELETE to confirm</span>
              <input value={typed} onChange={e => setTyped(e.target.value)} autoComplete="off" aria-describedby="delete-account" /></label>
            <button className="btn danger" disabled={typed !== 'DELETE' || !!busy} onClick={() => void remove()}>{busy === 'delete' ? 'Deleting…' : 'Permanently delete account'}</button>{' '}
            <button className="btn" disabled={!!busy} onClick={() => { setConfirming(false); setTyped(''); }}>Cancel</button>
          </>
        )}
      </section>
    </div>
  );
}
