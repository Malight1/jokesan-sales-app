import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Ban, RotateCcw, CalendarClock, RefreshCw, Store, UserX, UserCheck, Mail, XCircle, Plus } from 'lucide-react';
import { platform, PlatformTenantDetail as TenantDetailShape, PlatformTenantNote, PlatformTenantInvite, PLANS } from '../../lib/api';
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
  const { data, loading, error, refetch } = useQuery<TenantDetailShape>(() => platform.tenantDetail(id!), [id]);
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

  const [confirmingSuspend, setConfirmingSuspend] = useState(false);
  const [extending, setExtending] = useState(false);
  const [extendDays, setExtendDays] = useState(7);
  const [changingPlan, setChangingPlan] = useState(false);
  const [newPlan, setNewPlan] = useState('starter');
  const [newExpiry, setNewExpiry] = useState('');
  const [changingBizType, setChangingBizType] = useState(false);
  const [newBizType, setNewBizType] = useState<'retail' | 'manufacturing'>('manufacturing');
  const [confirmingProfile, setConfirmingProfile] = useState<{ id: string; name: string; active: boolean } | null>(null);
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
    if (res !== null) toast.success(`Confirmation email resent to ${email}.`);
    else toast.error(resendMut.error ?? 'Could not resend the email.');
  };

  const doCancelInvite = async () => {
    if (!confirmingCancelInvite) return;
    const res = await cancelInviteMut.mutate(confirmingCancelInvite.id);
    if (res !== null) { toast.success(`Invite to ${confirmingCancelInvite.email} cancelled.`); invitesQ.refetch(); }
    else toast.error(cancelInviteMut.error ?? 'Failed.');
    setConfirmingCancelInvite(null);
  };

  const doAddNote = async () => {
    if (!noteText.trim()) return;
    const res = await addNoteMut.mutate(t.id, noteText.trim());
    if (res !== null) { setNoteText(''); notesQ.refetch(); }
    else toast.error(addNoteMut.error ?? 'Could not save the note.');
  };

  const teamColumns: Column<any>[] = [
    { key: 'full_name', header: 'Name', value: p => p.full_name || '' , render: p => p.full_name || '—' },
    { key: 'email', header: 'Email', value: p => p.email || '' },
    { key: 'role', header: 'Role', value: p => p.role, render: p => <span style={{ textTransform: 'capitalize' }}>{p.role}</span> },
    { key: 'is_active', header: 'Status', value: p => p.is_active ? 'Active' : 'Inactive',
      render: p => p.is_active ? <span className="badge-success">Active</span> : <span className="badge-gray">Inactive</span> },
  ];
  const teamRowActions: RowAction<any>[] = [
    { icon: <Mail size={15} />, label: 'Resend confirmation email', show: p => !!p.email, onClick: p => doResend(p.email) },
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
        <div style={{ display: 'flex', gap: '0.5rem' }}>
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
