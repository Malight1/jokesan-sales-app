import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';
import { Building2, Loader2 } from 'lucide-react';
import './Login.scss';

type Mode = 'login' | 'signup';

export default function Login() {
  const { signIn, signUp, session } = useAuth();
  const navigate = useNavigate();

  // Once authenticated, leave the login screen for the dashboard.
  useEffect(() => {
    if (session) navigate('/', { replace: true });
  }, [session, navigate]);
  const [mode, setMode] = useState<Mode>('login');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [companyName, setCompanyName] = useState('');
  const [tenantType, setTenantType] = useState<'single' | 'multi_branch'>('single');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);

    if (mode === 'login') {
      const { error } = await signIn(email, password);
      if (error) setError(error);
    } else {
      const { error } = await signUp({ email, password, fullName, companyName, tenantType });
      if (error) setError(error);
      else setNotice('Account created! Check your email to confirm, then sign in.');
    }
    setLoading(false);
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-brand">
          <div className="auth-logo"><Building2 size={22} /></div>
          <h1>StockFlow</h1>
          <p>Manufacturing &amp; sales, under control.</p>
        </div>

        <div className="auth-tabs">
          <button className={mode === 'login' ? 'active' : ''} onClick={() => { setMode('login'); setError(null); setNotice(null); }}>Sign In</button>
          <button className={mode === 'signup' ? 'active' : ''} onClick={() => { setMode('signup'); setError(null); setNotice(null); }}>Create Account</button>
        </div>

        {error && <div className="auth-alert error">{error}</div>}
        {notice && <div className="auth-alert success">{notice}</div>}

        <form onSubmit={handleSubmit}>
          {mode === 'signup' && (
            <>
              <div className="form-group">
                <label>Your Full Name</label>
                <input value={fullName} onChange={e => setFullName(e.target.value)} required placeholder="e.g. Wummy Oguntunde" />
              </div>
              <div className="form-group">
                <label>Company Name</label>
                <input value={companyName} onChange={e => setCompanyName(e.target.value)} required placeholder="e.g. Jokesan Ventures" />
              </div>
              <div className="form-group">
                <label>Business Type</label>
                <select value={tenantType} onChange={e => setTenantType(e.target.value as any)}>
                  <option value="single">Single location</option>
                  <option value="multi_branch">Multiple branches</option>
                </select>
              </div>
            </>
          )}

          <div className="form-group">
            <label>Email</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@company.com" />
          </div>
          <div className="form-group">
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required minLength={6} placeholder="••••••••" />
          </div>

          <button type="submit" className="btn-primary auth-submit" disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Please wait…</> : mode === 'login' ? 'Sign In' : 'Create Account'}
          </button>
        </form>

        <p className="auth-foot">
          {mode === 'login' ? "New here? " : 'Already have an account? '}
          <button className="link-btn" onClick={() => { setMode(mode === 'login' ? 'signup' : 'login'); setError(null); setNotice(null); }}>
            {mode === 'login' ? 'Create an account' : 'Sign in'}
          </button>
        </p>
      </div>
    </div>
  );
}
