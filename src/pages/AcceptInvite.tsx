import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Building2, KeyRound, Loader2 } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { supabase } from '../lib/supabase';
import './Login.scss';

// Landing page for a real invite email link. Supabase's invite flow
// creates the account without a password — this is where the invitee
// sets one and finishes joining (their profile/tenant/role are already
// attached by the handle_new_user trigger the moment the account exists).
export default function AcceptInvite() {
  const { session, loading: authLoading, tenant } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 6) { setError('Password must be at least 6 characters.'); return; }
    if (password !== confirm) { setError("Passwords don't match."); return; }
    setSaving(true);
    const { error: err } = await supabase.auth.updateUser({ password });
    setSaving(false);
    if (err) { setError(err.message); return; }
    navigate('/', { replace: true });
  };

  if (authLoading) {
    return (
      <div className="auth-screen">
        <div className="auth-card" style={{ textAlign: 'center' }}>
          <Loader2 className="spin" size={22} />
        </div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <div className="auth-brand">
            <div className="auth-logo"><Building2 size={22} /></div>
            <h1>StockFlow</h1>
          </div>
          <div className="auth-alert error">
            This invite link is invalid or has expired. Ask whoever invited you to send a new one, or sign in if you already have an account.
          </div>
          <button className="btn-primary auth-submit" onClick={() => navigate('/login')}>Go to Sign In</button>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-logo"><KeyRound size={22} /></div>
          <h1>Welcome{tenant ? ` to ${tenant.name}` : ''}</h1>
          <p>Set a password to finish joining your team.</p>
        </div>

        {error && <div className="auth-alert error">{error}</div>}

        <form onSubmit={submit}>
          <div className="form-group">
            <label>New Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} placeholder="••••••••" />
          </div>
          <div className="form-group">
            <label>Confirm Password</label>
            <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)} required minLength={6} placeholder="••••••••" />
          </div>
          <button type="submit" className="btn-primary auth-submit" disabled={saving}>
            {saving ? <><Loader2 size={16} className="spin" /> Saving…</> : 'Set Password & Continue'}
          </button>
        </form>
      </div>
    </div>
  );
}
