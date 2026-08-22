import React, { useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts';
import { Download, MessageCircle } from 'lucide-react';
import { sales as salesApi, expenses as expensesApi, finishedGoods as goodsApi, customers as customersApi,
         purchases as purchasesApi, suppliers as suppliersApi, reports as reportsApi, lookups } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { whatsappLink } from '../lib/whatsapp';
import { Loading, ErrorState } from '../components/DataStates';
import { exportExcel, exportPDF, ExportColumn } from '../lib/exporters';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];

type Tab = 'pnl' | 'sales' | 'expenses' | 'stock' | 'debtors' | 'creditors' | 'products';
const TABS: { id: Tab; label: string }[] = [
  { id: 'pnl', label: 'Profit & Loss' },
  { id: 'sales', label: 'Sales' },
  { id: 'expenses', label: 'Expenses' },
  { id: 'stock', label: 'Stock' },
  { id: 'debtors', label: 'Debtors' },
  { id: 'creditors', label: 'Creditors' },
  { id: 'products', label: 'Product Profit' },
];

export default function Reports() {
  const { tenant } = useAuth();
  const [tab, setTab] = useState<Tab>('pnl');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');

  const salesQ = useQuery(() => salesApi.list(), []);
  const expQ = useQuery(() => expensesApi.list(), []);
  const goodsQ = useQuery(() => goodsApi.list(), []);
  const custQ = useQuery(() => customersApi.list(), []);
  const expTypesQ = useQuery(() => lookups.expenseTypes(), []);
  const purchQ = useQuery(() => purchasesApi.list(), []);
  const suppQ = useQuery(() => suppliersApi.list(), []);
  // Aggregated server-side, so it re-runs when the date range changes.
  const prodProfitQ = useQuery(() => reportsApi.productProfitability(from, to), [from, to]);

  const loading = salesQ.loading || expQ.loading || goodsQ.loading;
  const error = salesQ.error || expQ.error || goodsQ.error;

  const inRange = (d: string | null) => {
    if (!d) return true;
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  };

  // Voided sales are excluded from every report.
  const sales = (salesQ.data ?? []).filter(s => !s.voided && inRange(s.transaction_date));
  const expenses = (expQ.data ?? []).filter(e => inRange(e.expense_date));
  const goods = goodsQ.data ?? [];

  const totalSales = sales.reduce((s, t) => s + (t.total_amount || 0), 0);
  const totalCogs = sales.reduce((s, t) => s + (t.cogs || 0), 0);
  const grossProfit = sales.reduce((s, t) => s + (t.gross_profit || 0), 0);
  const totalOutstanding = sales.reduce((s, t) => s + (t.balance || 0), 0);
  const totalExpenses = expenses.reduce((s, e) => s + (e.amount || 0), 0);
  const netProfit = grossProfit - totalExpenses;
  const stockValue = goods.reduce((s, g) => s + g.selling_price * g.qty_balance, 0);

  // Monthly sales vs expenses
  const monthMap: Record<string, { sales: number; expenses: number }> = {};
  sales.forEach(s => {
    if (!s.transaction_date) return;
    const k = new Date(s.transaction_date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    monthMap[k] = monthMap[k] || { sales: 0, expenses: 0 };
    monthMap[k].sales += s.total_amount || 0;
  });
  expenses.forEach(e => {
    if (!e.expense_date) return;
    const k = new Date(e.expense_date).toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    monthMap[k] = monthMap[k] || { sales: 0, expenses: 0 };
    monthMap[k].expenses += e.amount || 0;
  });
  const monthlySales = Object.entries(monthMap).map(([month, v]) => ({ month, ...v }));

  // Expense by type
  const typeName = (id: string | null) => expTypesQ.data?.find(t => t.id === id)?.name ?? 'Other';
  const expTypeMap: Record<string, number> = {};
  expenses.forEach(e => { const n = typeName(e.expense_type_id); expTypeMap[n] = (expTypeMap[n] || 0) + (e.amount || 0); });
  const expenseByType = Object.entries(expTypeMap).map(([name, value]) => ({ name, value }));

  // Debtors: customers with outstanding balances
  const custName = (id: string | null) => {
    const c = custQ.data?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Unknown' : 'Walk-in';
  };
  const debtorMap: Record<string, { id: string | null; name: string; phone: string | null; total: number; paid: number; balance: number; count: number }> = {};
  sales.filter(s => s.balance > 0).forEach(s => {
    const key = s.customer_id ?? 'walkin';
    const phone = custQ.data?.find(c => c.id === s.customer_id)?.phone ?? null;
    debtorMap[key] = debtorMap[key] || { id: s.customer_id, name: custName(s.customer_id), phone, total: 0, paid: 0, balance: 0, count: 0 };
    debtorMap[key].total += s.total_amount;
    debtorMap[key].paid += s.amount_paid;
    debtorMap[key].balance += s.balance;
    debtorMap[key].count += 1;
  });
  const debtors = Object.values(debtorMap).sort((a, b) => b.balance - a.balance);

  // Creditors: suppliers we still owe. Same shape as debtors, other direction.
  const suppName = (id: string | null) => {
    const x = suppQ.data?.find(v => v.id === id);
    return x ? `${x.first_name ?? ''} ${x.last_name ?? ''}`.trim() || x.company_store || 'Unknown' : 'No supplier';
  };
  const purchases = (purchQ.data ?? []).filter(pu => !pu.voided && inRange(pu.purchase_date));
  const creditorMap: Record<string, { name: string; total: number; paid: number; balance: number; count: number }> = {};
  purchases.filter(pu => pu.balance > 0).forEach(pu => {
    const key = pu.supplier_id ?? 'none';
    creditorMap[key] = creditorMap[key] || { name: suppName(pu.supplier_id), total: 0, paid: 0, balance: 0, count: 0 };
    creditorMap[key].total += pu.total_amount;
    creditorMap[key].paid += pu.total_paid;
    creditorMap[key].balance += pu.balance;
    creditorMap[key].count += 1;
  });
  const creditors = Object.values(creditorMap).sort((a, b) => b.balance - a.balance);
  const totalOwed = creditors.reduce((sum, c) => sum + c.balance, 0);

  const productProfit = prodProfitQ.data ?? [];
  const productRevenue = productProfit.reduce((sum, r) => sum + Number(r.total_revenue || 0), 0);
  const productProfitTotal = productProfit.reduce((sum, r) => sum + Number(r.profit || 0), 0);

  const remindDebtor = async (d: { id: string | null; name: string; phone: string | null; balance: number }) => {
    const lines = [
      `Dear ${d.name},`,
      ``,
      `This is a friendly payment reminder from *${tenant?.name ?? 'us'}*.`,
      `Your outstanding balance is *₦${d.balance.toLocaleString()}*.`,
      ``,
      `Kindly settle at your earliest convenience. Thank you for your patronage! 🙏`,
    ];
    window.open(whatsappLink(d.phone, lines.join('\n')), '_blank');
    if (d.id) await customersApi.markReminded(d.id);
  };

  const rangeLabel = from || to ? ` (${from || 'start'} → ${to || 'today'})` : '';

  // ---- Exports per tab ----
  const doExport = async (kind: 'xlsx' | 'pdf') => {
    let cols: ExportColumn<any>[] = [];
    let rows: any[] = [];
    let name: string = tab;
    let title = '';

    if (tab === 'pnl') {
      cols = [{ header: 'Item', value: r => r.item }, { header: 'Amount (₦)', value: r => r.amount }];
      rows = [
        { item: 'Revenue', amount: totalSales },
        { item: 'Cost of Goods Sold (COGS)', amount: -totalCogs },
        { item: 'Gross Profit', amount: grossProfit },
        { item: 'Operating Expenses', amount: -totalExpenses },
        { item: 'Net Profit', amount: netProfit },
      ];
      name = 'profit-and-loss'; title = 'Profit & Loss' + rangeLabel;
    } else if (tab === 'sales') {
      cols = [
        { header: 'Date', value: r => r.transaction_date },
        { header: 'Customer', value: r => custName(r.customer_id) },
        { header: 'Total', value: r => r.total_amount },
        { header: 'Paid', value: r => r.amount_paid },
        { header: 'Balance', value: r => r.balance },
        { header: 'COGS', value: r => r.cogs },
        { header: 'Profit', value: r => r.gross_profit },
        { header: 'Status', value: r => r.payment_status },
      ];
      rows = sales; name = 'sales-report'; title = 'Sales Report' + rangeLabel;
    } else if (tab === 'expenses') {
      cols = [
        { header: 'Date', value: r => r.expense_date },
        { header: 'Type', value: r => typeName(r.expense_type_id) },
        { header: 'Description', value: r => r.description ?? '' },
        { header: 'Amount', value: r => r.amount },
      ];
      rows = expenses; name = 'expenses-report'; title = 'Expenses Report' + rangeLabel;
    } else if (tab === 'stock') {
      cols = [
        { header: 'Product', value: r => r.name },
        { header: 'Qty', value: r => r.qty_balance },
        { header: 'Unit Price', value: r => r.selling_price },
        { header: 'Stock Value', value: r => r.selling_price * r.qty_balance },
      ];
      rows = goods; name = 'stock-report'; title = 'Stock Value Report';
    } else if (tab === 'debtors') {
      cols = [
        { header: 'Customer', value: r => r.name },
        { header: 'Invoices', value: r => r.count },
        { header: 'Total', value: r => r.total },
        { header: 'Paid', value: r => r.paid },
        { header: 'Outstanding', value: r => r.balance },
      ];
      rows = debtors; name = 'debtors-report'; title = 'Outstanding Debtors' + rangeLabel;
    } else if (tab === 'creditors') {
      cols = [
        { header: 'Supplier', value: r => r.name },
        { header: 'Bills', value: r => r.count },
        { header: 'Total', value: r => r.total },
        { header: 'Paid', value: r => r.paid },
        { header: 'Owed', value: r => r.balance },
      ];
      rows = creditors; name = 'creditors-report'; title = 'Outstanding Creditors' + rangeLabel;
    } else {
      cols = [
        { header: 'Product', value: r => r.product_name },
        { header: 'Qty Sold', value: r => r.qty_sold },
        { header: 'Revenue', value: r => r.total_revenue },
        { header: 'COGS', value: r => r.total_cogs },
        { header: 'Gross Profit', value: r => r.profit },
        { header: 'Margin %', value: r => r.margin_pct },
      ];
      rows = productProfit; name = 'product-profitability'; title = 'Product Profitability' + rangeLabel;
    }

    try {
      if (kind === 'xlsx') await exportExcel(cols, rows, name);
      else await exportPDF(cols, rows, name, title);
    } catch {
      window.alert('Could not build the export file. Please try again.');
    }
  };

  if (loading) return <Loading label="Building reports…" />;
  if (error) return <ErrorState message={error} onRetry={() => { salesQ.refetch(); expQ.refetch(); goodsQ.refetch(); }} />;

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Reports</h1><p>Business performance overview{rangeLabel}</p></div>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button className="btn-secondary" onClick={() => doExport('xlsx')}><Download size={15} /> Excel</button>
          <button className="btn-secondary" onClick={() => doExport('pdf')}><Download size={15} /> PDF</button>
        </div>
      </div>

      {/* Date range */}
      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        {(from || to) && (
          <button className="btn-ghost btn-sm" style={{ marginBottom: 4 }} onClick={() => { setFrom(''); setTo(''); }}>Clear</button>
        )}
      </div>

      <div className="stat-cards">
        <div className="stat-card"><div className="stat-label">Revenue</div><div className="stat-value">{fmt(totalSales)}</div></div>
        <div className="stat-card"><div className="stat-label">Gross Profit</div><div className="stat-value" style={{ color: '#16a34a' }}>{fmt(grossProfit)}</div></div>
        <div className="stat-card"><div className="stat-label">Net Profit</div><div className="stat-value" style={{ color: netProfit >= 0 ? '#16a34a' : '#dc2626' }}>{fmt(netProfit)}</div></div>
        <div className="stat-card"><div className="stat-label">Outstanding Debt</div><div className="stat-value" style={{ color: '#dc2626' }}>{fmt(totalOutstanding)}</div></div>
      </div>

      <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem', borderBottom: '1px solid #e2e8f0', flexWrap: 'wrap' }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            style={{ padding: '0.6rem 1.1rem', background: 'none', border: 'none', cursor: 'pointer',
              fontWeight: tab === t.id ? 700 : 400, color: tab === t.id ? '#2563eb' : '#64748b',
              borderBottom: tab === t.id ? '2px solid #2563eb' : '2px solid transparent',
              fontSize: '0.875rem', marginBottom: '-1px' }}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'pnl' && (
        <div className="card" style={{ maxWidth: 560 }}>
          <h3 style={{ marginBottom: '1rem' }}>Profit &amp; Loss{rangeLabel}</h3>
          {[
            { label: 'Revenue', value: totalSales },
            { label: 'Cost of Goods Sold (COGS)', value: -totalCogs },
            { label: 'Gross Profit', value: grossProfit, strong: true },
            { label: 'Operating Expenses', value: -totalExpenses },
            { label: 'Net Profit', value: netProfit, strong: true, final: true },
          ].map(row => (
            <div key={row.label} style={{
              display: 'flex', justifyContent: 'space-between', padding: '0.7rem 0',
              borderBottom: row.final ? 'none' : '1px solid #f1f5f9',
              borderTop: row.final ? '2px solid #e2e8f0' : 'none',
              fontWeight: row.strong ? 700 : 400,
            }}>
              <span>{row.label}</span>
              <span style={{ color: row.value < 0 ? '#dc2626' : row.strong ? (row.value >= 0 ? '#16a34a' : '#dc2626') : '#1e293b' }}>
                {row.value < 0 ? `(${fmt(Math.abs(row.value))})` : fmt(row.value)}
              </span>
            </div>
          ))}
        </div>
      )}

      {tab === 'sales' && (
        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>Monthly Sales vs Expenses</h3>
          {monthlySales.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No data in this range.</p> : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={monthlySales}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v: any) => '₦' + (v / 1000) + 'k'} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: any) => fmt(v)} />
                <Bar dataKey="sales" name="Sales" fill="#2563eb" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expenses" name="Expenses" fill="#dc2626" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
          <div className="table-wrapper" style={{ marginTop: '1.5rem' }}>
            <table>
              <thead><tr><th>Date</th><th>Customer</th><th>Total</th><th>Paid</th><th>Balance</th><th>Profit</th></tr></thead>
              <tbody>
                {sales.map(s => (
                  <tr key={s.id}>
                    <td data-label="Date">{s.transaction_date}</td>
                    <td data-label="Customer">{custName(s.customer_id)}</td>
                    <td data-label="Total" style={{ fontWeight: 600 }}>{fmt(s.total_amount)}</td>
                    <td data-label="Paid">{fmt(s.amount_paid)}</td>
                    <td data-label="Balance" style={{ color: s.balance > 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>{fmt(s.balance)}</td>
                    <td data-label="Profit" style={{ color: '#16a34a', fontWeight: 600 }}>{fmt(s.gross_profit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'expenses' && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
          <div className="card">
            <h3 style={{ marginBottom: '1rem' }}>Expenses by Type</h3>
            {expenseByType.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No expenses in this range.</p> : (
              <ResponsiveContainer width="100%" height={260}>
                <PieChart>
                  <Pie data={expenseByType} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90}
                    label={({ name, percent }: any) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}>
                    {expenseByType.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: any) => fmt(v)} />
                </PieChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="card">
            <h3 style={{ marginBottom: '1rem' }}>Expense Breakdown</h3>
            {expenseByType.map((e, i) => (
              <div key={e.name} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.75rem 0', borderBottom: '1px solid #f1f5f9' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ width: 10, height: 10, borderRadius: '50%', background: COLORS[i % COLORS.length] }} />
                  <span style={{ fontSize: '0.875rem' }}>{e.name}</span>
                </div>
                <strong style={{ fontSize: '0.875rem' }}>{fmt(e.value)}</strong>
              </div>
            ))}
            <div style={{ display: 'flex', justifyContent: 'space-between', padding: '0.75rem 0', fontWeight: 700 }}>
              <span>Total</span><span>{fmt(totalExpenses)}</span>
            </div>
          </div>
        </div>
      )}

      {tab === 'stock' && (
        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>Finished Goods Stock Value — total {fmt(stockValue)}</h3>
          <div className="table-wrapper">
            <table>
              <thead><tr><th>Product</th><th>Qty</th><th>Unit Price</th><th>Stock Value</th></tr></thead>
              <tbody>
                {goods.map(g => (
                  <tr key={g.id}>
                    <td data-label="Product" style={{ fontWeight: 600 }}>{g.name}</td>
                    <td data-label="Qty">{g.qty_balance.toLocaleString()}</td>
                    <td data-label="Unit Price">{fmt(g.selling_price)}</td>
                    <td data-label="Stock Value" style={{ fontWeight: 700 }}>{fmt(g.selling_price * g.qty_balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'debtors' && (
        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>Outstanding Debtors — total {fmt(totalOutstanding)}</h3>
          {debtors.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No outstanding balances. 🎉</p> : (
            <div className="table-wrapper">
              <table>
                <thead><tr><th>Customer</th><th>Invoices</th><th>Total</th><th>Paid</th><th>Outstanding</th><th></th></tr></thead>
                <tbody>
                  {debtors.map(d => (
                    <tr key={d.name}>
                      <td data-label="Customer" style={{ fontWeight: 600 }}>{d.name}</td>
                      <td data-label="Invoices">{d.count}</td>
                      <td data-label="Total">{fmt(d.total)}</td>
                      <td data-label="Paid">{fmt(d.paid)}</td>
                      <td data-label="Outstanding" style={{ color: '#dc2626', fontWeight: 700 }}>{fmt(d.balance)}</td>
                      <td data-label="" style={{ textAlign: 'right' }}>
                        <button className="btn-secondary btn-sm" onClick={() => remindDebtor(d)} title="Send WhatsApp payment reminder">
                          <MessageCircle size={14} /> Remind
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'creditors' && (
        <div className="card">
          <h3 style={{ marginBottom: '1rem' }}>Outstanding Creditors — total {fmt(totalOwed)}</h3>
          {creditors.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>You don't owe any supplier right now. 🎉</p> : (
            <div className="table-wrapper">
              <table>
                <thead><tr><th>Supplier</th><th>Bills</th><th>Total</th><th>Paid</th><th>Owed</th></tr></thead>
                <tbody>
                  {creditors.map(c => (
                    <tr key={c.name}>
                      <td data-label="Supplier" style={{ fontWeight: 600 }}>{c.name}</td>
                      <td data-label="Bills">{c.count}</td>
                      <td data-label="Total">{fmt(c.total)}</td>
                      <td data-label="Paid">{fmt(c.paid)}</td>
                      <td data-label="Owed" style={{ color: '#d97706', fontWeight: 700 }}>{fmt(c.balance)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {tab === 'products' && (
        <div className="card">
          <h3 style={{ marginBottom: '0.35rem' }}>Product Profitability{rangeLabel}</h3>
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '1rem' }}>
            Margin per product, costed from the FIFO batches each sale actually consumed.
          </p>
          {prodProfitQ.loading && <Loading label="Calculating margins…" />}
          {prodProfitQ.error && <ErrorState message={prodProfitQ.error} onRetry={prodProfitQ.refetch} />}
          {!prodProfitQ.loading && !prodProfitQ.error && (
            productProfit.length === 0
              ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No sales in this period yet.</p>
              : (
                <>
                  <div className="table-wrapper">
                    <table>
                      <thead><tr><th>Product</th><th>Qty Sold</th><th>Revenue</th><th>COGS</th><th>Gross Profit</th><th>Margin</th></tr></thead>
                      <tbody>
                        {productProfit.map(r => (
                          <tr key={r.fg_id}>
                            <td data-label="Product" style={{ fontWeight: 600 }}>{r.product_name}</td>
                            <td data-label="Qty Sold">{Number(r.qty_sold).toLocaleString()}</td>
                            <td data-label="Revenue">{fmt(Number(r.total_revenue))}</td>
                            <td data-label="COGS">{fmt(Number(r.total_cogs))}</td>
                            <td data-label="Gross Profit" style={{ fontWeight: 700, color: Number(r.profit) >= 0 ? '#16a34a' : '#dc2626' }}>
                              {fmt(Number(r.profit))}
                            </td>
                            <td data-label="Margin">
                              <span className={Number(r.margin_pct) >= 20 ? 'badge-success' : Number(r.margin_pct) > 0 ? 'badge-warning' : 'badge-danger'}>
                                {Number(r.margin_pct).toFixed(1)}%
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p style={{ marginTop: '0.9rem', fontSize: '0.9rem', color: '#475569' }}>
                    Across {productProfit.length} product{productProfit.length !== 1 ? 's' : ''}:{' '}
                    <strong>{fmt(productRevenue)}</strong> revenue,{' '}
                    <strong style={{ color: productProfitTotal >= 0 ? '#16a34a' : '#dc2626' }}>{fmt(productProfitTotal)}</strong> gross profit
                    {productRevenue > 0 && <> ({((productProfitTotal / productRevenue) * 100).toFixed(1)}% blended margin)</>}.
                  </p>
                </>
              )
          )}
        </div>
      )}
    </div>
  );
}
