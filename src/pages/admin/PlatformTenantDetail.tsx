import React, { useEffect, useState } from 'react';
import { useParams, Link, useNavigate, useLocation } from 'react-router-dom';
import { ArrowLeft, Ban, RotateCcw, CalendarClock, RefreshCw, Store, UserX, UserCheck, Mail, XCircle, Plus, KeyRound, MessageSquarePlus, X, Eye } from 'lucide-react';
import {
  platform, PlatformTenantDetail as TenantDetailShape, PlatformTenantNote, PlatformTenantInvite, PLANS,
  PlatformSnapshot, SupportTicket, SUPPORT_CATEGORIES, SupportCategory,
} from '../../lib/api';
import { ago } from '../../components/SupportConversation';
import '../Support.scss';
import { useQuery, useMutation } from '../../lib/hooks';
import { useToast } from '../../lib/ToastContext';
import { Loading, ErrorState, Empty } from '../../components/DataStates';
import Modal from '../../components/Modal';
import ConfirmDialog from '../../components/ConfirmDialog';
import PlatformGate from '../../components/PlatformGate';
import DataTable, { Column, RowAction } from '../../components/DataTable';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString();
const fmtDate = (d: string | null) => d ? new Date(d).toLocaleDateString('en-GB') : '—';

function formatMeta(meta: Record<string, any> | null): string {
  if (!meta || Object.keys(meta).length === 0) return '—';
  return Object.entries(meta).map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
}

export default function PlatformTenantDetail() {
  return <PlatformGate><TenantDetailPanel /></PlatformGate>;
}

