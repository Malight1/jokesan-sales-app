import React from 'react';
import { Link } from 'react-router-dom';
import { Wallet, Calendar, Receipt } from 'lucide-react';
import { platform, PlatformPayment } from '../../lib/api';
import { useQuery } from '../../lib/hooks';
import { Loading, ErrorState, Empty } from '../../components/DataStates';
import DataTable, { Column } from '../../components/DataTable';
import PlatformGate from '../../components/PlatformGate';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString();

export default function PlatformPayments() {
  return <PlatformGate><PaymentsPanel /></PlatformGate>;
}

function PaymentsPanel() {
  const { data: rows, loading, error, refetch } = useQuery<PlatformPayment[]>(() => platform.payments(), []);

  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
  const totals = (rows ?? []).reduce(
    (a, p) => ({
      total: a.total + p.amount,
      thisMonth: a.thisMonth + (new Date(p.created_at) >= startOfMonth ? p.amount : 0),
      count: a.count + 1,
    }),
    { total: 0, thisMonth: 0, count: 0 }
  );

  const columns: Column<PlatformPayment>[] = [
    { key: 'tenant_name', header: 'Business', value: p => p.tenant_name,
      render: p => <Link to={`/platform/tenants/${p.tenant_id}`} style={{ fontWeight: 600, color: '#2563eb', textDecoration: 'none' }}>{p.tenant_name}</Link> },
    { key: 'plan', header: 'Plan', value: p => p.plan,
      render: p => <span className="badge-primary" style={{ textTransform: 'capitalize' }}>{p.plan}</span> },
    { key: 'amount', header: 'Amount', align: 'right', value: p => p.amount, render: p => fmt(p.amount) },
    { key: 'status', header: 'Status', value: p => p.status, render: p => <span className="badge-success">{p.status}</span> },
    { key: 'reference', header: 'Reference', value: p => p.reference ?? '',
      render: p => <span style={{ fontFamily: 'monospace', fontSize: '0.78rem' }}>{p.reference || '—'}</span> },
    { key: 'created_at', header: 'Date', value: p => p.created_at, render: p => new Date(p.created_at).toLocaleDateString('en-GB') },
    { key: 'current_period_end', header: 'Period End', value: p => p.current_period_end ?? '', render: p => p.current_period_end ? new Date(p.current_period_end).toLocaleDateString('en-GB') : '—' },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Payments</h1><p>Who paid, how much, and for which plan</p></div>
      </div>

      {loading && <Loading label="Loading payments…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}

      {!loading && !error && rows && (
        <>
          <div className="stat-cards">
            <div className="stat-card">
              <div className="stat-icon green"><Wallet size={18} /></div>
              <div className="stat-label">Total Collected</div>
              <div className="stat-value">{fmt(totals.total)}</div>
              <div className="stat-sub">Lifetime</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon blue"><Calendar size={18} /></div>
              <div className="stat-label">Collected This Month</div>
              <div className="stat-value">{fmt(totals.thisMonth)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon yellow"><Receipt size={18} /></div>
              <div className="stat-label">Payments</div>
              <div className="stat-value">{totals.count}</div>
              <div className="stat-sub">Total transactions</div>
            </div>
          </div>

          {rows.length === 0
            ? <Empty message="No payments recorded yet." />
            : <DataTable columns={columns} rows={rows} getRowKey={p => p.id}
                searchKeys={[p => p.tenant_name]} searchPlaceholder="Search by business…"
                exportName="payments" exportTitle="StockFlow Payments" />}
        </>
      )}
    </div>
  );
}
