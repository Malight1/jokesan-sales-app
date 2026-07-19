import React, { useState } from 'react';
import { Building2, Users, Tags, FlaskConical, Plus, X, Trash2, Send, CreditCard, Check, MapPin, Pencil, Receipt, Copy } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import {
  team, tenantApi, lookupsAdmin, profileApi, lookups, boms, branding, billing, PLANS, branches as branchesApi,
  materials as materialsApi, finishedGoods as goodsApi,
  TeamMember, StaffInvite, LookupTable, Lookup, Material, FinishedGood, Branch,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState, Empty } from '../components/DataStates';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';
import './Settings.scss';

type Tab = 'business' | 'team' | 'branches' | 'billing' | 'types' | 'recipes';

const ALL_TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'business', label: 'Business & Profile', icon: <Building2 size={15} /> },
  { id: 'team', label: 'Team', icon: <Users size={15} /> },
  { id: 'branches', label: 'Branches', icon: <MapPin size={15} /> },
  { id: 'billing', label: 'Billing', icon: <CreditCard size={15} /> },
  { id: 'types', label: 'Types', icon: <Tags size={15} /> },
  { id: 'recipes', label: 'Recipes (BOM)', icon: <FlaskConical size={15} /> },
];

const roleOptions = [
  { value: 'admin', label: 'Admin — everything' },
  { value: 'sales', label: 'Sales — orders & customers' },
  { value: 'inventory', label: 'Inventory — stock & production' },
  { value: 'accounts', label: 'Accounts — finance & reports' },
];

export default function Settings() {
  const { tenant } = useAuth();
  const isMultiBranch = tenant?.type === 'multi_branch';
  const TABS = ALL_TABS.filter(t => t.id !== 'branches' || isMultiBranch);
  const [tab, setTab] = useState<Tab>('business');

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Settings</h1><p>Manage your business, team, and configuration</p></div>
      </div>

      <div className="settings-tabs">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0.6rem 1.1rem', background: 'none', border: 'none', cursor: 'pointer',
              fontWeight: tab === t.id ? 700 : 400, color: tab === t.id ? '#2563eb' : '#64748b',
              borderBottom: tab === t.id ? '2px solid #2563eb' : '2px solid transparent',
              fontSize: '0.875rem', marginBottom: '-1px' }}>
            {t.icon} {t.label}
          </button>
        ))}
      </div>

      {tab === 'business' && <BusinessTab />}
      {tab === 'team' && <TeamTab isMultiBranch={isMultiBranch} />}
      {tab === 'branches' && isMultiBranch && <BranchesTab />}
      {tab === 'billing' && <BillingTab />}
      {tab === 'types' && <TypesTab />}
      {tab === 'recipes' && <RecipesTab />}
    </div>
  );
}

