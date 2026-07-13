import React, { useState } from 'react';
import { Building2, Users, Tags, FlaskConical, Plus, X, Trash2, Send } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import {
  team, tenantApi, lookupsAdmin, profileApi, lookups, boms,
  materials as materialsApi, finishedGoods as goodsApi,
  TeamMember, StaffInvite, LookupTable, Lookup, Material, FinishedGood,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState, Empty } from '../components/DataStates';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';

type Tab = 'business' | 'team' | 'types' | 'recipes';

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'business', label: 'Business & Profile', icon: <Building2 size={15} /> },
  { id: 'team', label: 'Team', icon: <Users size={15} /> },
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
  const [tab, setTab] = useState<Tab>('business');

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Settings</h1><p>Manage your business, team, and configuration</p></div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.25rem', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
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
      {tab === 'team' && <TeamTab />}
      {tab === 'types' && <TypesTab />}
      {tab === 'recipes' && <RecipesTab />}
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
  const [fullName, setFullName] = useState(profile?.full_name ?? '');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');

  const saveBiz = useMutation((id: string, patch: any) => tenantApi.update(id, patch));
  const saveName = useMutation((id: string, n: string) => profileApi.updateName(id, n));
  const savePw = useMutation(profileApi.changePassword);

  const submitBusiness = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenant) return;
    const res = await saveBiz.mutate(tenant.id, { name: name.trim(), currency });
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
function TeamTab() {
  const toast = useToast();
  const { profile } = useAuth();
  const membersQ = useQuery<TeamMember[]>(() => team.members(), []);
  const invitesQ = useQuery<StaffInvite[]>(() => team.invites(), []);

  const roleMut = useMutation((id: string, role: string) => team.setRole(id, role));
  const activeMut = useMutation((id: string, on: boolean) => team.setActive(id, on));
  const inviteMut = useMutation((email: string, role: string) => team.invite(email, role));
  const revokeMut = useMutation(team.revokeInvite);

  const [showInvite, setShowInvite] = useState(false);
  const [invEmail, setInvEmail] = useState('');
  const [invRole, setInvRole] = useState('sales');
  const [deactivating, setDeactivating] = useState<TeamMember | null>(null);

  const changeRole = async (m: TeamMember, role: string) => {
    const res = await roleMut.mutate(m.id, role);
    if (res !== null) { toast.success(`${m.full_name ?? m.email} is now ${role}.`); membersQ.refetch(); }
    else toast.error(roleMut.error ?? 'Role change failed.');
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
    const res = await inviteMut.mutate(invEmail, invRole);
    if (res !== null) {
      toast.success(`Invite created for ${invEmail}. Ask them to sign up with that exact email.`);
      setShowInvite(false); setInvEmail(''); setInvRole('sales');
      invitesQ.refetch();
    } else {
      toast.error(inviteMut.error ?? 'Invite failed.');
    }
  };

  const revoke = async (id: string) => {
    const res = await revokeMut.mutate(id);
    if (res !== null) { toast.success('Invite revoked.'); invitesQ.refetch(); }
    else toast.error(revokeMut.error ?? 'Failed.');
  };

  if (membersQ.loading) return <Loading label="Loading team…" />;
  if (membersQ.error) return <ErrorState message={membersQ.error} onRetry={membersQ.refetch} />;

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
        <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
          {membersQ.data?.length ?? 0} member{(membersQ.data?.length ?? 0) !== 1 ? 's' : ''}
        </p>
        <button className="btn-primary" onClick={() => setShowInvite(true)}><Plus size={16} /> Invite User</button>
      </div>

      <div className="table-wrapper" style={{ marginBottom: '1.5rem' }}>
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th style={{ textAlign: 'right' }}>Actions</th></tr></thead>
          <tbody>
            {membersQ.data?.map(m => {
              const isSelf = m.id === profile?.id;
              return (
                <tr key={m.id}>
                  <td><strong>{m.full_name ?? '—'}</strong>{isSelf && <span className="badge-primary" style={{ marginLeft: 8 }}>You</span>}</td>
                  <td>{m.email ?? '—'}</td>
                  <td>
                    <select value={m.role} disabled={isSelf} onChange={e => changeRole(m, e.target.value)}
                      style={{ padding: '0.3rem 0.5rem', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: '0.82rem' }}>
                      {roleOptions.map(r => <option key={r.value} value={r.value}>{r.value}</option>)}
                    </select>
                  </td>
                  <td>{m.is_active ? <span className="badge-success">Active</span> : <span className="badge-danger">Deactivated</span>}</td>
                  <td style={{ textAlign: 'right' }}>
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
                  <td><strong>{inv.email}</strong></td>
                  <td><span className="badge-gray">{inv.role}</span></td>
                  <td>{new Date(inv.created_at).toLocaleDateString('en-GB')}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button className="btn-ghost btn-sm" style={{ color: '#dc2626' }} onClick={() => revoke(inv.id)}><Trash2 size={14} /> Revoke</button>
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
    </div>
  );
}

// ============================================================
// Types — payment / expense / customer lookups
// ============================================================
function TypesTab() {
  return (
    <div className="grid-3" style={{ alignItems: 'start' }}>
      <LookupCard title="Payment Types" table="payment_types" fetcher={lookups.paymentTypes} />
      <LookupCard title="Expense Types" table="expense_types" fetcher={lookups.expenseTypes} />
      <LookupCard title="Customer Types" table="customer_types" fetcher={lookups.customerTypes} />
    </div>
  );
}

function LookupCard({ title, table, fetcher }: { title: string; table: LookupTable; fetcher: () => Promise<Lookup[]> }) {
  const toast = useToast();
  const q = useQuery<Lookup[]>(fetcher, []);
  const addMut = useMutation((name: string) => lookupsAdmin.add(table, name));
  const delMut = useMutation((id: string) => lookupsAdmin.remove(table, id));
  const [name, setName] = useState('');

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const res = await addMut.mutate(name.trim());
    if (res !== null) { toast.success(`${name.trim()} added.`); setName(''); q.refetch(); }
    else toast.error(addMut.error ?? 'Add failed.');
  };

  const remove = async (row: Lookup) => {
    const res = await delMut.mutate(row.id);
    if (res !== null) { toast.success(`${row.name} removed.`); q.refetch(); }
    else {
      const msg = delMut.error ?? '';
      toast.error(msg.includes('violates') || msg.includes('foreign key')
        ? `Cannot remove — "${row.name}" is used by existing records.` : msg || 'Remove failed.');
    }
  };

  return (
    <div className="card">
      <h3 style={{ marginBottom: '0.75rem' }}>{title}</h3>
      {q.loading ? <Loading /> : (
        <>
          {q.data?.map(row => (
            <div key={row.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.45rem 0', borderBottom: '1px solid #f1f5f9', fontSize: '0.875rem' }}>
              <span>{row.name}</span>
              <button className="btn-ghost btn-sm" style={{ color: '#dc2626' }} onClick={() => remove(row)} title="Remove"><Trash2 size={13} /></button>
            </div>
          ))}
          <form onSubmit={add} style={{ display: 'flex', gap: '0.5rem', marginTop: '0.75rem' }}>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="New type…"
              style={{ flex: 1, padding: '0.45rem 0.6rem', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: '0.85rem' }} />
            <button className="btn-secondary btn-sm" type="submit" disabled={addMut.pending}><Plus size={14} /></button>
          </form>
        </>
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
