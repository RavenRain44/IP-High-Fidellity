import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { authRedirect, useAuth } from '../lib/auth';
import { friendlyError, isConfigured, requireSupabase, supabase } from '../lib/supabase';
import { BrandMark, GoogleLogo, Icon, MicrosoftLogo } from '../components/Icon';
import { Loading } from '../components/AppShell';

function AuthLayout({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="auth">
      <section className="auth-hero">
        <div>
          <BrandMark light />
          <h1>Relationships that keep themselves up to date.</h1>
          <p>LuMaCo reads the email, calendar, calls and meetings you connect, and keeps follow-ups, promises and customer context current, with no manual CRM updates.</p>
          <div className="auth-points">
            <div><Icon name="mail" /> Gmail and Outlook, sorted by relationship and what needs a reply</div>
            <div><Icon name="mic" /> Record meetings; transcripts and notes are written for you to review</div>
            <div><Icon name="clipboard" /> Open Promises tracked from what you and your customers commit to</div>
            <div><Icon name="shield" /> Private notes stay private, even inside a team</div>
          </div>
        </div>
        <span className="small auth-legal" style={{ color: '#9fb0c6' }}>© {new Date().getFullYear()} LuMaCo · <Link to="/privacy">Privacy</Link> · <Link to="/terms">Terms</Link></span>
      </section>
      <section className="auth-panel">
        <div style={{ width: '100%', maxWidth: 380, margin: '0 auto' }}>
          <h2>{title}</h2>
          <p className="sub">{sub}</p>
          {!isConfigured && (
            <div className="alert info" role="status">
              <strong>Normal mode isn’t connected to a server yet.</strong> Accounts will work once a Supabase project is set up (see <code>docs/REAL_MODE_SETUP.md</code>). The demo works now.
            </div>
          )}
          {children}
          <div className="demo-cta">
            <div><strong>Just looking around?</strong><span className="small muted">Explore LuMaCo with sample data. No account needed.</span></div>
            <a className="btn" href="/demo/"><Icon name="play" size="sm" /> Try the demo</a>
          </div>
        </div>
      </section>
    </div>
  );
}

function OAuthButtons({ verb }: { verb: string }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  async function go(provider: 'google' | 'azure') {
    setError(''); setBusy(provider);
    try {
      const { error } = await requireSupabase().auth.signInWithOAuth({
        provider,
        // Microsoft only returns the email address when the "email" scope is requested.
        options: { redirectTo: authRedirect(), scopes: provider === 'azure' ? 'email openid profile' : undefined },
      });
      if (error) throw error;
    } catch (e) { setError(friendlyError(e)); setBusy(null); }
  }
  return (
    <>
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="oauth">
        <button className="btn" disabled={!isConfigured || !!busy} onClick={() => go('google')}><GoogleLogo /> {busy === 'google' ? 'Redirecting…' : `${verb} with Google`}</button>
        <button className="btn" disabled={!isConfigured || !!busy} onClick={() => go('azure')}><MicrosoftLogo /> {busy === 'azure' ? 'Redirecting…' : `${verb} with Microsoft`}</button>
      </div>
      <div className="divider">or use your email</div>
    </>
  );
}

function useRedirectIfSignedIn() {
  const { loading, session } = useAuth();
  const loc = useLocation();
  const from = (loc.state as { from?: string } | null)?.from;
  return { loading, to: session ? (from && from.startsWith('/app') ? from : '/app') : null };
}

export function SignIn() {
  const { loading, to } = useRedirectIfSignedIn();
  const deleted = useLocation().search.includes('deleted=1');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (loading) return <Loading />;
  if (to) return <Navigate to={to} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true);
    const { error } = await requireSupabase().auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (error) setError(friendlyError(error));
  }
  return (
    <AuthLayout title="Sign in" sub="Welcome back to LuMaCo.">
      {deleted && <div className="alert ok" role="status">Your account and data have been deleted.</div>}
      <OAuthButtons verb="Continue" />
      {error && <div className="alert error" role="alert">{error}</div>}
      <form onSubmit={submit} noValidate>
        <label className="field"><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        <button className="btn primary block" disabled={!isConfigured || busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
      <div className="auth-foot">
        <Link to="/forgot">Forgot your password?</Link>
        <span>New to LuMaCo? <Link to="/signup">Create an account</Link></span>
      </div>
    </AuthLayout>
  );
}

