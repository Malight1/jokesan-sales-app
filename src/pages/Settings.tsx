import React, { useEffect, useState } from 'react';
import { Building2, Users, Tags, FlaskConical, Plus, X, Trash2, Send, CreditCard, Check, MapPin, Pencil, Receipt, Copy, Tag, Star, Lock, Landmark, Link2, ShieldCheck, ListPlus } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import {
  team, tenantApi, lookupsAdmin, profileApi, lookups, boms, branding, billing, PLANS, branches as branchesApi, docs,
  materials as materialsApi, finishedGoods as goodsApi, pricing, registers as registersApi, payments as paymentsApi,
  customFieldDefs, compliance, TeamMember, StaffInvite, LookupTable, Lookup, Material, FinishedGood, Branch, PriceList, PriceListItem, CustomerType, Register, IntegrationStatus,
  CustomFieldDef, CustomFieldEntity, EinvoiceReadiness,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { hasFeature, planFor } from '../lib/features';
import { Loading, ErrorState, Empty } from '../components/DataStates';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';
import './Settings.scss';
import Modal from '../components/Modal';
import DataTable, { Column } from '../components/DataTable';

type Tab = 'business' | 'team' | 'branches' | 'billing' | 'payments' | 'types' | 'pricing' | 'recipes' | 'custom_fields' | 'einvoicing';

const ALL_TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'business', label: 'Business & Profile', icon: <Building2 size={15} /> },
  { id: 'team', label: 'Team', icon: <Users size={15} /> },
  { id: 'branches', label: 'Branches', icon: <MapPin size={15} /> },
  { id: 'billing', label: 'Billing', icon: <CreditCard size={15} /> },
  { id: 'payments', label: 'Payments', icon: <Landmark size={15} /> },
  { id: 'types', label: 'Types', icon: <Tags size={15} /> },
  { id: 'pricing', label: 'Pricing', icon: <Tag size={15} /> },
  { id: 'recipes', label: 'Recipes (BOM)', icon: <FlaskConical size={15} /> },
  { id: 'custom_fields', label: 'Custom Fields', icon: <ListPlus size={15} /> },
  { id: 'einvoicing', label: 'E-Invoicing', icon: <ShieldCheck size={15} /> },
];

const roleOptions = [
  { value: 'admin', label: 'Admin — everything' },
  { value: 'sales', label: 'Sales — orders & customers' },
  { value: 'inventory', label: 'Inventory — stock & production' },
  { value: 'accounts', label: 'Accounts — finance & reports' },
];

