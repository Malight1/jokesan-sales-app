import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { platform } from '../lib/api';
import { supabase } from '../lib/supabase';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import BrandMark from '../components/BrandMark';
import './Login.scss';

type Mode = 'login' | 'signup' | 'forgot';

// Supabase's own wording means nothing to a shop owner or a new cashier.
function friendlyAuthError(msg: string, mode: Mode): string {
  if (/invalid login credentials/i.test(msg)) {
    return "That email and password don't match an account. Check for a typo, or tap \"Forgot password?\". "
      + "If you were invited to join a business, open the invite link you were sent to set your password first.";
  }
  if (/already registered|already been registered/i.test(msg)) {
    return mode === 'signup'
      ? 'This email already has an account. Sign in instead, or tap "Forgot password?".'
      : msg;
  }
  // The sign-up trigger refuses an invited email (0065); Supabase reports it as a database error.
  if (/team invite|database error saving new user/i.test(msg)) {
    return 'This email has been invited to join a team. Open the invite link you were sent to set your password and join. If the link has expired, ask whoever invited you to send a new one.';
  }
  if (/password should be at least|weak password|password is too short/i.test(msg)) return 'Use a password with at least 8 characters.';
  if (/rate limit|too many/i.test(msg)) return 'Too many attempts. Wait a few minutes and try again.';
  if (/failed to fetch|network/i.test(msg)) return "We couldn't reach ProfixBook. Check your internet and try again.";
  if (/error sending/i.test(msg)) return "We couldn't send the email just now. Try again in a few minutes, or contact support.";
  return msg;
}

