import React, { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Building2, Users, TrendingUp, DollarSign, Ban, RotateCcw } from 'lucide-react';
import { platform, PlatformTenant, PLANS } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState, Empty } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';

const planPrice = (id: string) => PLANS.find(p => p.id === id)?.price ?? 0;

const fmt = (n: number) => '₦' + (n || 0).toLocaleString();

export default function SuperAdmin() {
  const toast = useToast();
  const adminQ = useQuery<boolean>(() => platform.isAdmin(), []);

  if (adminQ.loading) return <Loading label="Checking access…" />;
  if (!adminQ.data) return <Navigate to="/" replace />;

  return <SuperAdminPanel toast={toast} />;
}

function SuperAdminPanel({ toast }: { toast: ReturnType<typeof useToast> }) {
  const { data: rows, loading, error, refetch } = useQuery<PlatformTenant[]>(() => platform.tenants(), []);
  const activeMut = useMutation((id: string, on: boolean) => platform.setActive(id, on));
  const [confirming, setConfirming] = useState<PlatformTenant | null>(null);

  const toggle = async () => {
    if (!confirming) return;
    const res = await activeMut.mutate(confirming.id, !confirming.is_active);
    if (res !== null) { toast.success(`${confirming.name} ${confirming.is_active ? 'suspended' : 'reactivated'}.`); refetch(); }
    else toast.error(activeMut.error ?? 'Failed.');
    setConfirming(null);
  };

  const totals = (rows ?? []).reduce(
    (a, t) => ({
      tenants: a.tenants + 1,
      paying: a.paying + (t.plan !== 'trial' ? 1 : 0),
      users: a.users + t.users,
      revenue: a.revenue + t.revenue,
      mrr: a.mrr + (t.plan !== 'trial' ? planPrice(t.plan) : 0),
    }),
    { tenants: 0, paying: 0, users: 0, revenue: 0, mrr: 0 }
  );

  const columns: Column<PlatformTenant>[] = [
    { key: 'name', header: 'Business', value: t => t.name, render: t => <strong>{t.name}</strong> },
    { key: 'plan', header: 'Plan', value: t => t.plan,
      render: t => <span className={t.plan === 'trial' ? 'badge-gray' : 'badge-primary'} style={{ textTransform: 'capitalize' }}>{t.plan}</span> },
    { key: 'users', header: 'Users', align: 'right', value: t => t.users },
    { key: 'sales_count', header: 'Sales', align: 'right', value: t => t.sales_count },
    { key: 'revenue', header: 'Revenue', align: 'right', value: t => t.revenue, render: t => fmt(t.revenue) },
    { key: 'created_at', header: 'Joined', value: t => t.created_at, render: t => new Date(t.created_at).toLocaleDateString('en-GB') },
    { key: 'is_active', header: 'Status', value: t => t.is_active ? 'Active' : 'Suspended',
      render: t => t.is_active ? <span className="badge-success">Active</span> : <span className="badge-danger">Suspended</span> },
  ];

  const rowActions: RowAction<PlatformTenant>[] = [
    { icon: <Ban size={15} />, label: 'Suspend tenant', onClick: setConfirming, show: t => t.is_active, variant: 'danger' },
    { icon: <RotateCcw size={15} />, label: 'Reactivate tenant', onClick: setConfirming, show: t => !t.is_active },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Platform Admin</h1><p>All StockFlow tenants</p></div>
      </div>

      {loading && <Loading label="Loading tenants…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}

      {!loading && !error && rows && (
        <>
          <div className="stat-cards">
            <div className="stat-card">
              <div className="stat-icon blue"><Building2 size={18} /></div>
              <div className="stat-label">Tenants</div>
              <div className="stat-value">{totals.tenants}</div>
              <div className="stat-sub">{totals.paying} paying · {totals.tenants - totals.paying} trial</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon green"><DollarSign size={18} /></div>
              <div className="stat-label">MRR</div>
              <div className="stat-value">{fmt(totals.mrr)}</div>
              <div className="stat-sub">Monthly recurring revenue</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon yellow"><Users size={18} /></div>
              <div className="stat-label">Total Users</div>
              <div className="stat-value">{totals.users}</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon green"><TrendingUp size={18} /></div>
              <div className="stat-label">Sales Volume Processed</div>
              <div className="stat-value">{fmt(totals.revenue)}</div>
              <div className="stat-sub">Lifetime, all tenants</div>
            </div>
          </div>

          {rows.length === 0
            ? <Empty message="No tenants yet." />
            : <DataTable columns={columns} rows={rows} getRowKey={t => t.id} rowActions={rowActions}
                searchKeys={[t => t.name]} searchPlaceholder="Search tenants…" exportName="tenants" exportTitle="StockFlow Tenants" />}
        </>
      )}

      {confirming && (
        <ConfirmDialog
          title={confirming.is_active ? 'Suspend Tenant' : 'Reactivate Tenant'}
          message={confirming.is_active
            ? <>Suspend <strong>{confirming.name}</strong>? Their team will be locked out immediately.</>
            : <>Reactivate <strong>{confirming.name}</strong>? They'll regain access immediately.</>}
          confirmLabel={confirming.is_active ? 'Suspend' : 'Reactivate'}
          pending={activeMut.pending}
          onConfirm={toggle}
          onCancel={() => setConfirming(null)}
        />
      )}
    </div>
  );
}