// z for a target service level — the database only ever stores and uses
// the raw z number (tenants.reorder_z); this mapping is presentation only.
const SERVICE_LEVELS = [
  { z: 0.84, label: '80% — leaner stock, more chance of running short' },
  { z: 1.28, label: '90%' },
  { z: 1.65, label: '95% — recommended' },
  { z: 2.33, label: '99% — heavier buffer, rarely runs short' },
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
      {tab === 'payments' && <PaymentsTab />}
      {tab === 'types' && <TypesTab />}
      {tab === 'pricing' && <PricingTab />}
      {tab === 'recipes' && <RecipesTab />}
      {tab === 'custom_fields' && <CustomFieldsTab />}
      {tab === 'einvoicing' && <EinvoicingTab />}
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

  // Registers/tills (migration 0026) — "Main till" is created automatically
  // for every branch; this is only for a branch that runs more than one.
  const registersQ = useQuery<Register[]>(() => registersApi.list(), []);
  const createRegMut = useMutation((name: string, branchId: string) => registersApi.create(name, branchId));
  const regActiveMut = useMutation((id: string, on: boolean) => registersApi.setActive(id, on));
  const [showRegModal, setShowRegModal] = useState(false);
  const [regName, setRegName] = useState('');
  const [regBranch, setRegBranch] = useState('');

  const branchName = (id: string) => branchesQ.data?.find(b => b.id === id)?.name ?? '—';

  const openAddRegister = () => { setRegName(''); setRegBranch(branchesQ.data?.[0]?.id ?? ''); setShowRegModal(true); };
  const submitRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!regBranch) { toast.error('Pick a branch.'); return; }
    const res = await createRegMut.mutate(regName.trim(), regBranch);
    if (res) { toast.success('Register added.'); setShowRegModal(false); registersQ.refetch(); }
    else toast.error(createRegMut.error ?? 'Failed.');
  };
  const toggleRegister = async (r: Register) => {
    const res = await regActiveMut.mutate(r.id, !r.is_active);
    if (res !== null) { toast.success(`${r.name} ${r.is_active ? 'deactivated' : 'reactivated'}.`); registersQ.refetch(); }
    else toast.error(regActiveMut.error ?? 'Failed.');
  };

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

  const branchCols: Column<Branch>[] = [
    { key: 'name', header: 'Name', value: b => b.name, render: b => <strong>{b.name}</strong> },
    { key: 'address', header: 'Address', value: b => b.address || '—' },
    { key: 'is_active', header: 'Status', value: b => (b.is_active ? 'Active' : 'Inactive'),
      render: b => b.is_active ? <span className="badge-success">Active</span> : <span className="badge-danger">Inactive</span> },
    { key: 'actions', header: 'Actions', sortable: false, align: 'right', value: () => '',
      render: b => (
        <>
          <button className="btn-ghost btn-sm" onClick={() => openEdit(b)}><Pencil size={13} /></button>
          <button className="btn-ghost btn-sm" style={{ color: b.is_active ? '#dc2626' : '#16a34a' }} onClick={() => toggle(b)}>
            {b.is_active ? 'Deactivate' : 'Reactivate'}
          </button>
        </>
      ) },
  ];

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

      <DataTable
        columns={branchCols}
        rows={branchesQ.data ?? []}
        getRowKey={b => b.id}
        searchKeys={[b => b.name, b => b.address ?? '']}
        searchPlaceholder="Search branches…"
        emptyMessage="No branches yet."
      />

      <div className="section-toolbar" style={{ marginTop: '1.5rem' }}>
        <p className="section-toolbar-count">Registers — every branch already has a "Main till"; add another only if a branch runs more than one</p>
        <button className="btn-secondary" onClick={openAddRegister}><Plus size={16} /> Add Register</button>
      </div>
      {!registersQ.loading && (
        <DataTable
          columns={[
            { key: 'name', header: 'Name', value: r => r.name, render: r => <strong>{r.name}</strong> },
            { key: 'branch', header: 'Branch', value: r => branchName(r.branch_id) },
            { key: 'is_active', header: 'Status', value: r => (r.is_active ? 'Active' : 'Inactive'),
              render: r => r.is_active ? <span className="badge-success">Active</span> : <span className="badge-danger">Inactive</span> },
            { key: 'actions', header: 'Actions', sortable: false, align: 'right', value: () => '',
              render: r => (
                <button className="btn-ghost btn-sm" style={{ color: r.is_active ? '#dc2626' : '#16a34a' }} onClick={() => toggleRegister(r)}>
                  {r.is_active ? 'Deactivate' : 'Reactivate'}
                </button>
              ) },
          ] as Column<Register>[]}
          rows={registersQ.data ?? []}
          getRowKey={r => r.id}
          searchKeys={[r => r.name]}
          searchPlaceholder="Search registers…"
          emptyMessage="No registers yet."
        />
      )}

      {showRegModal && (
        <Modal onClose={() => setShowRegModal(false)} maxWidth={380}>
          <div className="modal-header">
            <h2>Add Register</h2>
            <button className="close-btn" onClick={() => setShowRegModal(false)} aria-label="Close"><X size={18} /></button>
          </div>
          <form onSubmit={submitRegister}>
            <div className="modal-body">
              <div className="form-group">
                <label>Branch</label>
                <select value={regBranch} onChange={e => setRegBranch(e.target.value)}>
                  {(branchesQ.data ?? []).map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label>Register Name</label>
                <input value={regName} onChange={e => setRegName(e.target.value)} required placeholder="e.g. Counter 2" />
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setShowRegModal(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={createRegMut.pending}>
                {createRegMut.pending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {showModal && (
        <Modal onClose={() => setShowModal(false)} maxWidth={400}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Branch' : 'Add Branch'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button>
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
        </Modal>
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
// Payments — connect the business's OWN Paystack account so a transfer
// can confirm itself (migration 0027, Phase 5a). Money never passes
// through StockFlow; this only stores the key (in Supabase Vault, via the
// payments-connect Edge Function) and lets Sales generate "Pay now" links.
// ============================================================
function PaymentsTab() {
  const toast = useToast();
  const statusQ = useQuery<IntegrationStatus>(() => paymentsApi.integrationStatus(), []);
  const [secretKey, setSecretKey] = useState('');
  const [publicKey, setPublicKey] = useState('');
  const [connecting, setConnecting] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!secretKey.trim() || !publicKey.trim()) { toast.error('Both keys are needed.'); return; }
    setConnecting(true);
    try {
      const res = await paymentsApi.connect(secretKey.trim(), publicKey.trim());
      if (res.error) { toast.error(res.error); return; }
      toast.success('Paystack connected — invoices can now get a "Pay now" link.');
      setSecretKey(''); setPublicKey('');
      statusQ.refetch();
    } catch (e: any) {
      toast.error(e.message ?? 'Could not connect.');
    } finally {
      setConnecting(false);
    }
  };

  if (statusQ.loading) return <Loading label="Checking your payment connection…" />;
  if (statusQ.error) return <ErrorState message={statusQ.error} onRetry={statusQ.refetch} />;

  const connected = statusQ.data?.connected;

  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <h3 style={{ marginBottom: '0.5rem', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Landmark size={18} color="#2563eb" /> Paystack
        </h3>
        <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem' }}>
          Connect your OWN Paystack account so a customer's transfer confirms itself — no bank alert to read. Money is collected directly into your account; StockFlow never holds it.
        </p>

        {connected ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0.75rem 1rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 8, marginBottom: '1rem' }}>
            <ShieldCheck size={18} color="#16a34a" />
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#16a34a' }}>Connected</div>
              <div style={{ fontSize: '0.75rem', color: '#64748b' }}>Public key {statusQ.data?.public_key}</div>
            </div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="form-group">
              <label>Secret Key</label>
              <input type="password" value={secretKey} onChange={e => setSecretKey(e.target.value)} placeholder="sk_live_… or sk_test_…" autoComplete="off" />
            </div>
            <div className="form-group">
              <label>Public Key</label>
              <input value={publicKey} onChange={e => setPublicKey(e.target.value)} placeholder="pk_live_… or pk_test_…" autoComplete="off" />
            </div>
            <small style={{ display: 'block', color: '#94a3b8', fontSize: '0.72rem', marginBottom: '0.75rem' }}>
              Find these under your Paystack dashboard → Settings → API Keys & Webhooks. Your secret key is checked once here, then stored securely — nobody at StockFlow can read it back.
            </small>
            <button className="btn-primary" type="submit" disabled={connecting}>
              {connecting ? 'Connecting…' : 'Connect Paystack'}
            </button>
          </form>
        )}
      </div>

      <div className="card">
        <h3 style={{ marginBottom: '0.75rem', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Link2 size={18} color="#2563eb" /> How it works
        </h3>
        <ol style={{ paddingLeft: '1.1rem', fontSize: '0.85rem', color: '#475569', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <li>Connect your Paystack account above (one-time).</li>
          <li>On an unpaid sale, tap "Pay now" to generate a payment link.</li>
          <li>Share it with the customer — WhatsApp, SMS, however you like.</li>
          <li>The moment they pay, the sale updates on its own — no bank alert to paste or match.</li>
        </ol>
        {connected && (
          <p style={{ fontSize: '0.75rem', color: '#94a3b8', marginTop: '0.75rem' }}>
            If Paystack support ever asks for a webhook URL for this account, it's the payments-webhook Edge Function's URL from your Supabase project.
          </p>
        )}
      </div>
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
  // E-invoicing (NRS) readiness (migration 0035, Phase 7c).
  const hasEinvoiceFields = tenant?.rc_number !== undefined;
  const [rcNumber, setRcNumber] = useState(tenant?.rc_number ?? '');
  const [bizAddress, setBizAddress] = useState(tenant?.address ?? '');
  // Invoice numbering and expiry settings (migrations 0021/0022). Only
  // offered once the database has them.
  const hasExpirySettings = tenant?.expiry_warning_days !== undefined;
  const [warnDays, setWarnDays] = useState(tenant?.expiry_warning_days ?? 60);
  const [allowExpired, setAllowExpired] = useState(!!tenant?.allow_expired_sale);
  // How far a cashier may go with a return (migration 0024).
  const hasReturnPolicy = tenant?.cashier_returns !== undefined;
  const [cashierReturns, setCashierReturns] = useState<'none' | 'same_day_own' | 'any'>(tenant?.cashier_returns ?? 'same_day_own');
  // Shifts and cash-up (migration 0026).
  const hasShiftRules = tenant?.shift_rules !== undefined;
  const [tillRequired, setTillRequired] = useState(!!tenant?.shift_rules?.required_for?.includes('sales'));
  const [varianceAlert, setVarianceAlert] = useState(tenant?.shift_rules?.variance_alert ?? 1000);
  const [payOutLimit, setPayOutLimit] = useState(tenant?.shift_rules?.pay_out_limit ?? 5000);
  // Printed on a proforma invoice only (migration 0028, Phase 6a).
  const hasBankDetails = tenant?.bank_details !== undefined;
  const [bankName, setBankName] = useState(tenant?.bank_details?.bank_name ?? '');
  const [bankAccountName, setBankAccountName] = useState(tenant?.bank_details?.account_name ?? '');
  const [bankAccountNumber, setBankAccountNumber] = useState(tenant?.bank_details?.account_number ?? '');
  // Smart reorder suggestions (migration 0034, Phase 7a).
  const hasReorderSettings = tenant?.reorder_z !== undefined;
  const [reorderZ, setReorderZ] = useState(tenant?.reorder_z ?? 1.65);
  const [reorderCoverDays, setReorderCoverDays] = useState(tenant?.reorder_cover_days ?? 14);
  const [reorderDefaultLead, setReorderDefaultLead] = useState(tenant?.reorder_default_lead_days ?? 7);
  const prefixQ = useQuery<string | null>(() => docs.prefix('INV').catch(() => null), []);
  const [invPrefix, setInvPrefix] = useState<string | null>(null);
  const shownPrefix = invPrefix ?? prefixQ.data ?? 'INV-';
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
    const days = Math.round(Number(warnDays) || 0);
    if (hasExpirySettings && (days < 1 || days > 730)) { toast.error('Expiry warning must be between 1 and 730 days.'); return; }
    const res = await saveBiz.mutate(tenant.id, {
      name: name.trim(), currency, vat_enabled: vatEnabled, vat_rate: Number(vatRate) || 0, tin: tin.trim() || null,
      ...(hasExpirySettings ? { expiry_warning_days: days, allow_expired_sale: allowExpired } : {}),
      ...(hasReturnPolicy ? { cashier_returns: cashierReturns } : {}),
      ...(hasShiftRules ? {
        shift_rules: {
          required_for: tillRequired ? ['sales'] : [],
          blind_count: tenant?.shift_rules?.blind_count ?? true,
          variance_alert: Number(varianceAlert) || 0,
          pay_out_limit: Number(payOutLimit) || 0,
        },
      } : {}),
      ...(hasBankDetails ? {
        bank_details: { bank_name: bankName.trim(), account_name: bankAccountName.trim(), account_number: bankAccountNumber.trim() },
      } : {}),
      ...(hasReorderSettings ? {
        reorder_z: Number(reorderZ) || 1.65,
        reorder_cover_days: Math.round(Number(reorderCoverDays) || 14),
        reorder_default_lead_days: Math.round(Number(reorderDefaultLead) || 7),
      } : {}),
      ...(hasEinvoiceFields ? { rc_number: rcNumber.trim() || null, address: bizAddress.trim() || null } : {}),
    });
    if (res === null) { toast.error(saveBiz.error ?? 'Update failed.'); return; }
    if (invPrefix !== null && invPrefix.trim() !== (prefixQ.data ?? 'INV-')) {
      try {
        await docs.setPrefix('INV', invPrefix.trim());
        prefixQ.refetch();
      } catch (err: any) {
        toast.error(`Business saved, but the invoice prefix wasn't: ${err?.message ?? 'unknown error'}`);
        refresh();
        return;
      }
    }
    toast.success('Business updated.');
    refresh();
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
            <div className="form-group">
              <label>VAT Rate (%)</label>
              <NumberInput value={vatRate} onChange={setVatRate} />
            </div>
          )}

          <hr className="divider" />
          <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>Tax & compliance</p>
          <div className="grid-2">
            <div className="form-group">
              <label>TIN (Tax ID — shown on invoices)</label>
              <input value={tin} onChange={e => setTin(e.target.value)} placeholder="e.g. 01234567-0001" />
            </div>
            {hasEinvoiceFields && (
              <div className="form-group">
                <label>RC Number (CAC registration)</label>
                <input value={rcNumber} onChange={e => setRcNumber(e.target.value)} placeholder="e.g. RC1234567" />
              </div>
            )}
          </div>
          {hasEinvoiceFields && (
            <div className="form-group">
              <label>Business Address</label>
              <input value={bizAddress} onChange={e => setBizAddress(e.target.value)} placeholder="Street, city, state" />
              <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                TIN, RC number and this address are the master data Nigeria's e-invoicing (NRS) rollout will want — see Settings → E-Invoicing for readiness.
              </small>
            </div>
          )}

          {!prefixQ.loading && (
            <>
              <hr className="divider" />
              <div className="form-group">
                <label htmlFor="inv-prefix">Invoice number prefix</label>
                <input id="inv-prefix" value={shownPrefix} maxLength={12}
                       onChange={e => setInvPrefix(e.target.value.replace(/[^A-Za-z0-9/_-]/g, '').toUpperCase())} />
                <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                  Next invoice looks like {shownPrefix || 'INV-'}000123. The count carries on; numbers already issued never change.
                </small>
              </div>
            </>
          )}

          {hasExpirySettings && (
            <>
              <hr className="divider" />
              <div className="form-group">
                <label htmlFor="warn-days">Warn me about expiry this many days ahead</label>
                <NumberInput id="warn-days" value={warnDays} onChange={setWarnDays} />
              </div>
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.85rem', cursor: 'pointer', marginBottom: '0.75rem' }}>
                <input type="checkbox" checked={allowExpired} onChange={e => setAllowExpired(e.target.checked)} style={{ width: 'auto', marginTop: 3 }} />
                <span>
                  Allow the till to sell expired stock
                  <small style={{ display: 'block', color: '#94a3b8', fontSize: '0.72rem' }}>Not recommended. NAFDAC can sanction the sale of expired products.</small>
                </span>
              </label>
            </>
          )}

          {hasReturnPolicy && (
            <>
              <hr className="divider" />
              <div className="form-group">
                <label htmlFor="cashier-returns">How far a cashier may go with a return</label>
                <select id="cashier-returns" value={cashierReturns} onChange={e => setCashierReturns(e.target.value as typeof cashierReturns)}>
                  <option value="same_day_own">Their own sales, same day only (default)</option>
                  <option value="any">Any sale, any time</option>
                  <option value="none">Not at all — admin or accounts only</option>
                </select>
                <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>An admin or accounts can always process a return, whatever this is set to.</small>
              </div>
            </>
          )}

          {hasShiftRules && (
            <>
              <hr className="divider" />
              <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.85rem', cursor: 'pointer', marginBottom: '0.75rem' }}>
                <input type="checkbox" checked={tillRequired} onChange={e => setTillRequired(e.target.checked)} style={{ width: 'auto', marginTop: 3 }} />
                <span>
                  Require an open till before selling
                  <small style={{ display: 'block', color: '#94a3b8', fontSize: '0.72rem' }}>
                    Turn this on once registers are set up under Branches — everyone, including admins, will need to open a till before ringing up a sale.
                  </small>
                </span>
              </label>
              {tillRequired && (
                <div className="grid-2">
                  <div className="form-group">
                    <label htmlFor="variance-alert">Flag a cash-up short/over past</label>
                    <NumberInput id="variance-alert" value={varianceAlert} onChange={setVarianceAlert} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="payout-limit">Pay-out needs a manager PIN past</label>
                    <NumberInput id="payout-limit" value={payOutLimit} onChange={setPayOutLimit} />
                  </div>
                </div>
              )}
            </>
          )}

          {hasBankDetails && (
            <>
              <hr className="divider" />
              <div className="form-group">
                <label>Bank details (printed on a proforma invoice only)</label>
                <div className="grid-2">
                  <input value={bankName} onChange={e => setBankName(e.target.value)} placeholder="Bank name" />
                  <input value={bankAccountName} onChange={e => setBankAccountName(e.target.value)} placeholder="Account name" />
                </div>
                <input value={bankAccountNumber} onChange={e => setBankAccountNumber(e.target.value)} placeholder="Account number" style={{ marginTop: '0.5rem' }} />
              </div>
            </>
          )}

          {hasReorderSettings && (
            <>
              <hr className="divider" />
              <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>Reorder suggestions</p>
              <div className="grid-2">
                <div className="form-group">
                  <label>Safety stock service level</label>
                  <select value={reorderZ} onChange={e => setReorderZ(Number(e.target.value))}>
                    {SERVICE_LEVELS.map(l => <option key={l.z} value={l.z}>{l.label}</option>)}
                  </select>
                  <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>How much buffer stock to hold against unusually heavy usage.</small>
                </div>
                <div className="form-group">
                  <label>Cover days</label>
                  <NumberInput value={reorderCoverDays} onChange={setReorderCoverDays} />
                  <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Extra days of stock a suggested order aims to leave you with.</small>
                </div>
              </div>
              <div className="form-group">
                <label>Default lead time (days)</label>
                <NumberInput value={reorderDefaultLead} onChange={setReorderDefaultLead} />
                <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Used only for a material whose supplier hasn't delivered a full order yet, so there's nothing learned to go on.</small>
              </div>
            </>
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

  const selectStyle = { padding: '0.3rem 0.5rem', border: '1px solid #cbd5e1', borderRadius: 6, fontSize: '0.82rem' };

  const memberCols: Column<TeamMember>[] = [
    { key: 'full_name', header: 'Name', value: m => m.full_name ?? '',
      render: m => (
        <>
          <strong>{m.full_name ?? '—'}</strong>
          {m.id === profile?.id && <span className="badge-primary" style={{ marginLeft: 8 }}>You</span>}
        </>
      ) },
    { key: 'email', header: 'Email', value: m => m.email ?? '—' },
    { key: 'role', header: 'Role', value: m => m.role,
      render: m => (
        <select value={m.role} disabled={m.id === profile?.id} onChange={e => changeRole(m, e.target.value)} style={selectStyle}>
          {roleOptions.map(r => <option key={r.value} value={r.value}>{r.value}</option>)}
        </select>
      ) },
    ...(isMultiBranch ? [{
      key: 'branch_id', header: 'Branch',
      value: (m: TeamMember) => branchesQ.data?.find(b => b.id === m.branch_id)?.name ?? '',
      render: (m: TeamMember) => (
        <select value={m.branch_id ?? ''} onChange={e => e.target.value && changeBranch(m, e.target.value)} style={selectStyle}>
          {/* No "none": since 0020 a cashier or storekeeper without a branch can't record anything. */}
          {!m.branch_id && <option value="">Choose a branch…</option>}
          {branchesQ.data?.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
      ),
    } as Column<TeamMember>] : []),
    { key: 'is_active', header: 'Status', value: m => (m.is_active ? 'Active' : 'Deactivated'),
      render: m => m.is_active ? <span className="badge-success">Active</span> : <span className="badge-danger">Deactivated</span> },
    { key: 'actions', header: 'Actions', sortable: false, align: 'right', value: () => '',
      render: m => m.id === profile?.id ? null : (m.is_active
        ? <button className="btn-ghost btn-sm" style={{ color: '#dc2626' }} onClick={() => setDeactivating(m)}>Deactivate</button>
        : <button className="btn-ghost btn-sm" onClick={() => reactivate(m)}>Reactivate</button>) },
  ];

  const inviteCols: Column<StaffInvite>[] = [
    { key: 'email', header: 'Email', value: inv => inv.email, render: inv => <strong>{inv.email}</strong> },
    { key: 'role', header: 'Role', value: inv => inv.role, render: inv => <span className="badge-gray">{inv.role}</span> },
    { key: 'created_at', header: 'Invited', value: inv => inv.created_at,
      render: inv => new Date(inv.created_at).toLocaleDateString('en-GB') },
    { key: 'actions', header: '', sortable: false, align: 'right', value: () => '',
      render: inv => (
        <>
          <button className="btn-ghost btn-sm" onClick={() => copyInvite(inv)} title="Copy invite message"><Copy size={13} /> Copy</button>{' '}
          <button className="btn-ghost btn-sm" style={{ color: '#dc2626' }} onClick={() => setRevoking(inv)}><Trash2 size={14} /> Revoke</button>
        </>
      ) },
  ];

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

      <div style={{ marginBottom: '1.5rem' }}>
        <DataTable
          columns={memberCols}
          rows={membersQ.data ?? []}
          getRowKey={m => m.id}
          searchKeys={[m => m.full_name ?? '', m => m.email ?? '', m => m.role]}
          searchPlaceholder="Search by name, email or role…"
          emptyMessage="No team members yet."
        />
      </div>

      <h3 style={{ marginBottom: '0.75rem' }}>Pending Invites</h3>
      {(invitesQ.data?.length ?? 0) === 0 ? (
        <Empty message="No pending invites. Invite a teammate — they sign up with that email and land inside your company automatically." />
      ) : (
        <div>
          <DataTable
            columns={inviteCols}
            rows={invitesQ.data ?? []}
            getRowKey={inv => inv.id}
            searchKeys={[inv => inv.email, inv => inv.role]}
            searchPlaceholder="Search invites…"
            emptyMessage="No pending invites."
          />
        </div>
      )}

      {showInvite && (
        <Modal onClose={() => setShowInvite(false)} maxWidth={420}>
            <div className="modal-header">
              <h2>Invite a Team Member</h2>
              <button className="close-btn" onClick={() => setShowInvite(false)} aria-label="Close"><X size={18} /></button>
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
                      <option value="">Company default branch</option>
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
        </Modal>
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
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '0.5rem' }} title="Remove ingredient" aria-label="Remove this ingredient"><X size={14} /></button>
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

// ============================================================
// Pricing — price lists, quantity breaks, customer-type assignment,
// and an admin's own manager-approval PIN (migration 0025)
// ============================================================
function PricingTab() {
  const toast = useToast();
  const { tenant } = useAuth();
  const tiersEnabled = hasFeature(tenant?.plan, 'price_tiers');

  const listsQ = useQuery<PriceList[]>(() => pricing.lists(), []);
  const itemsQ = useQuery<PriceListItem[]>(() => pricing.allItems(), []);
  const goodsQ = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const typesQ = useQuery<CustomerType[]>(() => pricing.customerTypes(), []);

  const [selectedList, setSelectedList] = useState('');
  const [newListName, setNewListName] = useState('');
  const [deleteList, setDeleteListState] = useState<PriceList | null>(null);
  const createMut = useMutation(pricing.createList);
  const removeMut = useMutation(pricing.removeList);

  const lists = listsQ.data ?? [];
  useEffect(() => {
    if (!selectedList && listsQ.data && listsQ.data.length > 0) setSelectedList(listsQ.data[0].id);
  }, [listsQ.data, selectedList]);

  const reload = () => { listsQ.refetch(); itemsQ.refetch(); };

  const addList = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newListName.trim()) return;
    const res = await createMut.mutate(newListName.trim());
    if (res) { toast.success(`${res.name} added.`); setNewListName(''); setSelectedList(res.id); reload(); }
    else toast.error(createMut.error ?? 'Could not add that list — is this business on the Growth plan or above?');
  };

  const makeDefault = async (l: PriceList) => {
    await pricing.setDefault(l.id);
    toast.success(`${l.name} is now the default price list.`);
    reload();
  };
  const toggleActive = async (l: PriceList) => {
    await pricing.setActive(l.id, !l.is_active);
    reload();
  };
  const confirmDeleteList = async () => {
    if (!deleteList) return;
    const res = await removeMut.mutate(deleteList.id);
    if (res !== null) {
      toast.success(`${deleteList.name} removed.`);
      if (selectedList === deleteList.id) setSelectedList('');
      reload();
    } else {
      const msg = removeMut.error ?? '';
      toast.error(msg.includes('violates') || msg.includes('foreign key')
        ? `Cannot remove — ${deleteList.name} is assigned to a customer or customer type.` : msg || 'Remove failed.');
    }
    setDeleteListState(null);
  };

  const setTypeList = async (typeId: string, priceListId: string) => {
    await pricing.setCustomerTypeList(typeId, priceListId || null);
    toast.success('Updated.');
    typesQ.refetch();
  };

  if (!tiersEnabled) {
    return (
      <div className="card" style={{ maxWidth: 520, textAlign: 'center', padding: '2.5rem 1.5rem' }}>
        <Tag size={26} color="#2563eb" style={{ marginBottom: '0.5rem' }} />
        <h3 style={{ marginBottom: '0.35rem' }}>Price lists and quantity breaks</h3>
        <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
          Set up retail, wholesale and distributor pricing — with breaks like "12+ at ₦2,400" — on
          the {planFor('price_tiers')} plan and above.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <h3 style={{ marginBottom: '0.25rem' }}>Price Lists</h3>
        <p style={{ color: '#64748b', fontSize: '0.82rem', marginBottom: '1rem' }}>
          A customer with no list of their own uses the default. Quantity breaks (e.g. 12+ at a lower
          price) can be set per product in the database already — this screen sets one flat price per list for now.
        </p>
        {listsQ.loading ? <Loading /> : lists.length === 0 ? (
          <p style={{ color: '#94a3b8', fontSize: '0.85rem', marginBottom: '1rem' }}>No price lists yet — add your first below.</p>
        ) : (
          <div className="lookup-list" style={{ marginBottom: '1rem' }}>
            {lists.map(l => (
              <div key={l.id} className="lookup-row" style={{ opacity: l.is_active ? 1 : 0.55 }}>
                <button type="button" onClick={() => setSelectedList(l.id)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', flex: 1, padding: 0,
                                 fontWeight: selectedList === l.id ? 700 : 400, color: selectedList === l.id ? '#2563eb' : 'inherit' }}>
                  {l.name}{!l.is_active && ' (inactive)'}
                </button>
                {l.is_default && <span className="badge-primary" style={{ marginRight: 8 }}>Default</span>}
                <div className="lookup-row-actions">
                  {!l.is_default && (
                    <button className="lookup-action" onClick={() => makeDefault(l)} title="Make default" aria-label={`Make ${l.name} the default`}>
                      <Star size={13} />
                    </button>
                  )}
                  <button className="lookup-action" onClick={() => toggleActive(l)} title={l.is_active ? 'Deactivate' : 'Activate'}>
                    {l.is_active ? <X size={13} /> : <Check size={13} />}
                  </button>
                  <button className="lookup-action danger" onClick={() => setDeleteListState(l)} title="Remove" aria-label={`Remove ${l.name}`}>
                    <Trash2 size={13} />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
        <form onSubmit={addList} className="lookup-add">
          <input value={newListName} onChange={e => setNewListName(e.target.value)} placeholder="e.g. Wholesale, Distributor…" />
          <button className="btn-primary" type="submit" disabled={createMut.pending || !newListName.trim()} aria-label="Add price list">
            <Plus size={15} />
          </button>
        </form>
      </div>

      {selectedList && (
        <div className="card" style={{ marginBottom: '1.25rem' }}>
          <h3 style={{ marginBottom: '1rem' }}>Prices — {lists.find(l => l.id === selectedList)?.name}</h3>
          {goodsQ.loading ? <Loading /> : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#64748b' }}>
                    <th style={{ padding: '0.4rem 0' }}>Product</th><th>Selling Price</th><th>Price on this list</th>
                  </tr>
                </thead>
                <tbody>
                  {(goodsQ.data ?? []).map(g => (
                    <PriceRow key={g.id} good={g} priceListId={selectedList}
                              current={itemsQ.data?.find(i => i.price_list_id === selectedList && i.finished_good_id === g.id && i.min_qty === 1)?.price ?? null}
                              onSaved={() => itemsQ.refetch()} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <h3 style={{ marginBottom: '0.25rem' }}>Customer Types</h3>
        <p style={{ color: '#64748b', fontSize: '0.82rem', marginBottom: '1rem' }}>
          Everyone in a customer type gets that list's prices, unless the customer has their own list set on their own record.
        </p>
        {(typesQ.data ?? []).length === 0 ? (
          <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No customer types yet — add some under Settings → Types.</p>
        ) : (
          <div style={{ display: 'grid', gap: '0.6rem' }}>
            {(typesQ.data ?? []).map(t => (
              <div key={t.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
                <span style={{ fontSize: '0.88rem' }}>{t.name}</span>
                <select value={t.price_list_id ?? ''} onChange={e => setTypeList(t.id, e.target.value)} style={{ maxWidth: 220 }}>
                  <option value="">Default list</option>
                  {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>

      <ApprovalPinCard />

      {deleteList && (
        <ConfirmDialog
          title="Remove Price List"
          message={<>Remove <strong>{deleteList.name}</strong>? Customers or customer types using it will fall back to the default list.</>}
          confirmLabel="Remove"
          pending={removeMut.pending}
          onConfirm={confirmDeleteList}
          onCancel={() => setDeleteListState(null)}
        />
      )}
    </div>
  );
}

function PriceRow({ good, priceListId, current, onSaved }: {
  good: FinishedGood; priceListId: string; current: number | null; onSaved: () => void;
}) {
  const toast = useToast();
  const [value, setValue] = useState(current ?? 0);
  const [dirty, setDirty] = useState(false);
  const saveMut = useMutation(pricing.setPrice);
  const clearMut = useMutation(pricing.clearPrice);

  useEffect(() => { if (!dirty) setValue(current ?? 0); }, [current, dirty]);

  const commit = async () => {
    if (!dirty) return;
    setDirty(false);
    if (value <= 0) {
      if (current === null) return;
      const res = await clearMut.mutate(priceListId, good.id);
      if (res !== null) onSaved(); else toast.error(clearMut.error ?? 'Could not clear that price.');
      return;
    }
    if (value === current) return;
    const res = await saveMut.mutate(priceListId, good.id, value);
    if (res !== null) onSaved(); else toast.error(saveMut.error ?? 'Could not save that price.');
  };

  return (
    <tr style={{ borderTop: '1px solid #f1f5f9' }}>
      <td style={{ padding: '0.4rem 0' }}>{good.name}</td>
      <td style={{ color: '#94a3b8' }}>₦{good.selling_price.toLocaleString()}</td>
      <td style={{ maxWidth: 140 }}>
        <NumberInput value={value} onChange={v => { setValue(v); setDirty(true); }}
                     onBlur={commit} placeholder="Same as selling price" />
      </td>
    </tr>
  );
}

function ApprovalPinCard() {
  const toast = useToast();
  const hasPinQ = useQuery<boolean>(() => pricing.hasApprovalPin(), []);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const saveMut = useMutation(pricing.setApprovalPin);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[0-9]{4,6}$/.test(pin)) { toast.error('Use a 4 to 6 digit PIN.'); return; }
    if (pin !== pin2) { toast.error("The two PINs don't match."); return; }
    const res = await saveMut.mutate(pin);
    if (res !== null) { toast.success('Your approval PIN is set.'); setPin(''); setPin2(''); hasPinQ.refetch(); }
    else toast.error(saveMut.error ?? 'Could not set the PIN.');
  };

  return (
    <div className="card">
      <h3 style={{ marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: 8 }}><Lock size={16} /> Your Approval PIN</h3>
      <p style={{ color: '#64748b', fontSize: '0.82rem', marginBottom: '1rem' }}>
        When a cashier tries to give a discount above their limit, they'll ask you for this PIN.
        {hasPinQ.data && ' A PIN is already set — saving a new one replaces it.'}
      </p>
      <form onSubmit={submit} className="grid-2" style={{ maxWidth: 400 }}>
        <div className="form-group">
          <label>New PIN (4–6 digits)</label>
          <input type="password" inputMode="numeric" maxLength={6} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="form-group">
          <label>Confirm PIN</label>
          <input type="password" inputMode="numeric" maxLength={6} value={pin2} onChange={e => setPin2(e.target.value.replace(/\D/g, ''))} />
        </div>
        <button className="btn-primary" type="submit" disabled={saveMut.pending} style={{ gridColumn: '1 / -1', justifySelf: 'start' }}>
          {saveMut.pending ? 'Saving…' : 'Set PIN'}
        </button>
      </form>
    </div>
  );
}

// ============================================================
// CUSTOM FIELDS (migration 0032, Phase 6e)
// ============================================================
const ENTITY_LABEL: Record<CustomFieldEntity, string> = {
  customer: 'Customers', supplier: 'Suppliers', finished_good: 'Finished Goods', material: 'Materials', sale: 'Sales',
};
const ENTITY_ORDER: CustomFieldEntity[] = ['customer', 'supplier', 'finished_good', 'material', 'sale'];

function CustomFieldsTab() {
  const toast = useToast();
  const { tenant } = useAuth();
  const enabled = hasFeature(tenant?.plan, 'custom_fields');
  const { data: defs, loading, refetch } = useQuery<CustomFieldDef[]>(() => customFieldDefs.list(), []);
  const createMut = useMutation(customFieldDefs.create);
  const removeMut = useMutation(customFieldDefs.remove);

  const [entity, setEntity] = useState<CustomFieldEntity>('customer');
  const [key, setKey] = useState('');
  const [label, setLabel] = useState('');
  const [type, setType] = useState<CustomFieldDef['type']>('text');
  const [options, setOptions] = useState('');
  const [required, setRequired] = useState(false);
  const [showOnInvoice, setShowOnInvoice] = useState(false);
  const [deleteDef, setDeleteDef] = useState<CustomFieldDef | null>(null);

  const resetForm = () => { setEntity('customer'); setKey(''); setLabel(''); setType('text'); setOptions(''); setRequired(false); setShowOnInvoice(false); };

  const addField = async (e: React.FormEvent) => {
    e.preventDefault();
    const slug = key.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^[^a-z]+/, '');
    if (!slug || !label.trim()) { toast.error('Enter a key and a label.'); return; }
    if (type === 'select' && !options.trim()) { toast.error('List at least one option, separated by commas.'); return; }
    const res = await createMut.mutate({
      entity, key: slug, label: label.trim(), type,
      options: type === 'select' ? options.split(',').map(o => o.trim()).filter(Boolean) : null,
      required, show_on_invoice: entity === 'sale' ? showOnInvoice : false,
    });
    if (res) { toast.success(`${res.label} added.`); resetForm(); refetch(); }
    else toast.error(createMut.error ?? 'Could not add that field — is the key already used on this entity?');
  };

  const confirmDelete = async () => {
    if (!deleteDef) return;
    const res = await removeMut.mutate(deleteDef.id);
    if (res !== null) { toast.success(`${deleteDef.label} removed.`); refetch(); }
    else toast.error(removeMut.error ?? 'Could not remove it.');
    setDeleteDef(null);
  };

  if (!enabled) {
    return (
      <div className="card" style={{ maxWidth: 520, textAlign: 'center', padding: '2.5rem 1.5rem' }}>
        <ListPlus size={26} color="#2563eb" style={{ marginBottom: '0.5rem' }} />
        <h3 style={{ marginBottom: '0.35rem' }}>Custom fields</h3>
        <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
          Track things StockFlow doesn't have a column for — a CAC number, a shelf position, a delivery
          reference — on customers, suppliers, products and sales, on the {planFor('custom_fields')} plan and above.
        </p>
      </div>
    );
  }

  return (
    <div>
      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <h3 style={{ marginBottom: '0.25rem' }}>Add a Custom Field</h3>
        <p style={{ color: '#64748b', fontSize: '0.82rem', marginBottom: '1rem' }}>
          It appears on that entity's form right away. "Show on invoice" only applies to a sale field.
        </p>
        <form onSubmit={addField}>
          <div className="grid-2">
            <div className="form-group">
              <label>Applies to</label>
              <select value={entity} onChange={e => setEntity(e.target.value as CustomFieldEntity)}>
                {ENTITY_ORDER.map(en => <option key={en} value={en}>{ENTITY_LABEL[en]}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Label</label>
              <input value={label} onChange={e => setLabel(e.target.value)} placeholder="e.g. CAC Number" />
            </div>
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label>Key</label>
              <input value={key} onChange={e => setKey(e.target.value)} placeholder="e.g. cac_number" />
              <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Lowercase, no spaces — used internally.</small>
            </div>
            <div className="form-group">
              <label>Type</label>
              <select value={type} onChange={e => setType(e.target.value as CustomFieldDef['type'])}>
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="date">Date</option>
                <option value="select">Select (choose one)</option>
              </select>
            </div>
          </div>
          {type === 'select' && (
            <div className="form-group">
              <label>Options (comma-separated)</label>
              <input value={options} onChange={e => setOptions(e.target.value)} placeholder="e.g. Bronze, Silver, Gold" />
            </div>
          )}
          <div style={{ display: 'flex', gap: '1.5rem', marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', cursor: 'pointer' }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={required} onChange={e => setRequired(e.target.checked)} />
              Required{entity === 'sale' ? ' (only checked when filled in from the sale detail screen)' : ''}
            </label>
            {entity === 'sale' && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '0.85rem', cursor: 'pointer' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={showOnInvoice} onChange={e => setShowOnInvoice(e.target.checked)} />
                Show on invoice
              </label>
            )}
          </div>
          <button className="btn-primary" type="submit" disabled={createMut.pending}>
            <Plus size={15} /> Add Field
          </button>
        </form>
      </div>

      {loading ? <Loading /> : ENTITY_ORDER.map(en => {
        const rows = (defs ?? []).filter(d => d.entity === en);
        if (rows.length === 0) return null;
        return (
          <div className="card" key={en} style={{ marginBottom: '1.25rem' }}>
            <h3 style={{ marginBottom: '0.75rem' }}>{ENTITY_LABEL[en]}</h3>
            <div className="lookup-list">
              {rows.map(d => (
                <div key={d.id} className="lookup-row">
                  <span style={{ flex: 1 }}>
                    <strong>{d.label}</strong>
                    <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}> · {d.key} · {d.type}{d.required ? ' · required' : ''}{d.show_on_invoice ? ' · on invoice' : ''}</span>
                    {d.type === 'select' && d.options && (
                      <span style={{ color: '#94a3b8', fontSize: '0.78rem' }}> ({d.options.join(', ')})</span>
                    )}
                  </span>
                  <div className="lookup-row-actions">
                    <button className="lookup-action danger" onClick={() => setDeleteDef(d)} title="Remove" aria-label={`Remove ${d.label}`}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {(defs ?? []).length === 0 && !loading && (
        <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>No custom fields yet — add your first one above.</p>
      )}

      {deleteDef && (
        <ConfirmDialog
          title="Remove Custom Field"
          message={<>Remove <strong>{deleteDef.label}</strong>? Values already saved under this key are cleared from every record, and the field disappears from every form.</>}
          confirmLabel="Remove"
          pending={removeMut.pending}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteDef(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// E-INVOICING (NRS) READINESS (migration 0035, Phase 7c)
// ============================================================
function EinvoicingTab() {
  const { tenant } = useAuth();
  const enabled = hasFeature(tenant?.plan, 'einvoicing');
  const { data, loading, error, refetch } = useQuery<EinvoiceReadiness>(() => compliance.einvoiceReadiness(), []);

  if (!enabled) {
    return (
      <div className="card" style={{ maxWidth: 520, textAlign: 'center', padding: '2.5rem 1.5rem' }}>
        <ShieldCheck size={26} color="#2563eb" style={{ marginBottom: '0.5rem' }} />
        <h3 style={{ marginBottom: '0.35rem' }}>E-invoicing readiness</h3>
        <p style={{ color: '#64748b', fontSize: '0.875rem' }}>
          See exactly what master data Nigeria's e-invoicing (NRS) rollout will want, well before the deadline —
          on the {planFor('einvoicing')} plan and above.
        </p>
      </div>
    );
  }

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!data) return null;

  const pct = data.overall_percent;
  const pctColor = pct >= 80 ? '#16a34a' : pct >= 40 ? '#d97706' : '#dc2626';
  const Row = ({ ok, label }: { ok: boolean; label: string }) => (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: '0.88rem', padding: '0.3rem 0' }}>
      {ok ? <Check size={15} color="#16a34a" /> : <X size={15} color="#dc2626" />}
      <span style={{ color: ok ? '#1e293b' : '#64748b' }}>{label}</span>
    </div>
  );

  return (
    <div className="grid-2" style={{ alignItems: 'start' }}>
      <div className="card">
        <h3 style={{ marginBottom: '0.25rem' }}>Readiness Score</h3>
        <p style={{ color: '#64748b', fontSize: '0.82rem', marginBottom: '1rem' }}>
          Nigeria's e-invoicing mandate isn't enforced yet — businesses over ₦1–5bn turnover from January 2027,
          everyone else (most StockFlow customers) live July 2027, enforced January 2028. It needs an accredited
          access-point provider, which StockFlow hasn't connected yet — this score covers only the master data
          you can get ready today.
        </p>
        <div style={{ fontSize: '2.5rem', fontWeight: 800, color: pctColor, lineHeight: 1 }}>{pct}%</div>
        <div style={{ height: 8, background: '#f1f5f9', borderRadius: 4, marginTop: '0.5rem', marginBottom: '1.25rem', overflow: 'hidden' }}>
          <div style={{ width: `${pct}%`, height: '100%', background: pctColor, borderRadius: 4 }} />
        </div>

        <p style={{ fontSize: '0.8rem', fontWeight: 600, color: '#475569', marginBottom: '0.25rem' }}>Business</p>
        <Row ok={data.business.tin} label="TIN on file" />
        <Row ok={data.business.rc_number} label="RC (CAC) number on file" />
        <Row ok={data.business.address} label="Business address on file" />
        <small style={{ color: '#94a3b8', fontSize: '0.72rem', display: 'block', marginTop: '0.35rem' }}>
          Fill these in under Settings → Business & Profile → Tax & compliance.
        </small>

        <hr className="divider" />
        <p style={{ fontSize: '0.8rem', fontWeight: 600, color: '#475569', marginBottom: '0.25rem' }}>Products</p>
        <p style={{ fontSize: '0.88rem' }}>
          <strong>{data.products.ready}</strong> of <strong>{data.products.total}</strong> products have a tax
          category and classification code.
        </p>
        <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Add these under Finished Goods → Edit for each product.</small>

        <hr className="divider" />
        <p style={{ fontSize: '0.8rem', fontWeight: 600, color: '#475569', marginBottom: '0.25rem' }}>B2B Customers</p>
        <p style={{ fontSize: '0.88rem' }}>
          <strong>{data.customers_b2b.ready}</strong> of <strong>{data.customers_b2b.total}</strong> B2B customers have a TIN on file.
        </p>
        <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Mark a customer B2B and add their TIN under Customers → Edit.</small>
      </div>

      <div className="card">
        <h3 style={{ marginBottom: '0.5rem' }}>When you're ready to connect a provider</h3>
        <p style={{ color: '#64748b', fontSize: '0.85rem' }}>
          Invoices go through an accredited access-point provider, which returns a reference number (IRN) and a QR
          code for the invoice. StockFlow hasn't partnered with one yet — that's a business decision for you, not
          something we can pick on your behalf. Once you have, we build the adapter against their field
          specification (it has changed before, so get the current one directly from them).
        </p>
        <p style={{ color: '#64748b', fontSize: '0.85rem', marginTop: '0.75rem' }}>
          Everything else is already in place for that day: sequential invoice numbers, credit notes as their own
          linked documents rather than edits, and an issued invoice's value can no longer change once it's created
          — corrections only ever happen through a return or credit note.
        </p>
      </div>
    </div>
  );
}
