import React, { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Loader2, Eye, EyeOff } from 'lucide-react';
import BrandMark from '../components/BrandMark';
import { team, InviteDetails } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import './Login.scss';

const ROLE_LABEL: Record<string, string> = {
  admin: 'an admin',
  sales: 'sales staff',
  inventory: 'inventory staff',
  accounts: 'accounts staff',
  cashier: 'a cashier (till only)',
};

// Where a teammate lands from the invite link an admin shared on WhatsApp
// (migration 0053). No email is involved: they pick a password here and
// the accept-invite function creates an account that is already confirmed.
export default function JoinTeam() {
  const { inviteId = '' } = useParams();
  const navigate = useNavigate();
  const { signIn, session, signOut } = useAuth();

  const [invite, setInvite] = useState<InviteDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError(null);
    team.inviteDetails(inviteId)
      .then(d => { if (alive) setInvite(d); })
      .catch(() => { if (alive) setLoadError("We couldn't open this invite. Refresh the page, or ask whoever invited you to send the link again."); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [inviteId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!invite) return;
    setError(null); setErrorCode(null);
    if (!fullName.trim()) { setError('Enter your name.'); return; }
    if (password.length < 8) { setError('Your password needs at least 8 characters.'); return; }
    setSaving(true);
    const res = await team.acceptInvite(inviteId, fullName.trim(), password);
    if (!res.success) {
      setSaving(false);
      setError(res.error ?? 'Something went wrong. Please try again.');
      setErrorCode(res.code ?? null);
      return;
    }
    // Someone else may be signed in on this phone; the new account wins.
    if (session) await signOut();
    const { error: signInErr } = await signIn(res.email ?? invite.email, password);
    setSaving(false);
    if (signInErr) {
      setError('Your account is ready. Sign in with your email and the password you just chose.');
      setErrorCode('has_password');
      return;
    }
    navigate('/dashboard', { replace: true });
  };

  const shell = (body: React.ReactNode) => (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark size={52} className="auth-mark" />
          <h1>ProfixBook</h1>
        </div>
        {body}
      </div>
    </div>
  );

  if (loading) {
    return shell(<div style={{ textAlign: 'center', padding: '1rem 0' }}><Loader2 className="spin" size={22} aria-label="Loading" /></div>);
  }

  if (loadError) {
    return shell(<div className="auth-alert error">{loadError}</div>);
  }

  if (!invite || invite.status !== 'pending') {
    return shell(
      <>
        <div className="auth-intro">
          <h2>{!invite ? 'This invite link is not valid' : invite.status === 'expired' ? 'This invite link has expired' : 'This invite has already been used'}</h2>
          <p>
            {invite?.status === 'expired'
              ? 'Invite links last 7 days. Ask whoever invited you to send a new one.'
              : invite
              ? 'If you already joined, sign in with your email and password. If you never set a password, ask your admin to send you a new invite link.'
              : 'It may have been cancelled, or the link was cut short when it was copied. Ask whoever invited you to send it again.'}
          </p>
        </div>
        <button className="btn-primary auth-submit" onClick={() => navigate('/login')}>Go to Sign In</button>
      </>,
    );
  }

  return shell(
    <>
      <div className="auth-intro">
        <h2>Join {invite.company}</h2>
        <p>You've been invited as {ROLE_LABEL[invite.role] ?? invite.role}. Choose a password and you're in.</p>
      </div>

      {error && (
        <div className="auth-alert error">
          {error}
          {errorCode === 'has_password' && (
            <button type="button" className="link-btn auth-alert-action" onClick={() => navigate('/login')}>Go to Sign In</button>
          )}
        </div>
      )}

      <form onSubmit={submit}>
        <div className="form-group">
          <label htmlFor="join-email">Email</label>
          <input id="join-email" type="email" value={invite.email} readOnly disabled />
        </div>
        <div className="form-group">
          <label htmlFor="join-name">Your name</label>
          <input id="join-name" value={fullName} onChange={e => setFullName(e.target.value)} autoComplete="name" required placeholder="e.g. Ada Okafor" />
        </div>
        <div className="form-group">
          <label htmlFor="join-password">Choose a password</label>
          <div className="auth-password">
            <input id="join-password" type={showPassword ? 'text' : 'password'} value={password}
              onChange={e => setPassword(e.target.value)} autoComplete="new-password" required minLength={8} placeholder="At least 8 characters" />
            <button type="button" className="auth-password-toggle" onClick={() => setShowPassword(s => !s)}
              aria-label={showPassword ? 'Hide password' : 'Show password'}>
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
        <button type="submit" className="btn-primary auth-submit" disabled={saving}>
          {saving ? <><Loader2 size={16} className="spin" /> Setting up your account</> : `Join ${invite.company}`}
        </button>
      </form>

      <p className="auth-foot">
        Already joined? <button className="link-btn" onClick={() => navigate('/login')}>Sign in</button>
      </p>
    </>,
  );
}
