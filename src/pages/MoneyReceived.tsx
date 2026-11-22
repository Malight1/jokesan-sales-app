import React, { useMemo, useState } from 'react';
import { incomingPayments, IncomingPayment } from '../lib/api';
import { useQuery } from '../lib/hooks';
import DataTable, { Column } from '../components/DataTable';
import '../styles/accounts.scss';

const fmt = (n: number) => '₦' + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const PROVIDER: Record<string, string> = { monnify: 'Moniepoint', paystack: 'Paystack', opay: 'OPay' };
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// Every payment a provider has confirmed (migrations 0027, 0057, 0058):
// invoice pay links and till transfers, from Moniepoint, Paystack and
// OPay, in one list. "Needs attention" is money that came in but didn't
// pay anything automatically: a short payment, or a transfer the cashier
// cancelled before it arrived.
export default function MoneyReceived() {
  const { data: rows, loading, error, refetch } = useQuery<IncomingPayment[]>(() => incomingPayments.list(), [], { cacheKey: 'money-received' });
  const [provider, setProvider] = useState('');

  const monthStart = useMemo(() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).getTime(); }, []);
  const shown = (rows ?? []).filter(r => !provider || r.provider === provider);
  const month = (rows ?? []).filter(r => new Date(r.received_at).getTime() >= monthStart);
  const byProvider = Object.entries(month.reduce<Record<string, number>>((m, r) => { m[r.provider] = (m[r.provider] ?? 0) + Number(r.amount); return m; }, {}));
  const attention = (rows ?? []).filter(r => r.match_status === 'unmatched');

  const columns: Column<IncomingPayment>[] = [
    { key: 'received_at', header: 'When', value: r => r.received_at, render: r => when(r.received_at) },
    { key: 'provider', header: 'Through', value: r => PROVIDER[r.provider] ?? r.provider,
      render: r => <span className="badge-gray">{PROVIDER[r.provider] ?? r.provider}</span> },
    { key: 'amount', header: 'Amount', align: 'right', value: r => Number(r.amount), render: r => <strong className="acct-num">{fmt(r.amount)}</strong> },
    { key: 'payer', header: 'From', value: r => r.payer_name ?? '',
      render: r => r.payer_name || r.payer_account
        ? <div className="acct-name"><strong>{r.payer_name ?? 'Unknown'}</strong>{r.payer_account && <span>{r.payer_account}</span>}</div>
        : <span className="acct-muted">Not given</span> },
    { key: 'for', header: 'Paid for', value: r => r.sales_orders?.doc_no ?? '',
      render: r => r.sales_orders?.doc_no
        ? <span className="acct-num">{r.sales_orders.doc_no}{r.till_payment_id ? ' (till)' : ''}</span>
        : <span className="acct-muted">Nothing yet</span> },
    { key: 'status', header: 'Status', value: r => r.match_status,
      render: r => r.match_status === 'unmatched'
        ? <span className="badge-warning" title="Came in but didn't pay a sale automatically">Needs attention</span>
        : <span className="badge-success">Matched</span> },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Money received</h1>
          <p>Every payment Moniepoint, Paystack or OPay confirmed, from pay links and the till.</p>
        </div>
      </div>

      {(rows ?? []).length > 0 && (
        <div className="stat-cards">
          <div className="stat-card">
            <div className="stat-label">This month</div>
            <div className="stat-value">{fmt(month.reduce((s, r) => s + Number(r.amount), 0))}</div>
            <div className="stat-sub">{byProvider.map(([p, v]) => `${PROVIDER[p] ?? p} ${fmt(v)}`).join(' · ') || 'Nothing yet'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Needs attention</div>
            <div className="stat-value" style={{ color: attention.length ? '#d97706' : undefined }}>{attention.length}</div>
            <div className="stat-sub">{attention.length ? 'Short payments, or money for a transfer the cashier cancelled' : 'Every payment matched a sale'}</div>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows ? shown : null}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={r => r.id}
        searchKeys={[r => r.payer_name ?? '', r => r.payer_account ?? '', r => r.sales_orders?.doc_no ?? '', r => r.provider_ref]}
        searchPlaceholder="Search name, account or invoice…"
        exportName="money-received"
        exportTitle="Money received"
        toolbarExtra={
          <select className="input-sm" value={provider} onChange={e => setProvider(e.target.value)} aria-label="Show payments through">
            <option value="">All providers</option>
            <option value="monnify">Moniepoint</option>
            <option value="paystack">Paystack</option>
            <option value="opay">OPay</option>
          </select>
        }
        emptyMessage="No confirmed payments yet. Connect Moniepoint, Paystack or OPay under Settings → Payments, then use Pay link on invoices or Pay by transfer at the till."
      />
    </div>
  );
}
