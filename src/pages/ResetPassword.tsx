import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import BrandMark from '../components/BrandMark';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabase';
import './Login.scss';

// Where a "reset your password" email lands, whether the person asked for
// it from the sign-in screen or support sent it from the admin panel.
// Supabase signs them in from the link (detectSessionInUrl); all that's
// left is choosing the new password. Same shape as AcceptInvite.
export default function ResetPassword() {
  const { session, loading: authLoading } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // An expired or already-used link comes back with the reason in the
  // URL fragment instead of a session.
  const linkError = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('error_description');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError("Those two passwords don't match."); return; }
    setSaving(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (err) { setError(err.message); return; }
    // Login sends a signed-in visitor on to /platform or /dashboard.
    navigate('/login', { replace: true });
  };

  if (authLoading) {
    return (
      <div className="auth-screen">
        <div className="auth-card" style={{ textAlign: 'center' }}><Loader2 className="spin" size={22} /></div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <BrandMark size={52} className="auth-mark" />
          <h1>ProfixBook</h1>
        </div>

        {!session ? (
          <>
            <div className="auth-alert error">
              {linkError
                ? `This reset link didn't work: ${linkError.replace(/\+/g, ' ')}.`
                : 'This reset link has expired or was already used.'}{' '}
              Ask for a new one and use it within the hour.
            </div>
            <button className="btn-primary auth-submit" onClick={() => navigate('/login')}>Back to Sign In</button>
          </>
        ) : (
          <>
            <div className="auth-intro">
              <h2>Choose a new password</h2>
              <p>For {session.user.email}. You'll stay signed in once it's saved.</p>
            </div>
            {error && <div className="auth-alert error">{error}</div>}
            <form onSubmit={submit}>
              <div className="form-group">
                <label htmlFor="rp-new">New password</label>
                <input id="rp-new" type="password" value={password} onChange={e => setPassword(e.target.value)}
                       required minLength={6} autoComplete="new-password" placeholder="At least 6 characters" />
              </div>
              <div className="form-group">
                <label htmlFor="rp-confirm">Type it again</label>
                <input id="rp-confirm" type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                       required minLength={6} autoComplete="new-password" />
              </div>
              <button type="submit" className="btn-primary auth-submit" disabled={saving}>
                {saving ? <><Loader2 size={16} className="spin" /> Saving…</> : 'Save New Password'}
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