function TenantDetailPanel() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { data, loading, error, refetch } = useQuery<TenantDetailShape>(() => platform.tenantDetail(id!), [id]);
  const snapQ = useQuery<PlatformSnapshot>(() => platform.snapshot(id!), [id]);
  const ticketsQ = useQuery<SupportTicket[]>(() => platform.tickets(undefined, id!), [id]);
  const [messaging, setMessaging] = useState(false);
  const [diagTab, setDiagTab] = useState<'stock' | 'sales' | 'purchases' | 'activity'>('stock');

  // "See which" on a ticket links here as #diagnostics: land on it, once
  // both the page and the diagnostics have rendered (the page shows a
  // spinner until the tenant itself loads, so the card isn't there yet).
  useEffect(() => {
    if (location.hash !== '#diagnostics' || !snapQ.data || !data) return;
    const t = window.setTimeout(() =>
      document.getElementById('diagnostics')?.scrollIntoView({ block: 'start' }), 50);
    return () => window.clearTimeout(t);
  }, [location.hash, snapQ.data, data]);
  const notesQ = useQuery<PlatformTenantNote[]>(() => platform.tenantNotes(id!), [id]);
  const invitesQ = useQuery<PlatformTenantInvite[]>(() => platform.tenantInvites(id!), [id]);

  const activeMut = useMutation((tenantId: string, on: boolean) => platform.setActive(tenantId, on));
  const extendMut = useMutation((tenantId: string, days: number) => platform.extendTrial(tenantId, days));
  const changePlanMut = useMutation((tenantId: string, plan: string, expiresAt?: string) => platform.changePlan(tenantId, plan, expiresAt));
  const changeBizTypeMut = useMutation((tenantId: string, businessType: 'retail' | 'manufacturing') => platform.changeBusinessType(tenantId, businessType));
  const profileActiveMut = useMutation((profileId: string, on: boolean) => platform.setProfileActive(profileId, on));
  const resendMut = useMutation((email: string) => platform.resendConfirmation(email));
  const cancelInviteMut = useMutation((inviteId: string) => platform.cancelInvite(inviteId));
  const addNoteMut = useMutation((tenantId: string, body: string) => platform.addTenantNote(tenantId, body));
  const impersonateMut = useMutation((profileId: string) => platform.impersonate(profileId));

  const [confirmingSuspend, setConfirmingSuspend] = useState(false);
  const [extending, setExtending] = useState(false);
  const [extendDays, setExtendDays] = useState(7);
  const [changingPlan, setChangingPlan] = useState(false);
  const [newPlan, setNewPlan] = useState('starter');
  const [newExpiry, setNewExpiry] = useState('');
  const [changingBizType, setChangingBizType] = useState(false);
  const [newBizType, setNewBizType] = useState<'retail' | 'manufacturing'>('manufacturing');
  const [confirmingProfile, setConfirmingProfile] = useState<{ id: string; name: string; active: boolean } | null>(null);
  const [viewAsTarget, setViewAsTarget] = useState<{ id: string; name: string } | null>(null);
  const [confirmingCancelInvite, setConfirmingCancelInvite] = useState<PlatformTenantInvite | null>(null);
  const [noteText, setNoteText] = useState('');

  if (loading) return <Loading label="Loading tenant…" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!data) return null;

  const t = data.tenant;

  const doToggleActive = async () => {
    const res = await activeMut.mutate(t.id, !t.is_active);
    if (res !== null) { toast.success(`${t.name} ${t.is_active ? 'suspended' : 'reactivated'}.`); refetch(); }
    else toast.error(activeMut.error ?? 'Failed.');
    setConfirmingSuspend(false);
  };

  const doExtend = async () => {
    const res = await extendMut.mutate(t.id, extendDays);
    if (res !== null) { toast.success(`Trial extended by ${extendDays} days.`); refetch(); }
    else toast.error(extendMut.error ?? 'Failed.');
    setExtending(false);
  };

  const doChangePlan = async () => {
    const res = await changePlanMut.mutate(t.id, newPlan, newExpiry ? new Date(newExpiry).toISOString() : undefined);
    if (res !== null) { toast.success(`Plan changed to ${newPlan}.`); refetch(); }
    else toast.error(changePlanMut.error ?? 'Failed.');
    setChangingPlan(false);
  };

  const doChangeBizType = async () => {
    const res = await changeBizTypeMut.mutate(t.id, newBizType);
    if (res !== null) { toast.success(`Business type changed to ${newBizType}.`); refetch(); }
    else toast.error(changeBizTypeMut.error ?? 'Failed.');
    setChangingBizType(false);
  };

  const doToggleProfile = async () => {
    if (!confirmingProfile) return;
    const res = await profileActiveMut.mutate(confirmingProfile.id, !confirmingProfile.active);
    if (res !== null) { toast.success(`${confirmingProfile.name} ${confirmingProfile.active ? 'deactivated' : 'reactivated'}.`); refetch(); }
    else toast.error(profileActiveMut.error ?? 'Failed.');
    setConfirmingProfile(null);
  };

  const doResend = async (email: string) => {
    const res = await resendMut.mutate(email);
    if (res !== null) { toast.success(`Confirmation email resent to ${email}.`); platform.logConfirmationResent(t.id, email); }
    else toast.error(resendMut.error ?? 'Could not resend the email.');
  };

  const doReset = async (email: string) => {
    try {
      await platform.sendPasswordReset(t.id, email);
      toast.success(`Password reset link sent to ${email}.`);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not send the reset link.');
    }
  };

  // Sign-in state lives in auth.users, which only the snapshot reads.
  const signIn = new Map((snapQ.data?.users ?? []).map(u => [u.id, u]));

  const doCancelInvite = async () => {
    if (!confirmingCancelInvite) return;
    const res = await cancelInviteMut.mutate(confirmingCancelInvite.id);
    if (res !== null) { toast.success(`Invite to ${confirmingCancelInvite.email} cancelled.`); invitesQ.refetch(); }
    else toast.error(cancelInviteMut.error ?? 'Failed.');
    setConfirmingCancelInvite(null);
  };

  const confirmViewAs = async () => {
    if (!viewAsTarget) return;
    const res = await impersonateMut.mutate(viewAsTarget.id);
    setViewAsTarget(null);
    if (res) {
      window.open(res.url, '_blank', 'noopener');
      toast.success(`Opened a new tab signed in as ${res.viewedAs}. Logged on ${t.name}'s own Audit Log.`);
    } else {
      toast.error(impersonateMut.error ?? 'Could not create a sign-in link.');
    }
  };

  const doAddNote = async () => {
    if (!noteText.trim()) return;
    const res = await addNoteMut.mutate(t.id, noteText.trim());
    if (res !== null) { setNoteText(''); notesQ.refetch(); }
    else toast.error(addNoteMut.error ?? 'Could not save the note.');
  };

  const teamColumns: Column<any>[] = [
    { key: 'full_name', header: 'Name', value: p => p.full_name || '' , render: p => p.full_name || 'Unnamed' },
    { key: 'email', header: 'Email', value: p => p.email || '' },
    { key: 'role', header: 'Role', value: p => p.role, render: p => <span style={{ textTransform: 'capitalize' }}>{p.role}</span> },
    { key: 'is_active', header: 'Status', value: p => p.is_active ? 'Active' : 'Inactive',
      render: p => p.is_active ? <span className="badge-success">Active</span> : <span className="badge-gray">Inactive</span> },
    { key: 'confirmed', header: 'Email confirmed', value: p => signIn.get(p.id)?.email_confirmed_at ? 'Yes' : 'No',
      render: p => !snapQ.data ? '' : signIn.get(p.id)?.email_confirmed_at
        ? <span className="badge-success">Yes</span> : <span className="badge-warning">Not yet</span> },
    { key: 'last_sign_in', header: 'Last sign-in', value: p => signIn.get(p.id)?.last_sign_in_at ?? '',
      render: p => !snapQ.data ? '' : signIn.get(p.id)?.last_sign_in_at ? ago(signIn.get(p.id)!.last_sign_in_at) : 'Never' },
  ];
  const teamRowActions: RowAction<any>[] = [
    { icon: <Eye size={15} />, label: 'View as this team member', show: p => p.is_active && !!p.email,
      onClick: p => setViewAsTarget({ id: p.id, name: p.full_name || p.email || 'this user' }) },
    { icon: <KeyRound size={15} />, label: 'Send password reset', show: p => !!p.email, onClick: p => doReset(p.email) },
    { icon: <Mail size={15} />, label: 'Resend confirmation email', show: p => !!p.email && !signIn.get(p.id)?.email_confirmed_at, onClick: p => doResend(p.email) },
    { icon: <UserX size={15} />, label: 'Deactivate this team member', show: p => p.is_active,
      onClick: p => setConfirmingProfile({ id: p.id, name: p.full_name || p.email || 'this user', active: true }), variant: 'danger' },
    { icon: <UserCheck size={15} />, label: 'Reactivate this team member', show: p => !p.is_active,
      onClick: p => setConfirmingProfile({ id: p.id, name: p.full_name || p.email || 'this user', active: false }) },
  ];

  const inviteColumns: Column<PlatformTenantInvite>[] = [
    { key: 'email', header: 'Email', value: i => i.email },
    { key: 'role', header: 'Role', value: i => i.role, render: i => <span style={{ textTransform: 'capitalize' }}>{i.role}</span> },
    { key: 'created_at', header: 'Sent', value: i => i.created_at, render: i => fmtDate(i.created_at) },
  ];
  const inviteRowActions: RowAction<PlatformTenantInvite>[] = [
    { icon: <XCircle size={15} />, label: 'Cancel invite', onClick: i => setConfirmingCancelInvite(i), variant: 'danger' },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <Link to="/platform/tenants" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8rem', color: '#64748b', textDecoration: 'none', marginBottom: 6 }}>
            <ArrowLeft size={14} /> Back to tenants
          </Link>
          <h1>{t.name}</h1>
          <p>Joined {fmtDate(t.created_at)} · {t.currency} · {t.country}</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button className="btn-primary btn-sm" onClick={() => setMessaging(true)}><MessageSquarePlus size={14} /> Message Business</button>
          <button className="btn-secondary btn-sm" onClick={() => setExtending(true)}><CalendarClock size={14} /> Extend Trial</button>
          <button className="btn-secondary btn-sm" onClick={() => setChangingPlan(true)}><RefreshCw size={14} /> Change Plan</button>
          <button className="btn-secondary btn-sm" onClick={() => { setNewBizType(t.business_type === 'retail' ? 'retail' : 'manufacturing'); setChangingBizType(true); }}><Store size={14} /> Change Business Type</button>
          {t.is_active
            ? <button className="btn-danger btn-sm" onClick={() => setConfirmingSuspend(true)}><Ban size={14} /> Suspend</button>
            : <button className="btn-primary btn-sm" onClick={() => setConfirmingSuspend(true)}><RotateCcw size={14} /> Reactivate</button>}
        </div>
      </div>

      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-label">Plan</div>
          <div className="stat-value" style={{ textTransform: 'capitalize' }}>{t.plan}</div>
          <div className="stat-sub">Expires {fmtDate(t.plan_expires_at)}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Business Type</div>
          <div className="stat-value" style={{ textTransform: 'capitalize' }}>{t.business_type ?? 'manufacturing'}</div>
          <div className="stat-sub">Set at signup, changeable here only</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Status</div>
          <div className="stat-value">{t.is_active ? <span className="badge-success">Active</span> : <span className="badge-danger">Suspended</span>}</div>
          {t.plan === 'trial' && <div className="stat-sub">Trial ends {fmtDate(t.trial_ends_at)}</div>}
        </div>
        <div className="stat-card">
          <div className="stat-label">Team</div>
          <div className="stat-value">{data.profiles.length}</div>
          <div className="stat-sub">{data.branches.length} branch{data.branches.length !== 1 ? 'es' : ''}</div>
        </div>
      </div>

      {snapQ.data && !snapQ.data.access.can_write && (
        <div className={`sp-alert ${snapQ.data.access.reason === 'suspended' ? 'is-bad' : 'is-warn'}`} style={{ marginTop: '1rem' }}>
          <span>
            <strong>They can't save anything right now.</strong>{' '}
            {snapQ.data.access.reason === 'suspended' ? 'The business is suspended, so nobody on the team can sign in.'
              : snapQ.data.access.reason === 'trial_expired' ? 'Their trial has ended. Extend it, or change their plan, to let them save again.'
              : 'Their plan has expired. Change their plan to let them save again.'}
          </span>
        </div>
      )}

      <SupportTicketsCard tickets={ticketsQ.data} loading={ticketsQ.loading} onNew={() => setMessaging(true)} />

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h3 style={{ marginBottom: '1rem' }}>Team</h3>
        {data.profiles.length === 0 ? <Empty message="No team members." /> : (
          <DataTable
            columns={teamColumns}
            rows={data.profiles}
            getRowKey={(p: any) => p.id}
            rowActions={teamRowActions}
            pageSize={50}
          />
        )}
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h3 style={{ marginBottom: '1rem' }}>Pending Invites</h3>
        {invitesQ.loading ? <Loading label="Loading invites…" /> : (invitesQ.data ?? []).length === 0 ? (
          <Empty message="No pending invites." />
        ) : (
          <DataTable
            columns={inviteColumns}
            rows={invitesQ.data ?? []}
            getRowKey={i => i.id}
            rowActions={inviteRowActions}
            pageSize={50}
          />
        )}
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h3 style={{ marginBottom: '1rem' }}>Payment History</h3>
        {data.payments.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No payments recorded.</p> : (
          <div className="table-wrapper">
            <table>
              <thead><tr><th>Date</th><th>Plan</th><th>Amount</th><th>Status</th><th>Reference</th></tr></thead>
              <tbody>
                {data.payments.map((p: any) => (
                  <tr key={p.id}>
                    <td data-label="Date">{fmtDate(p.created_at)}</td>
                    <td data-label="Plan" style={{ textTransform: 'capitalize' }}>{p.plan}</td>
                    <td data-label="Amount">{fmt(p.amount)}</td>
                    <td data-label="Status"><span className="badge-success">{p.status}</span></td>
                    <td data-label="Reference" style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{p.paystack_sub_code || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <DiagnosticsCard snap={snapQ.data} loading={snapQ.loading} error={snapQ.error} onRetry={snapQ.refetch} tab={diagTab} setTab={setDiagTab} />

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h3 style={{ marginBottom: '1rem' }}>Admin Notes</h3>
        <p style={{ color: '#94a3b8', fontSize: '0.78rem', marginTop: '-0.5rem', marginBottom: '0.75rem' }}>
          Private to platform admins. The tenant never sees these.
        </p>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
          <input value={noteText} onChange={e => setNoteText(e.target.value)} placeholder="e.g. Promised a refund on 20/09, follow up next week"
            style={{ flex: 1 }} onKeyDown={e => { if (e.key === 'Enter') doAddNote(); }} />
          <button className="btn-primary btn-sm" onClick={doAddNote} disabled={addNoteMut.pending || !noteText.trim()}>
            <Plus size={14} /> Add
          </button>
        </div>
        {notesQ.loading && <Loading label="Loading notes…" />}
        {!notesQ.loading && (notesQ.data ?? []).length === 0 ? (
          <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No notes yet.</p>
        ) : !notesQ.loading && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {(notesQ.data ?? []).map(n => (
              <div key={n.id} style={{ borderLeft: '3px solid #e2e8f0', paddingLeft: '0.75rem' }}>
                <div style={{ fontSize: '0.875rem' }}>{n.body}</div>
                <div style={{ fontSize: '0.72rem', color: '#94a3b8', marginTop: 2 }}>{new Date(n.created_at).toLocaleString()}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: '1.5rem' }}>
        <h3 style={{ marginBottom: '1rem' }}>Admin Activity</h3>
        <p style={{ color: '#94a3b8', fontSize: '0.78rem', marginTop: '-0.5rem', marginBottom: '0.75rem' }}>
          Actions taken on this tenant from the platform admin panel. For the tenant's own full history, see their Audit Log.
        </p>
        {data.recent_activity.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No admin action taken on this tenant yet.</p> : (
          <div className="table-wrapper">
            <table>
              <thead><tr><th>Date</th><th>Action</th><th>Details</th></tr></thead>
              <tbody>
                {data.recent_activity.map((a: any) => (
                  <tr key={a.id}>
                    <td data-label="Date" style={{ whiteSpace: 'nowrap' }}>{new Date(a.created_at).toLocaleString()}</td>
                    <td data-label="Action"><span className="badge-gray">{a.action.replace(/_/g, ' ')}</span></td>
                    <td data-label="Details" style={{ fontSize: '0.8rem', color: '#64748b' }}>{formatMeta(a.meta)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {confirmingSuspend && (
        <ConfirmDialog
          title={t.is_active ? 'Suspend Tenant' : 'Reactivate Tenant'}
          message={t.is_active
            ? <>Suspend <strong>{t.name}</strong>? Their team will be locked out immediately.</>
            : <>Reactivate <strong>{t.name}</strong>? They'll regain access immediately.</>}
          confirmLabel={t.is_active ? 'Suspend' : 'Reactivate'}
          pending={activeMut.pending}
          onConfirm={doToggleActive}
          onCancel={() => setConfirmingSuspend(false)}
        />
      )}

      {confirmingProfile && (
        <ConfirmDialog
          title={confirmingProfile.active ? 'Deactivate Team Member' : 'Reactivate Team Member'}
          message={confirmingProfile.active
            ? <>Deactivate <strong>{confirmingProfile.name}</strong>? They'll be locked out of this tenant immediately.</>
            : <>Reactivate <strong>{confirmingProfile.name}</strong>? They'll regain access immediately.</>}
          confirmLabel={confirmingProfile.active ? 'Deactivate' : 'Reactivate'}
          pending={profileActiveMut.pending}
          onConfirm={doToggleProfile}
          onCancel={() => setConfirmingProfile(null)}
        />
      )}

      {viewAsTarget && (
        <ConfirmDialog
          title="View as this team member"
          danger={false}
          message={
            <>
              Opens a new tab signed in as <strong>{viewAsTarget.name}</strong>, so you see exactly what they see.
              Your own tab stays signed in as you. This is recorded on {t.name}'s own Audit Log, visible to them.
            </>
          }
          confirmLabel="Open in a new tab"
          pending={impersonateMut.pending}
          onConfirm={confirmViewAs}
          onCancel={() => setViewAsTarget(null)}
        />
      )}

      {confirmingCancelInvite && (
        <ConfirmDialog
          title="Cancel Invite"
          message={<>Cancel the invite to <strong>{confirmingCancelInvite.email}</strong>? They won't be able to join with that link anymore.</>}
          confirmLabel="Cancel Invite"
          pending={cancelInviteMut.pending}
          onConfirm={doCancelInvite}
          onCancel={() => setConfirmingCancelInvite(null)}
        />
      )}

      {extending && (
        <Modal onClose={() => setExtending(false)} maxWidth={400}>
          <div className="modal-header"><h2>Extend Trial</h2></div>
          <div className="modal-body">
            <div className="form-group">
              <label>Days to add</label>
              <input type="number" min={1} value={extendDays} onChange={e => setExtendDays(Number(e.target.value))} />
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setExtending(false)} disabled={extendMut.pending}>Cancel</button>
            <button className="btn-primary" onClick={doExtend} disabled={extendMut.pending}>{extendMut.pending ? 'Working…' : 'Extend'}</button>
          </div>
        </Modal>
      )}

      {changingPlan && (
        <Modal onClose={() => setChangingPlan(false)} maxWidth={420}>
          <div className="modal-header"><h2>Change Plan</h2></div>
          <div className="modal-body">
            <div className="form-group">
              <label>New plan</label>
              <select value={newPlan} onChange={e => setNewPlan(e.target.value)}>
                {PLANS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Expires on (optional, defaults to 30 days)</label>
              <input type="date" value={newExpiry} onChange={e => setNewExpiry(e.target.value)} />
            </div>
            <p style={{ fontSize: '0.78rem', color: '#64748b' }}>
              Use this for a manual activation, for example after a bank transfer. It won't create a payment record, only a note in the audit log.
            </p>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setChangingPlan(false)} disabled={changePlanMut.pending}>Cancel</button>
            <button className="btn-primary" onClick={doChangePlan} disabled={changePlanMut.pending}>{changePlanMut.pending ? 'Working…' : 'Change Plan'}</button>
          </div>
        </Modal>
      )}

      {messaging && (
        <MessageBusinessModal
          tenantId={t.id}
          tenantName={t.name}
          onClose={() => setMessaging(false)}
          onSent={ticketId => { setMessaging(false); navigate(`/platform/support/${ticketId}`); }}
        />
      )}

      {changingBizType && (
        <Modal onClose={() => setChangingBizType(false)} maxWidth={420}>
          <div className="modal-header"><h2>Change Business Type</h2></div>
          <div className="modal-body">
            <div className="form-group">
              <label>Business type</label>
              <select value={newBizType} onChange={e => setNewBizType(e.target.value as 'retail' | 'manufacturing')}>
                <option value="manufacturing">Manufacturing</option>
                <option value="retail">Retail</option>
              </select>
            </div>
            <p style={{ fontSize: '0.78rem', color: '#64748b' }}>
              This switches the tenant's whole dashboard, nav and vocabulary — set at signup, and changeable only
              here afterwards. Existing stock and sales data is unaffected either way.
            </p>
          </div>
          <div className="modal-footer">
            <button className="btn-secondary" onClick={() => setChangingBizType(false)} disabled={changeBizTypeMut.pending}>Cancel</button>
            <button className="btn-primary" onClick={doChangeBizType} disabled={changeBizTypeMut.pending}>{changeBizTypeMut.pending ? 'Working…' : 'Change Business Type'}</button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ---- Their support conversations ----
function SupportTicketsCard({ tickets, loading, onNew }: { tickets: SupportTicket[] | null; loading: boolean; onNew: () => void }) {
  const list = tickets ?? [];
  return (
    <div className="card" style={{ marginTop: '1.5rem' }}>
      <h3 style={{ marginBottom: '1rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem' }}>
        Support
        <button className="btn-secondary btn-sm" onClick={onNew}><MessageSquarePlus size={14} /> New conversation</button>
      </h3>
      {loading ? <Loading label="Loading tickets…" /> : list.length === 0 ? (
        <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No support conversations with this business yet.</p>
      ) : (
        <div className="sp-links">
          {list.slice(0, 8).map(o => (
            <Link key={o.id} to={`/platform/support/${o.id}`}>
              <strong>{o.subject}</strong>
              <span>
                {o.status.replace('_', ' ')} · {ago(o.last_message_at ?? o.updated_at)}
                {o.awaiting_reply ? ' · waiting on you' : ''}
              </span>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- A read-only look inside the business, to diagnose what's wrong ----
const fmtShort = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtQty = (n: number) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });
const actionLabel = (a: string) => a.replace(/^platform\./, 'Support: ').replace(/[._]/g, ' ');

function DiagnosticsCard({ snap, loading, error, onRetry, tab, setTab }: {
  snap: PlatformSnapshot | null; loading: boolean; error: string | null; onRetry: () => void;
  tab: 'stock' | 'sales' | 'purchases' | 'activity'; setTab: (t: 'stock' | 'sales' | 'purchases' | 'activity') => void;
}) {
  return (
    <div className="card" id="diagnostics" style={{ marginTop: '1.5rem', scrollMarginTop: '80px' }}>
      <h3 style={{ marginBottom: '0.35rem' }}>Diagnostics</h3>
      <p style={{ color: '#94a3b8', fontSize: '0.78rem', marginBottom: '1rem' }}>
        A read-only look at their data, for working out what's wrong. Nothing here can change it.
      </p>
      {loading && <Loading label="Looking inside…" />}
      {error && <ErrorState message={error} onRetry={onRetry} />}
      {snap && (
        <>
          <div className="sp-counts">
            <div><span>Products</span><strong>{snap.counts.products}</strong></div>
            {snap.counts.materials > 0 && <div><span>Materials</span><strong>{snap.counts.materials}</strong></div>}
            <div><span>Sales</span><strong>{snap.counts.sales.toLocaleString()}</strong></div>
            <div><span>Purchases</span><strong>{snap.counts.purchases.toLocaleString()}</strong></div>
            <div><span>Customers</span><strong>{snap.counts.customers}</strong></div>
            <div><span>Last sale</span><strong style={{ fontSize: '0.95rem' }}>{snap.last_sale_at ? ago(snap.last_sale_at) : 'None'}</strong></div>
            <div><span>Last active</span><strong style={{ fontSize: '0.95rem' }}>{snap.last_activity_at ? ago(snap.last_activity_at) : 'Unknown'}</strong></div>
          </div>

          <div className="sp-tabs" role="tablist" aria-label="Diagnostics" style={{ marginBottom: '0.75rem' }}>
            {([
              ['stock', 'Stock checks', snap.stock_issues.length],
              ['sales', 'Recent sales', snap.recent_sales.length],
              ['purchases', 'Recent purchases', snap.recent_purchases.length],
              ['activity', 'Activity log', snap.recent_audit.length],
            ] as const).map(([id, text, n]) => (
              <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'is-on' : ''} onClick={() => setTab(id)}>
                {text} <span className="sp-count">{n}</span>
              </button>
            ))}
          </div>

          {tab === 'stock' && (snap.stock_issues.length === 0 ? (
            <div className="sp-alert is-good"><span>Every product's stock adds up: the figure on record matches its batches and its movement history.</span></div>
          ) : (
            <>
              <div className="sp-alert is-bad">
                <span>
                  <strong>{snap.stock_issues.length} {snap.stock_issues.length === 1 ? 'product doesn\'t' : 'products don\'t'} add up.</strong>{' '}
                  "On record" is the number they see. It should equal what's left in their batches and the sum of every stock movement.
                  A difference usually means an old import or a manual database edit.
                </span>
              </div>
              <div className="sp-scroll">
                <table className="sp-table">
                  <thead><tr><th>Item</th><th className="is-right">On record</th><th className="is-right">In batches</th><th className="is-right">Movement total</th></tr></thead>
                  <tbody>
                    {snap.stock_issues.map(i => (
                      <tr key={i.id}>
                        <td>{i.name}<div className="is-muted" style={{ fontSize: '0.72rem' }}>{i.kind === 'material' ? 'Material' : 'Product'}{i.unit ? ` · ${i.unit}` : ''}</div></td>
                        <td className={`is-right${i.on_record < 0 ? ' is-bad' : ''}`}>{fmtQty(i.on_record)}</td>
                        <td className={`is-right${i.in_batches !== i.on_record ? ' is-bad' : ''}`}>{fmtQty(i.in_batches)}</td>
                        <td className={`is-right${i.in_ledger !== i.on_record ? ' is-bad' : ''}`}>{fmtQty(i.in_ledger)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ))}

          {tab === 'sales' && (snap.recent_sales.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No sales yet.</p> : (
            <div className="sp-scroll">
              <table className="sp-table">
                <thead><tr><th>Invoice</th><th>Date</th><th className="is-right">Total</th><th className="is-right">Owed</th><th>Status</th></tr></thead>
                <tbody>
                  {snap.recent_sales.map(r => (
                    <tr key={r.id} className={r.voided ? 'is-voided' : undefined}>
                      <td>{r.doc_no ?? 'No number'}</td>
                      <td>{fmtShort(r.transaction_date)}</td>
                      <td className="is-right">{fmt(r.total_amount)}</td>
                      <td className="is-right">{fmt(r.balance)}</td>
                      <td>{r.voided ? 'Voided' : r.payment_status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {tab === 'purchases' && (snap.recent_purchases.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No purchases yet.</p> : (
            <div className="sp-scroll">
              <table className="sp-table">
                <thead><tr><th>No.</th><th>Date</th><th className="is-right">Total</th><th className="is-right">They owe</th><th>Status</th></tr></thead>
                <tbody>
                  {snap.recent_purchases.map(r => (
                    <tr key={r.id} className={r.voided ? 'is-voided' : undefined}>
                      <td>{r.doc_no ?? 'No number'}</td>
                      <td>{fmtShort(r.purchase_date)}</td>
                      <td className="is-right">{fmt(r.total_amount)}</td>
                      <td className="is-right">{fmt(r.balance)}</td>
                      <td>{r.voided ? 'Voided' : (r.status ?? 'received')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {tab === 'activity' && (snap.recent_audit.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No activity recorded yet.</p> : (
            <div className="sp-scroll">
              <table className="sp-table">
                <thead><tr><th>When</th><th>Who</th><th>What</th><th>Details</th></tr></thead>
                <tbody>
                  {snap.recent_audit.map(a => (
                    <tr key={a.id}>
                      <td style={{ whiteSpace: 'nowrap' }}>{ago(a.created_at)}</td>
                      <td>{a.actor ?? 'System'}</td>
                      <td style={{ textTransform: 'capitalize' }}>{actionLabel(a.action)}{a.entity ? <span className="is-muted"> · {a.entity.replace(/_/g, ' ')}</span> : null}</td>
                      <td style={{ fontSize: '0.78rem', color: '#64748b' }}>{formatMeta(a.meta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

// ---- Start a conversation with the business ----
function MessageBusinessModal({ tenantId, tenantName, onClose, onSent }: {
  tenantId: string; tenantName: string; onClose: () => void; onSent: (ticketId: string) => void;
}) {
  const toast = useToast();
  const openMut = useMutation((subject: string, category: SupportCategory, body: string) => platform.openTicket(tenantId, subject, category, body));
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<SupportCategory>('account');
  const [body, setBody] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!subject.trim() || !body.trim()) return;
    const id = await openMut.mutate(subject.trim(), category, body.trim());
    if (id) { toast.success(`Sent. ${tenantName} will see it under Support, with a badge until they open it.`); onSent(id); }
    else toast.error(openMut.error ?? 'Could not send the message.');
  };

  return (
    <Modal onClose={onClose} maxWidth={500}>
      <div className="modal-header">
        <h2>Message {tenantName}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          <p style={{ fontSize: '0.85rem', color: '#64748b', marginTop: '-0.25rem', marginBottom: '1rem' }}>
            Starts a support conversation they'll see in the app, the same as one they opened themselves.
          </p>
          <div className="form-group">
            <label htmlFor="mb-subject">Subject</label>
            <input id="mb-subject" value={subject} onChange={e => setSubject(e.target.value)} placeholder="e.g. Your payment didn't go through" required />
          </div>
          <div className="form-group">
            <label htmlFor="mb-category">About</label>
            <select id="mb-category" value={category} onChange={e => setCategory(e.target.value as SupportCategory)}>
              {SUPPORT_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label htmlFor="mb-body">Message</label>
            <textarea id="mb-body" rows={5} value={body} onChange={e => setBody(e.target.value)} required />
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose} disabled={openMut.pending}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={openMut.pending || !subject.trim() || !body.trim()}>
            {openMut.pending ? 'Sending…' : 'Send Message'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