export function SignUp() {
  const { loading, to } = useRedirectIfSignedIn();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [sentTo, setSentTo] = useState('');
  const [busy, setBusy] = useState(false);
  if (loading) return <Loading />;
  if (to) return <Navigate to={to} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (password.length < 8) { setError('Use a password with at least 8 characters.'); return; }
    setBusy(true);
    const { data, error } = await requireSupabase().auth.signUp({
      email: email.trim(), password,
      options: { data: { full_name: name.trim() }, emailRedirectTo: authRedirect() },
    });
    setBusy(false);
    if (error) { setError(friendlyError(error)); return; }
    if (!data.session) setSentTo(email.trim()); // email confirmation is on: wait for the link
  }
  if (sentTo) return (
    <AuthLayout title="Check your email" sub={`We sent a confirmation link to ${sentTo}.`}>
      <div className="alert ok" role="status">Open the link to finish creating your account. You can close this tab.</div>
      <div className="auth-foot"><Link to="/signin">Back to sign in</Link></div>
    </AuthLayout>
  );
  return (
    <AuthLayout title="Create your account" sub="Start with a personal workspace. You can create or join a team later.">
      <OAuthButtons verb="Sign up" />
      {error && <div className="alert error" role="alert">{error}</div>}
      <form onSubmit={submit} noValidate>
        <label className="field"><span>Full name</span><input autoComplete="name" required value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field"><span>Work email</span><input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label className="field"><span>Password</span><input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} /><span className="hint">At least 8 characters.</span></label>
        <button className="btn primary block" disabled={!isConfigured || busy}>{busy ? 'Creating account…' : 'Create account'}</button>
      </form>
      <div className="auth-foot">
        <span>Already have an account? <Link to="/signin">Sign in</Link></span>
        <span className="small">By creating an account you agree to the <Link to="/terms">Terms</Link> and <Link to="/privacy">Privacy Policy</Link>.</span>
      </div>
    </AuthLayout>
  );
}

export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault(); setError(''); setBusy(true);
    const { error } = await requireSupabase().auth.resetPasswordForEmail(email.trim(), { redirectTo: authRedirect('/reset') });
    setBusy(false);
    if (error) setError(friendlyError(error)); else setSent(true);
  }
  return (
    <AuthLayout title="Reset your password" sub="We’ll email you a link to choose a new one.">
      {sent ? <div className="alert ok" role="status">If an account exists for {email}, a reset link is on its way.</div> : (
        <form onSubmit={submit} noValidate>
          {error && <div className="alert error" role="alert">{error}</div>}
          <label className="field"><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={e => setEmail(e.target.value)} /></label>
          <button className="btn primary block" disabled={!isConfigured || busy}>{busy ? 'Sending…' : 'Send reset link'}</button>
        </form>
      )}
      <div className="auth-foot"><Link to="/signin">Back to sign in</Link></div>
    </AuthLayout>
  );
}

/** Landing page for the password-reset email link (Supabase signs the user in first). */
export function ResetPassword() {
  const { loading, session } = useAuth();
  const nav = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  if (loading) return <Loading />;
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (password.length < 8) { setError('Use a password with at least 8 characters.'); return; }
    setBusy(true);
    const { error } = await requireSupabase().auth.updateUser({ password });
    setBusy(false);
    if (error) setError(friendlyError(error)); else nav('/app', { replace: true });
  }
  return (
    <AuthLayout title="Choose a new password" sub="You’ll stay signed in after saving.">
      {!session ? <div className="alert error">This reset link has expired. <Link to="/forgot">Request a new one</Link>.</div> : (
        <form onSubmit={submit} noValidate>
          {error && <div className="alert error" role="alert">{error}</div>}
          <label className="field"><span>New password</span><input type="password" autoComplete="new-password" minLength={8} required value={password} onChange={e => setPassword(e.target.value)} /></label>
          <button className="btn primary block" disabled={busy}>{busy ? 'Saving…' : 'Save password'}</button>
        </form>
      )}
    </AuthLayout>
  );
}

/** OAuth and email-confirmation links land here; supabase-js exchanges the code automatically. */
export function AuthCallback() {
  const { loading, session } = useAuth();
  const [error, setError] = useState('');
  useEffect(() => {
    const p = new URLSearchParams(window.location.search + window.location.hash.replace(/^#/, '&'));
    const msg = p.get('error_description') || p.get('error');
    if (msg) { setError(msg); return; }
    // An already-used or expired link never produces a session; don't spin forever.
    const t = setTimeout(() => setError('This sign-in link is invalid or has expired.'), 10000);
    return () => clearTimeout(t);
  }, []);
  if (error) return (
    <AuthLayout title="Sign-in didn’t finish" sub="The provider returned an error.">
      <div className="alert error" role="alert">{error}</div>
      <div className="auth-foot"><Link to="/signin">Try again</Link></div>
    </AuthLayout>
  );
  if (loading || (!session && supabase)) return <Loading label="Signing you in…" />;
  return <Navigate to={session ? '/app' : '/signin'} replace />;
}