// ============================================================
// Branches — multi_branch tenants only
// ============================================================
function BranchesTab() {
  const toast = useToast();
  const branchesQ = useQuery<Branch[]>(() => branchesApi.list(), []);
  const createMut = useMutation((b: { name: string; address?: string | null }) => branchesApi.create(b));
  const updateMut = useMutation((id: string, b: Partial<Branch>) => branchesApi.update(id, b));
  const activeMut = useMutation((id: string, on: boolean) => branchesApi.setActive(id, on));

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Branch | null>(null);
  const [name, setName] = useState('');
  const [address, setAddress] = useState('');

  const openCreate = () => { setEditRow(null); setName(''); setAddress(''); setShowModal(true); };
  const openEdit = (b: Branch) => { setEditRow(b); setName(b.name); setAddress(b.address ?? ''); setShowModal(true); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = editRow
      ? await updateMut.mutate(editRow.id, { name: name.trim(), address: address.trim() || null })
      : await createMut.mutate({ name: name.trim(), address: address.trim() || null });
    if (res) {
      toast.success(editRow ? 'Branch updated.' : 'Branch created.');
      setShowModal(false);
      branchesQ.refetch();
    } else {
      toast.error((editRow ? updateMut.error : createMut.error) ?? 'Failed.');
    }
  };

  const toggle = async (b: Branch) => {
    const res = await activeMut.mutate(b.id, !b.is_active);
    if (res !== null) { toast.success(`${b.name} ${b.is_active ? 'deactivated' : 'reactivated'}.`); branchesQ.refetch(); }
    else toast.error(activeMut.error ?? 'Failed.');
  };

  if (branchesQ.loading) return <Loading label="Loading branches…" />;
  if (branchesQ.error) return <ErrorState message={branchesQ.error} onRetry={branchesQ.refetch} />;

  return (
    <div>
      <div className="section-toolbar">
        <p className="section-toolbar-count">{branchesQ.data?.length ?? 0} branch{(branchesQ.data?.length ?? 0) !== 1 ? 'es' : ''}</p>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Branch</button>
      </div>

      <div className="alert alert-info" style={{ fontSize: '0.8rem', marginBottom: '1rem' }}>
        New sales/purchases/production are recorded under the branch each staff member is assigned to (see the Team tab). Assign staff to a branch so their records land in the right place.
      </div>

      {(branchesQ.data?.length ?? 0) === 0 ? <Empty message="No branches yet." /> : (
        <div className="table-wrapper">
          <table>
            <thead><tr><th>Name</th><th>Address</th><th>Status</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
            <tbody>
              {branchesQ.data?.map(b => (
                <tr key={b.id}>
                  <td><strong>{b.name}</strong></td>
                  <td>{b.address || '—'}</td>
                  <td>{b.is_active ? <span className="badge-success">Active</span> : <span className="badge-danger">Inactive</span>}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn-ghost btn-sm" onClick={() => openEdit(b)}><Pencil size={13} /></button>
                    <button className="btn-ghost btn-sm" style={{ color: b.is_active ? '#dc2626' : '#16a34a' }} onClick={() => toggle(b)}>
                      {b.is_active ? 'Deactivate' : 'Reactivate'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 400 }}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Branch' : 'Add Branch'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={submit}>
              <div className="modal-body">
                <div className="form-group"><label>Branch Name</label><input value={name} onChange={e => setName(e.target.value)} required placeholder="e.g. Lagos, Abuja Warehouse…" /></div>
                <div className="form-group"><label>Address</label><input value={address} onChange={e => setAddress(e.target.value)} /></div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={createMut.pending || updateMut.pending}>
                  {createMut.pending || updateMut.pending ? 'Saving…' : editRow ? 'Update' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Billing — Paystack subscription
// ============================================================
declare global { interface Window { PaystackPop?: any; } }

function BillingTab() {
  const toast = useToast();
  const { tenant, profile, refresh } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);

  const currentPlan = tenant?.plan ?? 'trial';
  const trialEnds = tenant?.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const planExpires = tenant?.plan_expires_at ? new Date(tenant.plan_expires_at) : null;
  const trialDaysLeft = trialEnds ? Math.max(0, Math.ceil((trialEnds.getTime() - Date.now()) / 86400000)) : 0;

  const subscribe = (planId: string, price: number) => {
    const pubKey = process.env.REACT_APP_PAYSTACK_PUBLIC_KEY;
    if (!pubKey) { toast.error('Paystack key not configured.'); return; }
    if (!window.PaystackPop) { toast.error('Payment library still loading — try again in a second.'); return; }
    if (!profile?.email) { toast.error('No email on your account.'); return; }

    setBusy(planId);
    const handler = window.PaystackPop.setup({
      key: pubKey,
      email: profile.email,
      amount: price * 100, // kobo
      currency: 'NGN',
      ref: `SF-${planId}-${Date.now()}`,
      metadata: { plan: planId, tenant: tenant?.id },
      callback: (resp: any) => {
        // verify server-side, then activate
        billing.verify(resp.reference, planId).then(r => {
          if (r.success) { toast.success('Subscription active! 🎉'); refresh(); }
          else toast.error(r.error ?? 'Verification failed.');
          setBusy(null);
        });
      },
      onClose: () => { setBusy(null); toast.info('Payment cancelled.'); },
    });
    handler.openIframe();
  };

  return (
    <div>
      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <h3 style={{ marginBottom: '0.5rem' }}>Current Plan</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
          <span className="badge-primary" style={{ fontSize: '0.9rem', padding: '0.35rem 0.8rem', textTransform: 'capitalize' }}>{currentPlan}</span>
          {currentPlan === 'trial' && trialEnds && (
            <span style={{ fontSize: '0.875rem', color: trialDaysLeft <= 3 ? '#dc2626' : '#64748b' }}>
              {trialDaysLeft > 0 ? `${trialDaysLeft} day${trialDaysLeft !== 1 ? 's' : ''} left in your free trial` : 'Trial expired — subscribe to keep using StockFlow'}
            </span>
          )}
          {planExpires && currentPlan !== 'trial' && (
            <span style={{ fontSize: '0.875rem', color: '#64748b' }}>Renews {planExpires.toLocaleDateString('en-GB')}</span>
          )}
        </div>
      </div>

      <div className="grid-3" style={{ alignItems: 'stretch' }}>
        {PLANS.map(p => {
          const active = currentPlan === p.id;
          return (
            <div key={p.id} className="card" style={{ display: 'flex', flexDirection: 'column', border: active ? '2px solid #2563eb' : undefined }}>
              <h3 style={{ marginBottom: '0.15rem' }}>{p.name}</h3>
              <p style={{ color: '#94a3b8', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{p.blurb}</p>
              <div style={{ fontSize: '1.6rem', fontWeight: 700, color: '#0f172a' }}>₦{p.price.toLocaleString()}<span style={{ fontSize: '0.8rem', fontWeight: 400, color: '#94a3b8' }}>/mo</span></div>
              <ul style={{ listStyle: 'none', margin: '0.9rem 0', padding: 0, display: 'flex', flexDirection: 'column', gap: '0.4rem', flex: 1 }}>
                {p.features.map(f => (
                  <li key={f} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, fontSize: '0.82rem', color: '#475569' }}>
                    <Check size={14} color="#16a34a" style={{ marginTop: 2, flexShrink: 0 }} /> {f}
                  </li>
                ))}
              </ul>
              <button className={active ? 'btn-secondary' : 'btn-primary'} disabled={active || busy !== null}
                onClick={() => subscribe(p.id, p.price)}>
                {active ? 'Current Plan' : busy === p.id ? 'Opening…' : `Subscribe ₦${p.price.toLocaleString()}`}
              </button>
            </div>
          );
        })}
      </div>

      <p style={{ fontSize: '0.78rem', color: '#94a3b8', marginTop: '1rem', textAlign: 'center' }}>
        Secure payment by Paystack. You can cancel anytime. Test mode — use card 4084 0840 8408 4081, any future date, CVV 408.
      </p>
    </div>
  );
}

// ============================================================
// Business & Profile
// ============================================================
function BusinessTab() {
  const toast = useToast();
  const { tenant, profile, refresh } = useAuth();
  const [name, setName] = useState(tenant?.name ?? '');
  const [currency, setCurrency] = useState(tenant?.currency ?? 'NGN');
  const [vatEnabled, setVatEnabled] = useState(tenant?.vat_enabled ?? false);
  const [vatRate, setVatRate] = useState(tenant?.vat_rate ?? 7.5);
  const [tin, setTin] = useState(tenant?.tin ?? '');
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');

  const saveBiz = useMutation((id: string, patch: any) => tenantApi.update(id, patch));
  const saveName = useMutation((id: string, n: string) => profileApi.updateName(id, n));
  const savePw = useMutation(profileApi.changePassword);
  const [uploadingLogo, setUploadingLogo] = useState(false);

  const uploadLogo = async (file: File) => {
    if (!tenant) return;
    setUploadingLogo(true);
    try {
      const url = await branding.uploadLogo(tenant.id, file);
      await tenantApi.update(tenant.id, { logo_url: url });
      toast.success('Logo uploaded — it will appear on your invoices.');
      refresh();
    } catch (e: any) {
      toast.error(e.message ?? 'Logo upload failed.');
    } finally {
      setUploadingLogo(false);
    }
  };

  const submitBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenant) return;
    const res = await saveBiz.mutate(tenant.id, { name: name.trim(), currency, vat_enabled: vatEnabled, vat_rate: Number(vatRate) || 0, tin: tin.trim() || null });
    if (res !== null) { toast.success('Business updated.'); refresh(); }
    else toast.error(saveBiz.error ?? 'Update failed.');
  };

  const submitProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!profile) return;
    const res = await saveName.mutate(profile.id, fullName.trim());
    if (res !== null) { toast.success('Profile updated.'); refresh(); }
    else toast.error(saveName.error ?? 'Update failed.');
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pw.length < 6) { toast.error('Password must be at least 6 characters.'); return; }
    if (pw !== pw2) { toast.error('Passwords do not match.'); return; }
    const res = await savePw.mutate(pw);
    if (res !== null) { toast.success('Password changed.'); setPw(''); setPw2(''); }
    else toast.error(savePw.error ?? 'Password change failed.');
  };

  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <h3 style={{ marginBottom: '1rem' }}>Business</h3>

        <div className="form-group">
          <label>Logo (appears on invoices)</label>
          <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
            <div style={{ width: 56, height: 56, borderRadius: 10, border: '1px solid #e2e8f0', background: '#f8fafc', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden', flexShrink: 0 }}>
              {tenant?.logo_url
                ? <img src={tenant.logo_url} alt="logo" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                : <span style={{ color: '#cbd5e1', fontSize: '0.7rem' }}>No logo</span>}
            </div>
            <label className="btn-secondary btn-sm" style={{ cursor: 'pointer' }}>
              {uploadingLogo ? 'Uploading…' : 'Upload Logo'}
              <input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }}
                disabled={uploadingLogo}
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadLogo(f); }} />
            </label>
          </div>
        </div>

        <form onSubmit={submitBusiness}>
          <div className="form-group">
            <label>Business Name (appears on invoices)</label>
            <input value={name} onChange={e => setName(e.target.value)} required />
          </div>
          <div className="form-group">
            <label>Currency</label>
            <select value={currency} onChange={e => setCurrency(e.target.value)}>
              <option value="NGN">₦ Nigerian Naira (NGN)</option>
              <option value="GHS">₵ Ghanaian Cedi (GHS)</option>
              <option value="KES">KSh Kenyan Shilling (KES)</option>
              <option value="USD">$ US Dollar (USD)</option>
            </select>
          </div>

          <hr className="divider" />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.9rem', fontWeight: 600, cursor: 'pointer', marginBottom: '0.75rem' }}>
            <input type="checkbox" checked={vatEnabled} onChange={e => setVatEnabled(e.target.checked)} style={{ width: 'auto' }} />
            Charge VAT on sales
          </label>
          {vatEnabled && (
            <div className="grid-2">
              <div className="form-group">
                <label>VAT Rate (%)</label>
                <NumberInput value={vatRate} onChange={setVatRate} />
              </div>
              <div className="form-group">
                <label>TIN (Tax ID — shown on invoices)</label>
                <input value={tin} onChange={e => setTin(e.target.value)} placeholder="e.g. 01234567-0001" />
              </div>
            </div>
          )}

          <button className="btn-primary" type="submit" disabled={saveBiz.pending}>
            {saveBiz.pending ? 'Saving…' : 'Save Business'}
          </button>
        </form>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>Your Profile</h3>
          <form onSubmit={submitProfile}>
            <div className="form-group">
              <label>Full Name</label>
              <input value={fullName} onChange={e => setFullName(e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Email</label>
              <input value={profile?.email ?? ''} disabled style={{ background: '#f8fafc', color: '#94a3b8' }} />
            </div>
            <button className="btn-primary" type="submit" disabled={saveName.pending}>
              {saveName.pending ? 'Saving…' : 'Save Profile'}
            </button>
          </form>
        </div>

        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>Change Password</h3>
          <form onSubmit={submitPassword}>
            <div className="grid-2">
              <div className="form-group">
                <label>New Password</label>
                <input type="password" value={pw} onChange={e => setPw(e.target.value)} minLength={6} required />
              </div>
              <div className="form-group">
                <label>Confirm Password</label>
                <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} minLength={6} required />
              </div>
            </div>
            <button className="btn-primary" type="submit" disabled={savePw.pending}>
              {savePw.pending ? 'Saving…' : 'Change Password'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

// ============================================================
// Team — members, roles, invites
// ============================================================
function inviteMessage(email: string, role: string, tenantName: string): string {
  const appUrl = window.location.origin;
  return `You've been invited to join ${tenantName} on StockFlow as ${role}.\n\n` +
    `Sign up here with this exact email (${email}):\n${appUrl}\n\n` +
    `Once you sign up, you'll land straight in the company — no extra setup needed.`;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function TeamTab({ isMultiBranch }: { isMultiBranch: boolean }) {
  const toast = useToast();
  const { profile, tenant } = useAuth();
  const membersQ = useQuery<TeamMember[]>(() => team.members(), []);
  const invitesQ = useQuery<StaffInvite[]>(() => team.invites(), []);
  const branchesQ = useQuery<Branch[]>(() => branchesApi.list(), [], { cacheKey: 'settings-branches' });

  const roleMut = useMutation((id: string, role: string) => team.setRole(id, role));
  const activeMut = useMutation((id: string, on: boolean) => team.setActive(id, on));
  const branchMut = useMutation((id: string, branchId: string | null) => team.setBranch(id, branchId));
  const inviteMut = useMutation((email: string, role: string, branchId: string | null) => team.invite(email, role, branchId));
  const revokeMut = useMutation(team.revokeInvite);

  const [showInvite, setShowInvite] = useState(false);
  const [invEmail, setInvEmail] = useState('');
  const [invRole, setInvRole] = useState('sales');
  const [invBranch, setInvBranch] = useState('');
  const [deactivating, setDeactivating] = useState<TeamMember | null>(null);
  const [revoking, setRevoking] = useState<StaffInvite | null>(null);

  const branchName = (id: string | null) => branchesQ.data?.find(b => b.id === id)?.name ?? '—';

  const changeRole = async (m: TeamMember, role: string) => {
    const res = await roleMut.mutate(m.id, role);
    if (res !== null) { toast.success(`${m.full_name ?? m.email} is now ${role}.`); membersQ.refetch(); }
    else toast.error(roleMut.error ?? 'Role change failed.');
  };

  const changeBranch = async (m: TeamMember, branchId: string) => {
    const res = await branchMut.mutate(m.id, branchId || null);
    if (res !== null) { toast.success(`${m.full_name ?? m.email} moved to ${branchName(branchId)}.`); membersQ.refetch(); }
    else toast.error(branchMut.error ?? 'Failed.');
  };

  const confirmDeactivate = async () => {
    if (!deactivating) return;
    const res = await activeMut.mutate(deactivating.id, false);
    if (res !== null) { toast.success('User deactivated.'); membersQ.refetch(); }
    else toast.error(activeMut.error ?? 'Failed.');
    setDeactivating(null);
  };

  const reactivate = async (m: TeamMember) => {
    const res = await activeMut.mutate(m.id, true);
    if (res !== null) { toast.success('User reactivated.'); membersQ.refetch(); }
    else toast.error(activeMut.error ?? 'Failed.');
  };

  const sendInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    const email = invEmail.trim().toLowerCase();
    if (!email) return;

    const alreadyMember = membersQ.data?.some(m => (m.email ?? '').toLowerCase() === email);
    if (alreadyMember) { toast.error('That email already belongs to someone on your team.'); return; }

    const alreadyInvited = invitesQ.data?.some(i => i.email.toLowerCase() === email);
    if (alreadyInvited) { toast.error('There is already a pending invite for that email.'); return; }

    const res = await inviteMut.mutate(email, invRole, invBranch || null);
    if (res !== null) {
      setShowInvite(false); setInvEmail(''); setInvRole('sales'); setInvBranch('');
      invitesQ.refetch();

      const copied = await copyToClipboard(inviteMessage(email, invRole, tenant?.name ?? 'your company'));

      // Best-effort real email — the invite row already exists either way,
      // so a failure here (rate limit, etc.) never loses the invite.
      const emailRes = await team.sendInviteEmail(email, `${window.location.origin}/accept-invite`, invRole, tenant?.name ?? 'your company');
      if (emailRes.ok) {
        toast.success(`Invite email sent to ${email}.${copied ? ' A backup message was also copied to your clipboard.' : ''}`);
      } else {
        toast.info(copied
          ? `Couldn't send an email automatically — an invite message was copied to your clipboard instead. Paste it to them on WhatsApp/SMS.`
          : `Invite created for ${email}. Ask them to sign up with that exact email.`);
      }
    } else {
      const msg = inviteMut.error ?? '';
      toast.error(msg.includes('duplicate key') || msg.includes('idx_invites_unique_pending')
        ? 'There is already a pending invite for that email.' : msg || 'Invite failed.');
    }
  };

  const copyInvite = async (inv: StaffInvite) => {
    const ok = await copyToClipboard(inviteMessage(inv.email, inv.role, tenant?.name ?? 'your company'));
    toast[ok ? 'success' : 'error'](ok ? 'Invite message copied — paste it to them.' : 'Could not access clipboard.');
  };

  const confirmRevoke = async () => {
    if (!revoking) return;
    const res = await revokeMut.mutate(revoking.id);
    if (res !== null) { toast.success('Invite revoked.'); invitesQ.refetch(); }
    else toast.error(revokeMut.error ?? 'Failed.');
    setRevoking(null);
  };

  if (membersQ.loading) return <Loading label="Loading team…" />;
  if (membersQ.error) return <ErrorState message={membersQ.error} onRetry={membersQ.refetch} />;

  return (
    <div>
      <div className="section-toolbar">
        <p className="section-toolbar-count">
          {membersQ.data?.length ?? 0} member{(membersQ.data?.length ?? 0) !== 1 ? 's' : ''}
        </p>
        <button className="btn-primary" onClick={() => setShowInvite(true)}><Plus size={16} /> Invite User</button>
      </div>

      <div className="table-wrapper" style={{ marginBottom: '1.5rem' }}>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th>{isMultiBranch && <th>Branch</th>}<th>Status</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
          <tbody>
            {membersQ.data?.map(m => {
              const isSelf = m.id === profile?.id;
              return (
                <tr key={m.id}>
                  <td data-label="Name"><strong>{m.full_name ?? '—'}</strong>{isSelf && <span className="badge-primary" style={{ marginLeft: 8 }}>You</span>}</td>
                  <td data-label="Email">{m.email ?? '—'}</td>
                  <td data-label="Role">
                    <select value={m.role} disabled={isSelf} onChange={e => changeRole(m, e.target.value)}
                      style={{ padding: '0.3rem 0.5rem', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: '0.82rem' }}>
                      {roleOptions.map(r => <option key={r.value} value={r.value}>{r.value}</option>)}
                    </select>
                  </td>
                  {isMultiBranch && (
                    <td data-label="Branch">
                      <select value={m.branch_id ?? ''} onChange={e => changeBranch(m, e.target.value)}
                        style={{ padding: '0.3rem 0.5rem', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: '0.82rem' }}>
                        <option value="">— none —</option>
                        {branchesQ.data?.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </select>
                    </td>
                  )}
                  <td data-label="Status">{m.is_active ? <span className="badge-success">Active</span> : <span className="badge-danger">Deactivated</span>}</td>
                  <td data-label="Actions" style={{ textAlign: 'right' }}>
                    {!isSelf && (m.is_active
                      ? <button className="btn-ghost btn-sm" style={{ color: '#dc2626' }} onClick={() => setDeactivating(m)}>Deactivate</button>
                      : <button className="btn-ghost btn-sm" onClick={() => reactivate(m)}>Reactivate</button>)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3 style={{ marginBottom: '0.75rem' }}>Pending Invites</h3>
      {(invitesQ.data?.length ?? 0) === 0 ? (
        <Empty message="No pending invites. Invite a teammate — they sign up with that email and land inside your company automatically." />
      ) : (
        <div className="table-wrapper">
          <table>
            <thead><tr><th>Email</th><th>Role</th><th>Invited</th><th style={{ textAlign: 'right' }}></th></tr></thead>
            <tbody>
              {invitesQ.data?.map(inv => (
                <tr key={inv.id}>
                  <td data-label="Email"><strong>{inv.email}</strong></td>
                  <td data-label="Role"><span className="badge-gray">{inv.role}</span></td>
                  <td data-label="Invited">{new Date(inv.created_at).toLocaleDateString('en-GB')}</td>
                  <td data-label="Actions" style={{ textAlign: 'right' }}>
                    <button className="btn-ghost btn-sm" onClick={() => copyInvite(inv)} title="Copy invite message"><Copy size={13} /> Copy</button>{' '}
                    <button className="btn-ghost btn-sm" style={{ color: '#dc2626' }} onClick={() => setRevoking(inv)}><Trash2 size={14} /> Revoke</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showInvite && (
        <div className="modal-overlay" onClick={() => setShowInvite(false)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 420 }}>
            <div className="modal-header">
              <h2>Invite a Team Member</h2>
              <button className="close-btn" onClick={() => setShowInvite(false)}><X size={18} /></button>
            </div>
            <form onSubmit={sendInvite}>
              <div className="modal-body">
                {inviteMut.error && <ErrorState message={inviteMut.error} />}
                <div className="form-group">
                  <label>Email</label>
                  <input type="email" value={invEmail} onChange={e => setInvEmail(e.target.value)} required placeholder="staff@company.com" />
                </div>
                <div className="form-group">
                  <label>Role</label>
                  <select value={invRole} onChange={e => setInvRole(e.target.value)}>
                    {roleOptions.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                  </select>
                </div>
                {isMultiBranch && (
                  <div className="form-group">
                    <label>Branch</label>
                    <select value={invBranch} onChange={e => setInvBranch(e.target.value)}>
                      <option value="">— none yet —</option>
                      {branchesQ.data?.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                )}
                <div className="alert alert-info" style={{ fontSize: '0.8rem' }}>
                  Share the app link with them. When they <strong>sign up using this exact email</strong>, they'll automatically join your company with this role — no new company gets created.
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowInvite(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={inviteMut.pending}>
                  <Send size={14} /> {inviteMut.pending ? 'Creating…' : 'Create Invite'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deactivating && (
        <ConfirmDialog
          title="Deactivate User"
          message={<>Deactivate <strong>{deactivating.full_name ?? deactivating.email}</strong>? They will be locked out of the app immediately. You can reactivate them anytime.</>}
          confirmLabel="Deactivate"
          pending={activeMut.pending}
          onConfirm={confirmDeactivate}
          onCancel={() => setDeactivating(null)}
        />
      )}

      {revoking && (
        <ConfirmDialog
          title="Revoke Invite"
          message={<>Revoke the invite for <strong>{revoking.email}</strong>? They won't be able to sign up with that email into your company unless you invite them again.</>}
          confirmLabel="Revoke"
          pending={revokeMut.pending}
          onConfirm={confirmRevoke}
          onCancel={() => setRevoking(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// Types — payment / expense / customer lookups
// ============================================================
function TypesTab() {
  return (
    <div className="grid-3 lookup-grid" style={{ alignItems: 'start' }}>
      <LookupCard
        title="Payment Types" noun="payment" hint="How customers pay you"
        icon={<CreditCard size={16} />} table="payment_types" fetcher={lookups.paymentTypes}
      />
      <LookupCard
        title="Expense Types" noun="expense" hint="Categories for money going out"
        icon={<Receipt size={16} />} table="expense_types" fetcher={lookups.expenseTypes}
      />
      <LookupCard
        title="Customer Types" noun="customer" hint="Segments for your customer base"
        icon={<Users size={16} />} table="customer_types" fetcher={lookups.customerTypes}
      />
    </div>
  );
}

function LookupRow({ row, onRename, onDelete }: {
  row: Lookup; onRename: (id: string, newName: string) => Promise<boolean>; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(row.name);
  const [saving, setSaving] = useState(false);

  const startEdit = () => { setValue(row.name); setEditing(true); };
  const cancel = () => { setValue(row.name); setEditing(false); };

  const save = async () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === row.name) { cancel(); return; }
    setSaving(true);
    const ok = await onRename(row.id, trimmed);
    setSaving(false);
    if (ok) setEditing(false); else setValue(row.name);
  };

  if (editing) {
    return (
      <div className="lookup-row editing">
        <input
          autoFocus
          value={value}
          disabled={saving}
          onChange={e => setValue(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') cancel(); }}
        />
        <div className="lookup-row-actions">
          <button className="lookup-action save" onClick={save} disabled={saving} title="Save" aria-label={`Save ${row.name}`}>
            <Check size={14} />
          </button>
          <button className="lookup-action" onClick={cancel} disabled={saving} title="Cancel" aria-label="Cancel">
            <X size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="lookup-row">
      <span>{row.name}</span>
      <div className="lookup-row-actions">
        <button className="lookup-action" onClick={startEdit} title="Rename" aria-label={`Rename ${row.name}`}>
          <Pencil size={13} />
        </button>
        <button className="lookup-action danger" onClick={onDelete} title="Remove" aria-label={`Remove ${row.name}`}>
          <Trash2 size={13} />
        </button>
      </div>
    </div>
  );
}

function LookupCard({ title, noun, hint, icon, table, fetcher }: {
  title: string; noun: string; hint: string; icon: React.ReactNode; table: LookupTable; fetcher: () => Promise<Lookup[]>;
}) {
  const toast = useToast();
  const q = useQuery<Lookup[]>(fetcher, []);
  const addMut = useMutation((name: string) => lookupsAdmin.add(table, name));
  const editMut = useMutation((id: string, newName: string) => lookupsAdmin.rename(table, id, newName));
  const delMut = useMutation((id: string) => lookupsAdmin.remove(table, id));
  const [name, setName] = useState('');
  const [toDelete, setToDelete] = useState<Lookup | null>(null);

  const rename = async (id: string, newName: string) => {
    const res = await editMut.mutate(id, newName);
    if (res !== null) { toast.success('Renamed.'); q.refetch(); return true; }
    toast.error(editMut.error ?? 'Rename failed.');
    return false;
  };

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const res = await addMut.mutate(name.trim());
    if (res !== null) { toast.success(`${name.trim()} added.`); setName(''); q.refetch(); }
    else toast.error(addMut.error ?? 'Add failed.');
  };

  const confirmRemove = async () => {
    if (!toDelete) return;
    const res = await delMut.mutate(toDelete.id);
    if (res !== null) { toast.success(`${toDelete.name} removed.`); q.refetch(); }
    else {
      const msg = delMut.error ?? '';
      toast.error(msg.includes('violates') || msg.includes('foreign key')
        ? `Cannot remove — "${toDelete.name}" is used by existing records.` : msg || 'Remove failed.');
    }
    setToDelete(null);
  };

  const rows = q.data ?? [];

  return (
    <div className="card lookup-card">
      <div className="lookup-head">
        <div className="lookup-icon">{icon}</div>
        <div className="lookup-heading">
          <h3>{title}</h3>
          <p>{hint}</p>
        </div>
        {!q.loading && <span className="lookup-count">{rows.length}</span>}
      </div>

      {q.loading ? <Loading /> : (
        <>
          <div className="lookup-list">
            {rows.length === 0 ? (
              <div className="lookup-empty">No {noun} types yet — add your first below.</div>
            ) : rows.map(row => (
              <LookupRow key={row.id} row={row} onRename={rename} onDelete={() => setToDelete(row)} />
            ))}
          </div>
          <form onSubmit={add} className="lookup-add">
            <input value={name} onChange={e => setName(e.target.value)} placeholder={`Add a ${noun} type…`} />
            <button className="btn-primary" type="submit" disabled={addMut.pending || !name.trim()} aria-label={`Add ${noun} type`}>
              <Plus size={15} />
            </button>
          </form>
        </>
      )}

      {toDelete && (
        <ConfirmDialog
          title="Remove type"
          message={<>Remove <strong>{toDelete.name}</strong>? This can't be undone.</>}
          confirmLabel="Remove"
          pending={delMut.pending}
          onConfirm={confirmRemove}
          onCancel={() => setToDelete(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// Recipes — BOM editor per finished good
// ============================================================
function RecipesTab() {
  const toast = useToast();
  const goodsQ = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const matsQ = useQuery<Material[]>(() => materialsApi.list(), []);
  const [productId, setProductId] = useState('');
  const [yieldQty, setYieldQty] = useState(50);
  const [items, setItems] = useState<{ material_id: string; quantity: number; unit: string }[]>([]);
  const [loadingBom, setLoadingBom] = useState(false);
  const saveMut = useMutation((pid: string, y: number, its: any[]) => boms.upsert(pid, y, its));

  const loadRecipe = async (pid: string) => {
    setProductId(pid);
    if (!pid) { setItems([]); return; }
    setLoadingBom(true);
    try {
      const bom = await boms.forProduct(pid);
      if (bom && bom.bom_items?.length) {
        setYieldQty(bom.yield_qty ?? 50);
        setItems(bom.bom_items.map((it: any) => ({ material_id: it.material_id, quantity: Number(it.quantity), unit: it.unit ?? '' })));
      } else {
        setYieldQty(50);
        setItems([{ material_id: '', quantity: 0, unit: '' }]);
      }
    } catch (e: any) {
      toast.error(e.message ?? 'Could not load recipe.');
    } finally {
      setLoadingBom(false);
    }
  };

  const save = async () => {
    if (!productId) { toast.error('Pick a product first.'); return; }
    const valid = items.filter(i => i.material_id && i.quantity > 0);
    if (valid.length === 0) { toast.error('Add at least one material with a quantity.'); return; }
    if (yieldQty <= 0) { toast.error('Yield must be greater than zero.'); return; }
    const res = await saveMut.mutate(productId, yieldQty, valid);
    if (res !== null) toast.success('Recipe saved — production will auto-fill with it.');
    else toast.error(saveMut.error ?? 'Save failed.');
  };

  return (
    <div className="card" style={{ maxWidth: 720 }}>
      <h3 style={{ marginBottom: '0.35rem' }}>Product Recipe (Bill of Materials)</h3>
      <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
        Define what goes into one batch of a product. Production runs auto-fill from this and scale to any batch size.
      </p>

      <div className="grid-2">
        <div className="form-group">
          <label>Product</label>
          <select value={productId} onChange={e => loadRecipe(e.target.value)}>
            <option value="">— select a product —</option>
            {goodsQ.data?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Batch Yield (units this recipe makes)</label>
          <NumberInput value={yieldQty} onChange={setYieldQty} />
        </div>
      </div>

      {loadingBom && <Loading label="Loading recipe…" />}

      {productId && !loadingBom && (
        <>
          <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', margin: '0.5rem 0' }}>Materials per batch</p>
          {items.map((it, idx) => (
            <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.5rem' }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Material</label>
                <select value={it.material_id} onChange={e => setItems(arr => arr.map((x, i) => i === idx ? { ...x, material_id: e.target.value } : x))}>
                  <option value="">— select —</option>
                  {matsQ.data?.map(m => <option key={m.id} value={m.id}>{m.name}{m.unit ? ` (${m.unit})` : ''}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Qty</label>
                <NumberInput value={it.quantity} onChange={v => setItems(arr => arr.map((x, i) => i === idx ? { ...x, quantity: v } : x))} />
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label>Unit</label>
                <input value={it.unit} onChange={e => setItems(arr => arr.map((x, i) => i === idx ? { ...x, unit: e.target.value } : x))} placeholder="kg, L…" />
              </div>
              <button type="button" onClick={() => setItems(arr => arr.filter((_, i) => i !== idx))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '0.5rem' }}><X size={14} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '0.75rem' }}>
            <button type="button" className="btn-ghost btn-sm" onClick={() => setItems(arr => [...arr, { material_id: '', quantity: 0, unit: '' }])}>
              <Plus size={14} /> Add material
            </button>
            <button className="btn-primary" onClick={save} disabled={saveMut.pending}>
              {saveMut.pending ? 'Saving…' : 'Save Recipe'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
