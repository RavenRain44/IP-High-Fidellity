import { useState, type FormEvent } from 'react';
import { useAuth } from '../lib/auth';
import { friendlyError, requireSupabase } from '../lib/supabase';
import { useQuery, type Invite, type Membership, type TeamRole } from '../lib/data';
import { Icon } from '../components/Icon';
import { initials } from '../components/AppShell';
import { CoverageLine, useCoverage } from '../components/Coverage';
import { Link } from 'react-router-dom';

type Member = { user_id: string; role: TeamRole; joined_at: string };
type Profile = { id: string; full_name: string | null; email: string | null };
type SentInvite = { id: string; email: string; role: TeamRole; created_at: string };

export function Teams() {
  const sb = requireSupabase();
  const { user } = useAuth();
  const mine = useQuery<Membership[]>(() => sb.from('team_members').select('team_id,role,teams(id,name)').eq('user_id', user!.id).overrideTypes<Membership[], { merge: false }>(), [user?.id]);
  const invites = useQuery<Invite[]>(() => sb.rpc('my_invites'), []);
  const [teamName, setTeamName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!teamName.trim()) return;
    setBusy(true);
    const { error } = await sb.rpc('create_team', { team_name: teamName.trim() });
    setBusy(false);
    if (error) setError(friendlyError(error)); else { setTeamName(''); void mine.reload(); }
  }
  async function accept(id: string) {
    const { error } = await sb.rpc('accept_invite', { invite_id: id });
    if (error) setError(friendlyError(error)); else { void invites.reload(); void mine.reload(); }
  }

  return (
    <>
      <div className="page-head">
        <div><h1>Teams</h1><p>Your account is standalone by default. Teams let a company share work records; anything marked private stays yours alone.</p></div>
      </div>
      {(error || mine.error) && <div className="alert error" role="alert">{error || mine.error}</div>}

      {!!invites.data?.length && (
        <section className="card" style={{ marginBottom: 12, borderColor: 'var(--sel-line)' }}>
          <div className="card-head"><h2><Icon name="mail" /> Invitations</h2></div>
          {invites.data.map(i => (
            <div className="row" key={i.id}>
              <div className="grow"><div className="title">{i.team_name}</div><div className="small muted">Join as {i.role}{i.invited_by_name ? ` · invited by ${i.invited_by_name}` : ''}</div></div>
              <button className="btn sm primary" onClick={() => accept(i.id)}>Join team</button>
            </div>
          ))}
        </section>
      )}

      {mine.loading ? <p className="muted">Loading…</p> : (mine.data ?? []).map(m => m.teams && (
        <TeamCard key={m.team_id} teamId={m.team_id} name={m.teams.name} myRole={m.role} onChange={() => void mine.reload()} />
      ))}

      <section className="card" style={{ marginTop: 12 }}>
        <div className="card-head"><h2><Icon name="plus" /> Create a team</h2></div>
        <form className="inline-form" onSubmit={create}>
          <label className="field"><span>Team or company name</span><input value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="e.g. Acme Mechanical" /></label>
          <button className="btn primary" disabled={busy || !teamName.trim()}>{busy ? 'Creating…' : 'Create team'}</button>
        </form>
        <p className="small muted" style={{ marginTop: 8 }}>You’ll be the owner. Invite people by email; they join with their own LuMaCo account.</p>
      </section>
    </>
  );
}

