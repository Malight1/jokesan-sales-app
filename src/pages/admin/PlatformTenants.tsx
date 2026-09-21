import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Ban, RotateCcw, ExternalLink } from 'lucide-react';
import { platform, PlatformTenant } from '../../lib/api';
import { useQuery, useMutation } from '../../lib/hooks';
import { useToast } from '../../lib/ToastContext';
import { Loading, ErrorState, Empty } from '../../components/DataStates';
import DataTable, { Column, RowAction } from '../../components/DataTable';
import ConfirmDialog from '../../components/ConfirmDialog';
import PlatformGate from '../../components/PlatformGate';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString();

export default function PlatformTenants() {
  return <PlatformGate><TenantsPanel /></PlatformGate>;
}

function TenantsPanel() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: rows, loading, error, refetch } = useQuery<PlatformTenant[]>(() => platform.tenants(), []);
  const activeMut = useMutation((id: string, on: boolean) => platform.setActive(id, on));
  const [confirming, setConfirming] = useState<PlatformTenant | null>(null);
  const [planFilter, setPlanFilter] = useState('');

  const toggle = async () => {
    if (!confirming) return;
    const res = await activeMut.mutate(confirming.id, !confirming.is_active);
    if (res !== null) { toast.success(`${confirming.name} ${confirming.is_active ? 'suspended' : 'reactivated'}.`); refetch(); }
    else toast.error(activeMut.error ?? 'Failed.');
    setConfirming(null);
  };

  const filtered = (rows ?? []).filter(t => !planFilter || t.plan === planFilter);
  const plans = Array.from(new Set((rows ?? []).map(t => t.plan))).sort();

  const columns: Column<PlatformTenant>[] = [
    { key: 'name', header: 'Business', value: t => t.name,
      render: t => <Link to={`/platform/tenants/${t.id}`} style={{ fontWeight: 600, color: '#2563eb', textDecoration: 'none' }}>{t.name}</Link> },
    { key: 'plan', header: 'Plan', value: t => t.plan,
      render: t => <span className={t.plan === 'trial' ? 'badge-gray' : 'badge-primary'} style={{ textTransform: 'capitalize' }}>{t.plan}</span> },
    { key: 'users', header: 'Users', align: 'right', value: t => t.users },
    { key: 'sales_count', header: 'Sales', align: 'right', value: t => t.sales_count },
    { key: 'revenue', header: 'GMV', align: 'right', value: t => t.revenue, render: t => fmt(t.revenue) },
    { key: 'created_at', header: 'Joined', value: t => t.created_at, render: t => new Date(t.created_at).toLocaleDateString('en-GB') },
    { key: 'is_active', header: 'Status', value: t => t.is_active ? 'Active' : 'Suspended',
      render: t => t.is_active ? <span className="badge-success">Active</span> : <span className="badge-danger">Suspended</span> },
  ];

  const rowActions: RowAction<PlatformTenant>[] = [
    { icon: <ExternalLink size={15} />, label: 'View details', onClick: t => navigate(`/platform/tenants/${t.id}`) },
    { icon: <Ban size={15} />, label: 'Suspend tenant', onClick: setConfirming, show: t => t.is_active, variant: 'danger' },
    { icon: <RotateCcw size={15} />, label: 'Reactivate tenant', onClick: setConfirming, show: t => !t.is_active },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Tenants</h1><p>Every business on StockFlow</p></div>
      </div>

      {loading && <Loading label="Loading tenants…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}

      {!loading && !error && rows && (
        rows.length === 0 ? <Empty message="No tenants yet." /> : (
          <DataTable
            columns={columns} rows={filtered} getRowKey={t => t.id} rowActions={rowActions}
            searchKeys={[t => t.name]} searchPlaceholder="Search tenants…"
            exportName="tenants" exportTitle="StockFlow Tenants"
            toolbarExtra={
              <select value={planFilter} onChange={e => setPlanFilter(e.target.value)}>
                <option value="">All plans</option>
                {plans.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
              </select>
            }
          />
        )
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