export default function Login() {
  const { signIn, signUp, session } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Once authenticated, leave the login screen — platform admins land on
  // the admin overview, everyone else on their own tenant dashboard.
  useEffect(() => {
    if (!session) return;
    let alive = true;
    platform.isAdmin()
      .then(isAdmin => { if (alive) navigate(isAdmin ? '/platform' : '/dashboard', { replace: true }); })
      .catch(() => { if (alive) navigate('/dashboard', { replace: true }); });
    return () => { alive = false; };
  }, [session, navigate]);
  // A marketing-page "Start free trial" button links here with ?signup=1 so
  // it lands straight in sign-up mode instead of sign-in.
  const [mode, setMode] = useState<Mode>(searchParams.get('signup') ? 'signup' : 'login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [tenantType, setTenantType] = useState<'single' | 'multi_branch'>('single');
  // Only the platform admin can change this after signup (0045) — get it
  // right here. Drives a genuinely different dashboard and nav, not a label
  // swap: see src/retail.
  // The landing page's "I run a shop" / "I make products" choice arrives as
  // ?type=retail|manufacturing, so the visitor doesn't have to say it twice.
  const [businessType, setBusinessType] = useState<'manufacturing' | 'retail'>(
    searchParams.get('type') === 'retail' ? 'retail' : 'manufacturing');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);

    if (mode === 'forgot') {
      // Supabase answers the same whether or not the address has an
      // account, so this never reveals who is signed up.
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
      if (error) setError(friendlyAuthError(error.message, mode));
      else setNotice(`If ${email.trim()} has an account, a link to set a new password is on its way. Check spam too.`);
    } else if (mode === 'login') {
      const { error } = await signIn(email.trim(), password);
      if (error) setError(/confirm/i.test(error) ? error : friendlyAuthError(error, mode));
    } else {
      if (password.length < 8) { setError('Use a password with at least 8 characters.'); setLoading(false); return; }
      const { error } = await signUp({ email: email.trim(), password, fullName, companyName, tenantType, businessType });
      if (error) setError(friendlyAuthError(error, mode));
      else setNotice('Account created. Check your email for a confirmation link (look in spam too), then sign in.');
    }
    setLoading(false);
  };

  const switchMode = (next: Mode) => { setMode(next); setError(null); setNotice(null); };
  // The most common reason a new owner can't get in: they never clicked
  // the confirmation link (or it expired). Let them get a fresh one.
  const unconfirmed = mode === 'login' && !!error && /confirm/i.test(error);
  const resendConfirmation = async () => {
    setLoading(true);
    const { error: err } = await supabase.auth.resend({ type: 'signup', email: email.trim() });
    setLoading(false);
    if (err) setError(err.message);
    else { setError(null); setNotice(`A new confirmation link is on its way to ${email.trim()}.`); }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark size={52} className="auth-mark" />
          <h1>ProfixBook</h1>
          <p>Manufacturing, retail &amp; sales, under control.</p>
        </div>

        {mode === 'forgot' ? (
          <div className="auth-intro">
            <h2>Reset your password</h2>
            <p>Enter the email you sign in with and we'll send you a link to set a new one.</p>
          </div>
        ) : (
          <div className="auth-tabs">
            <button className={mode === 'login' ? 'active' : ''} onClick={() => switchMode('login')}>Sign In</button>
            <button className={mode === 'signup' ? 'active' : ''} onClick={() => switchMode('signup')}>Create Account</button>
          </div>
        )}

        {error && (
          <div className="auth-alert error">
            {error}
            {unconfirmed && (
              <button type="button" className="link-btn auth-alert-action" onClick={resendConfirmation} disabled={loading || !email.trim()}>
                Send a new confirmation link
              </button>
            )}
          </div>
        )}
        {notice && <div className="auth-alert success">{notice}</div>}

        <form onSubmit={handleSubmit}>
          {mode === 'signup' && (
            <>
              <p className="auth-hint">
                This creates a new business. Joining someone else's business? Open the invite link they sent you instead.
              </p>
              <div className="form-group">
                <label>Your Full Name</label>
                <input value={fullName} onChange={e => setFullName(e.target.value)} required placeholder="e.g. Ada Okafor" />
              </div>
              <div className="form-group">
                <label>Company Name</label>
                <input value={companyName} onChange={e => setCompanyName(e.target.value)} required placeholder="e.g. Ada's Stores" />
              </div>
              <div className="form-group">
                <label>What kind of business is this?</label>
                <select value={businessType} onChange={e => setBusinessType(e.target.value as any)}>
                  <option value="manufacturing">I manufacture or produce goods</option>
                  <option value="retail">I buy and resell stock (shop, store, supermarket)</option>
                </select>
              </div>
              <div className="form-group">
                <label>Number of locations</label>
                <select value={tenantType} onChange={e => setTenantType(e.target.value as any)}>
                  <option value="single">Single location</option>
                  <option value="multi_branch">Multiple branches</option>
                </select>
              </div>
            </>
          )}

          <div className="form-group">
            <label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@company.com" autoComplete="email" />
          </div>
          {mode !== 'forgot' && (
            <div className="form-group">
              <div className="auth-label-row">
                <label htmlFor="auth-password">Password</label>
                {mode === 'login' && (
                  <button type="button" className="link-btn" onClick={() => switchMode('forgot')}>Forgot password?</button>
                )}
              </div>
              <div className="auth-password">
                <input id="auth-password" type={showPassword ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                  required minLength={mode === 'signup' ? 8 : undefined} placeholder="••••••••" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} />
                <button type="button" className="auth-password-toggle" onClick={() => setShowPassword(v => !v)}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}>
                  {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>
          )}

          <button type="submit" className="btn-primary auth-submit" disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Please wait…</>
              : mode === 'login' ? 'Sign In' : mode === 'signup' ? 'Create Account' : 'Send Reset Link'}
          </button>
        </form>

        <p className="auth-foot">
          {mode === 'forgot' ? 'Remembered it? ' : mode === 'login' ? 'New here? ' : 'Already have an account? '}
          <button className="link-btn" onClick={() => switchMode(mode === 'login' ? 'signup' : 'login')}>
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
