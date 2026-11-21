import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { BrandMark, Icon, type IconName } from './Icon';

const NAV: { to: string; label: string; icon: IconName }[] = [
  { to: '/app', label: 'Dashboard', icon: 'dashboard' },
  { to: '/app/integrations', label: 'Integrations', icon: 'link' },
  { to: '/app/teams', label: 'Teams', icon: 'users' },
  { to: '/app/account', label: 'Account', icon: 'settings' },
];

export function initials(name: string | null | undefined, email?: string | null): string {
  const src = (name || email || '?').trim();
  const parts = src.split(/[\s@.]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return <div className="center" role="status"><div><div className="spinner" style={{ margin: '0 auto 10px' }} /><span className="muted">{label}</span></div></div>;
}

/** Signed-in area. Unauthenticated visitors go to sign-in; new users finish onboarding first. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { loading, session, profile } = useAuth();
  const loc = useLocation();
  if (loading) return <Loading />;
  if (!session) return <Navigate to="/signin" replace state={{ from: loc.pathname }} />;
  if (profile && !profile.onboarded_at && loc.pathname !== '/onboarding') return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

export function AppShell() {
  const { profile, user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);

  return (
    <div className="shell">
      <header className="topbar">
        <button className="menu-btn" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen(o => !o)}><Icon name="menu" /></button>
        <Link to="/app" aria-label="LuMaCo home" style={{ color: '#fff' }}><BrandMark light /></Link>
        <span className="spacer" />
        <a className="btn sm" href="/demo/" style={{ background: 'transparent', color: '#fff', borderColor: '#4a6283' }}>Demo mode</a>
        <button className="avatar" title={`Signed in as ${user?.email ?? ''}. Sign out`} aria-label="Sign out" onClick={() => void signOut()}>
          {initials(profile?.full_name, user?.email)}
        </button>
      </header>
      <aside className={`side ${open ? 'open' : ''}`} aria-label="Main navigation">
        <nav className="nav">
          {NAV.map(n => (
            <NavLink key={n.to} to={n.to} end={n.to === '/app'}><Icon name={n.icon} /> {n.label}</NavLink>
          ))}
        </nav>
        <div className="side-foot">
          <div style={{ fontWeight: 600, color: 'var(--text)' }}>{profile?.full_name || user?.email}</div>
          <div>{user?.email}</div>
          <button className="btn sm" style={{ marginTop: 10 }} onClick={() => void signOut()}><Icon name="out" size="sm" /> Sign out</button>
        </div>
      </aside>
      <main className="main" id="main"><Outlet /></main>
      <nav className="mobile-nav" aria-label="Main navigation">
        {NAV.map(n => (
          <NavLink key={n.to} to={n.to} end={n.to === '/app'}><Icon name={n.icon} /><span>{n.label}</span></NavLink>
        ))}
      </nav>
    </div>
  );
}