function TeamCard({ teamId, name, myRole, onChange }: { teamId: string; name: string; myRole: TeamRole; onChange: () => void }) {
  const sb = requireSupabase();
  const { user } = useAuth();
  const isAdmin = myRole === 'owner' || myRole === 'manager';
  const members = useQuery<Member[]>(() => sb.from('team_members').select('user_id,role,joined_at').eq('team_id', teamId).order('joined_at'), [teamId]);
  const ids = (members.data ?? []).map(m => m.user_id);
  const profiles = useQuery<Profile[]>(() => ids.length ? sb.from('profiles').select('id,full_name,email').in('id', ids) : Promise.resolve({ data: [], error: null }), [ids.join(',')]);
  const sent = useQuery<SentInvite[]>(() => isAdmin
    ? sb.from('team_invites').select('id,email,role,created_at').eq('team_id', teamId).is('accepted_at', null).is('revoked_at', null).order('created_at', { ascending: false })
    : Promise.resolve({ data: [], error: null }), [teamId, isAdmin]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);

  const who = (id: string) => (profiles.data ?? []).find(p => p.id === id);
  const coverage = useCoverage(teamId);

  async function invite(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    const addr = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(addr)) { setMsg({ kind: 'error', text: 'Enter a valid email address.' }); return; }
    const { error } = await sb.from('team_invites').insert({ team_id: teamId, email: addr, role, invited_by: user!.id });
    if (error) setMsg({ kind: 'error', text: /duplicate|unique/i.test(error.message) ? 'That person already has a pending invite.' : friendlyError(error) });
    else { setEmail(''); setMsg({ kind: 'ok', text: `Invited ${addr}. They’ll see the invite when they sign in to LuMaCo with that email.` }); void sent.reload(); }
  }
  async function revoke(id: string) {
    const { error } = await sb.from('team_invites').update({ revoked_at: new Date().toISOString() }).eq('id', id);
    if (error) setMsg({ kind: 'error', text: friendlyError(error) }); else void sent.reload();
  }
  async function remove(userId: string, leaving: boolean) {
    if (!confirm(leaving ? `Leave ${name}? You’ll lose access to its shared records. Your personal records are not affected.` : 'Remove this person from the team?')) return;
    const { error } = await sb.from('team_members').delete().eq('team_id', teamId).eq('user_id', userId);
    if (error) setMsg({ kind: 'error', text: friendlyError(error) }); else leaving ? onChange() : void members.reload();
  }
  const canRemove = (m: Member) => m.user_id !== user!.id && m.role !== 'owner' && (myRole === 'owner' || (myRole === 'manager' && m.role === 'member'));

  return (
    <section className="card" aria-labelledby={`team-${teamId}`}>
      <div className="card-head">
        <h2 id={`team-${teamId}`}><Icon name="users" /> {name}</h2>
        <div className="btn-row nowrap">
          {isAdmin && <Link className="btn sm" to="/app/team">Team Dashboard</Link>}
          <span className="pill blue">You: {myRole}</span>
        </div>
      </div>
      {msg && <div className={`alert ${msg.kind}`} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
      <table className="table">
        <thead><tr><th>Member</th><th>Role</th><th><span className="sr-only">Actions</span></th></tr></thead>
        <tbody>
          {(members.data ?? []).map(m => {
            const p = who(m.user_id);
            return (
              <tr key={m.user_id}>
                <td><div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="avatar" style={{ cursor: 'default' }}>{initials(p?.full_name, p?.email)}</span>
                  <div><div style={{ fontWeight: 600 }}>{p?.full_name || p?.email || 'Member'}{m.user_id === user!.id ? ' (you)' : ''}</div><div className="small muted">{p?.email}</div>
                    {(isAdmin || m.user_id === user!.id) && <CoverageLine rows={coverage.forUser(m.user_id)} loading={coverage.loading} />}</div>
                </div></td>
                <td style={{ textTransform: 'capitalize' }}>{m.role}</td>
                <td style={{ textAlign: 'right' }}>
                  {canRemove(m) && <button className="btn sm danger" onClick={() => remove(m.user_id, false)}>Remove</button>}
                  {m.user_id === user!.id && m.role !== 'owner' && <button className="btn sm" onClick={() => remove(m.user_id, true)}>Leave team</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <p className="small muted" style={{ marginTop: 8 }}>{isAdmin
        ? 'Sources shows what each person has connected (never their addresses or messages). Missing sources aren’t evidence of inactivity.'
        : 'Owners and managers see which sources you’ve connected (not your addresses or messages), shown here under your name.'}</p>
      {isAdmin && (
        <>
          <form className="inline-form" style={{ marginTop: 14 }} onSubmit={invite}>
            <label className="field"><span>Invite by email</span><input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@company.com" /></label>
            <label className="field" style={{ flex: '0 0 140px', minWidth: 120 }}><span>Role</span>
              <select value={role} onChange={e => setRole(e.target.value as TeamRole)}>
                <option value="member">Member</option>
                {myRole === 'owner' && <option value="manager">Manager</option>}
              </select>
            </label>
            <button className="btn primary" disabled={!email.trim()}>Send invite</button>
          </form>
          {!!sent.data?.length && (
            <div style={{ marginTop: 12 }}>
              <div className="small muted" style={{ fontWeight: 600, marginBottom: 4 }}>Pending invites</div>
              {sent.data.map(i => (
                <div className="row" key={i.id}>
                  <div className="grow"><div className="title">{i.email}</div><div className="small muted">{i.role} · sent {new Date(i.created_at).toLocaleDateString()}</div></div>
                  <button className="btn sm" onClick={() => revoke(i.id)}>Revoke</button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
