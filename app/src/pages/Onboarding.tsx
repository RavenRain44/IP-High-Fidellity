import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { useQuery, type Invite } from '../lib/data';
import { BrandMark, Icon } from '../components/Icon';
import { Loading } from '../components/AppShell';

/** First run: confirm your name, then stay standalone, create a team, or accept an invite. */
export function Onboarding() {
  const { profile, user, refreshProfile, loading } = useAuth();
  const nav = useNavigate();
  const sb = requireSupabase();
  const invites = useQuery<Invite[]>(() => sb.rpc('my_invites'), []);
  const [name, setName] = useState<string | null>(null);
  const [mode, setMode] = useState<'solo' | 'team'>('solo');
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading || !profile) return <Loading />;
  if (profile.onboarded_at) return <Navigate to="/app" replace />;
  const displayName = name ?? profile.full_name ?? '';

  async function finish(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!displayName.trim()) { setError('Please enter your name.'); return; }
    if (mode === 'team' && !teamName.trim()) { setError('Please name your team, or choose “Just me”.'); return; }
    setBusy(true);
    try {
      if (mode === 'team') {
        const { error } = await sb.rpc('create_team', { team_name: teamName.trim() });
        if (error) throw error;
      }
      const { error } = await sb.from('profiles').update({ full_name: displayName.trim(), onboarded_at: new Date().toISOString() }).eq('id', profile!.id);
      if (error) throw error;
      await refreshProfile();
      nav('/app', { replace: true });
    } catch (err) { setError(friendlyError(err)); setBusy(false); }
  }

  async function accept(id: string) {
    setError('');
    const { error } = await sb.rpc('accept_invite', { invite_id: id });
    if (error) setError(friendlyError(error)); else void invites.reload();
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', padding: 20 }}>
      <form className="card" style={{ width: 'min(520px, 100%)', padding: 28 }} onSubmit={finish}>
        <BrandMark />
        <h1 style={{ marginTop: 18 }}>Welcome to LuMaCo</h1>
        <p className="muted" style={{ margin: '4px 0 20px' }}>Signed in as {user?.email}. Two quick questions and you’re in.</p>
        {error && <div className="alert error" role="alert">{error}</div>}
        <label className="field"><span>Your name</span><input autoComplete="name" value={displayName} onChange={e => setName(e.target.value)} required /></label>

        {!!invites.data?.length && (
          <div className="card" style={{ boxShadow: 'none', background: 'var(--sel)', borderColor: 'var(--sel-line)', marginBottom: 14 }}>
            <strong>You’ve been invited</strong>
            {invites.data.map(i => (
              <div className="row" key={i.id}>
                <div className="grow"><div className="title">{i.team_name}</div><div className="small muted">As {i.role}{i.invited_by_name ? ` · from ${i.invited_by_name}` : ''}</div></div>
                <button type="button" className="btn sm primary" onClick={() => accept(i.id)}>Join</button>
              </div>
            ))}
          </div>
        )}

        <fieldset style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
          <legend className="small" style={{ fontWeight: 600, marginBottom: 8 }}>How will you use LuMaCo?</legend>
          <label className="row" style={{ cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 6, padding: 12, marginBottom: 8 }}>
            <input type="radio" name="mode" checked={mode === 'solo'} onChange={() => setMode('solo')} />
            <div className="grow"><div className="title">Just me</div><div className="small muted">A personal workspace. You can join or create a team any time.</div></div>
            <Icon name="shield" />
          </label>
          <label className="row" style={{ cursor: 'pointer', border: '1px solid var(--line)', borderRadius: 6, padding: 12 }}>
            <input type="radio" name="mode" checked={mode === 'team'} onChange={() => setMode('team')} />
            <div className="grow"><div className="title">Create a team for my company</div><div className="small muted">Invite salespeople and managers. Personal notes still stay private.</div></div>
            <Icon name="users" />
          </label>
        </fieldset>
        {mode === 'team' && <label className="field"><span>Team or company name</span><input value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="e.g. Acme Mechanical" /></label>}
        <button className="btn primary block" disabled={busy}>{busy ? 'Setting up…' : 'Continue'}</button>
      </form>
    </div>
  );
}
