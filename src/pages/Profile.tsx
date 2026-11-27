import React, { useState } from 'react';
import { UserCircle, KeyRound, Check, HelpCircle } from 'lucide-react';
import { profileApi } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import ApprovalPinCard from '../components/ApprovalPinCard';
import { useHelpState, writeHelp } from '../lib/helpState';

const ROLE_LABEL: Record<string, string> = {
  admin: 'Admin — full access',
  sales: 'Sales — the counter',
  inventory: 'Inventory — stock & production',
  accounts: 'Accounts — finance & reports',
  cashier: 'Cashier — till only',
};

// Name and password used to live only on /settings, which is admin-only —
// so every cashier, storekeeper and bookkeeper was stuck forever with the
// password they were first given, with no way to change it. This page is
// open to all four roles and deliberately holds nothing else.
export default function Profile() {
  const { profile, tenant, refresh } = useAuth();
  const toast = useToast();
  const help = useHelpState(profile?.id);

  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  const nameMut = useMutation((id: string, name: string) => profileApi.updateName(id, name));
  const passMut = useMutation(profileApi.changePassword);

  const saveName = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    const trimmed = fullName.trim();
    if (!trimmed) { toast.error('Your name cannot be empty.'); return; }
    const res = await nameMut.mutate(profile.id, trimmed);
    if (res !== null) { toast.success('Name updated.'); refresh(); }
    else toast.error(nameMut.error ?? 'Could not save your name.');
  };

  const savePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (password.length < 6) { toast.error('Use at least 6 characters.'); return; }
    if (password !== confirm) { toast.error("The two passwords don't match."); return; }
    const res = await passMut.mutate(password);
    if (res !== null) {
      toast.success('Password changed.');
      setPassword('');
      setConfirm('');
    } else {
      toast.error(passMut.error ?? 'Could not change your password.');
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>My Profile</h1>
          <p>Your details and password</p>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(20rem, 1fr))', gap: '1rem' }}>

        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '1rem' }}>
            <UserCircle size={17} /> Your details
          </h3>

          <form onSubmit={saveName}>
            <div className="form-group">
              <label>Full name</label>
              <input value={fullName} onChange={e => setFullName(e.target.value)} placeholder="e.g. Amaka Obi" />
            </div>

            <div className="form-group">
              <label>Email</label>
              <input value={profile?.email ?? '—'} disabled />
              <small style={{ color: '#94a3b8', fontSize: '0.78rem' }}>
                Your email is how you sign in and can't be changed here.
              </small>
            </div>

            <div className="form-group">
              <label>Company</label>
              <input value={tenant?.name ?? '—'} disabled />
            </div>

            <div className="form-group">
              <label>Role</label>
              <input value={profile ? (ROLE_LABEL[profile.role] ?? profile.role) : '—'} disabled />
              <small style={{ color: '#94a3b8', fontSize: '0.78rem' }}>
                Only an admin can change a role — including their own.
              </small>
            </div>

            <button className="btn-primary" type="submit" disabled={nameMut.pending}>
              {nameMut.pending ? 'Saving…' : <><Check size={15} /> Save name</>}
            </button>
          </form>
        </div>

        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '1rem' }}>
            <KeyRound size={17} /> Change password
          </h3>

          <form onSubmit={savePassword}>
            <div className="form-group">
              <label>New password</label>
              <input type="password" value={password} onChange={e => setPassword(e.target.value)}
                     autoComplete="new-password" placeholder="At least 6 characters" />
            </div>

            <div className="form-group">
              <label>Confirm new password</label>
              <input type="password" value={confirm} onChange={e => setConfirm(e.target.value)}
                     autoComplete="new-password" placeholder="Type it again" />
            </div>

            <button className="btn-primary" type="submit" disabled={passMut.pending || !password}>
              {passMut.pending ? 'Changing…' : 'Change password'}
            </button>
          </form>
        </div>

        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.5rem' }}>
            <HelpCircle size={17} /> Help and tips
          </h3>
          <p style={{ fontSize: '0.85rem', color: '#64748b', margin: '0 0 1rem', lineHeight: 1.55 }}>
            Every page has a help button beside its title. Busy pages also show a few tips the first time you open them.
          </p>
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', marginBottom: '1rem', fontSize: '0.9rem' }}>
            <input type="checkbox" checked={!help.off} onChange={e => writeHelp(profile?.id, { off: !e.target.checked })}
                   style={{ width: 18, height: 18, accentColor: '#2563eb' }} />
            Show tips the first time I open a page
          </label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            <button type="button" className="btn-secondary btn-sm"
                    onClick={() => { writeHelp(profile?.id, { off: false, seen: [] }); toast.success('Tips will show again on each page.'); }}>
              Show me around again
            </button>
            {profile?.role === 'admin' && help.checklistHidden && (
              <button type="button" className="btn-secondary btn-sm"
                      onClick={() => { writeHelp(profile?.id, { checklistHidden: false }); toast.success('The setup checklist is back on your dashboard.'); }}>
                Show the setup checklist
              </button>
            )}
          </div>
        </div>

        {/* Admins, sales leads and accounts approve cashier returns (0054). */}
        {(profile?.role === 'admin' || profile?.role === 'sales' || profile?.role === 'accounts') && <ApprovalPinCard />}

      </div>
    </div>
  );
}
