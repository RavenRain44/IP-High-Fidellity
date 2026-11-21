import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { Icon } from '../components/Icon';

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
    </>
  );
}
