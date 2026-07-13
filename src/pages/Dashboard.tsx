import React from 'react';
import { ShoppingCart, Truck, DollarSign, AlertTriangle, TrendingUp } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { reports, sales as salesApi, materials as materialsApi, finishedGoods as goodsApi, expenses as expensesApi } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { Loading, ErrorState } from '../components/DataStates';
import './Dashboard.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function Dashboard() {
  const salesQ = useQuery(() => reports.salesSummary(), []);
  const expQ = useQuery(() => reports.expenseSummary(), []);
  const purQ = useQuery(() => reports.purchaseSummary(), []);
  const ordersQ = useQuery(() => salesApi.list(), []);
  const matQ = useQuery(() => materialsApi.list(), []);
  const goodQ = useQuery(() => goodsApi.list(), []);
  const expListQ = useQuery(() => expensesApi.list(), []);

  const loading = salesQ.loading || expQ.loading || purQ.loading;
  const error = salesQ.error || expQ.error || purQ.error;

  const salesRows = salesQ.data ?? [];
  const totalSales = salesRows.reduce((s, t) => s + (t.total_amount || 0), 0);
  const totalOutstanding = salesRows.reduce((s, t) => s + (t.balance || 0), 0);
  const totalProfit = salesRows.reduce((s, t) => s + (t.gross_profit || 0), 0);
  const totalExpenses = (expQ.data ?? []).reduce((s, e) => s + (e.amount || 0), 0);
  const totalPurchases = (purQ.data ?? []).reduce((s, p) => s + (p.total_amount || 0), 0);

  const lowMaterials = (matQ.data ?? []).filter(m => m.qty_balance <= m.min_stock_level);
  const lowGoods = (goodQ.data ?? []).filter(g => g.qty_balance <= g.min_stock_level);

  // Build monthly sales trend from real rows
  const byMonth: Record<string, number> = {};
  salesRows.forEach(r => {
    if (!r.transaction_date) return;
    const d = new Date(r.transaction_date);
    const key = d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    byMonth[key] = (byMonth[key] || 0) + (r.total_amount || 0);
  });
  const salesByMonth = Object.entries(byMonth).map(([month, sales]) => ({ month, sales }));

  const recentSales = (ordersQ.data ?? []).slice(0, 6);
  const statusBadge = (s: string) => s === 'full' ? 'success' : s === 'unpaid' ? 'danger' : 'warning';
  const statusLabel = (s: string) => s === 'full' ? 'Full' : s === 'unpaid' ? 'Unpaid' : 'Part';

  if (loading) return <Loading label="Loading dashboard…" />;
  if (error) return <ErrorState message={error} onRetry={() => { salesQ.refetch(); expQ.refetch(); purQ.refetch(); }} />;

  return (
    <div className="dashboard">
      <div className="stat-cards">
        <div className="stat-card">
          <div className="stat-icon blue"><ShoppingCart size={18} /></div>
          <div className="stat-label">Total Sales</div>
          <div className="stat-value">{fmt(totalSales)}</div>
          <div className="stat-sub">{salesRows.length} transactions</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green"><TrendingUp size={18} /></div>
          <div className="stat-label">Gross Profit</div>
          <div className="stat-value">{fmt(totalProfit)}</div>
          <div className="stat-sub">Revenue − COGS</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon red"><AlertTriangle size={18} /></div>
          <div className="stat-label">Outstanding</div>
          <div className="stat-value">{fmt(totalOutstanding)}</div>
          <div className="stat-sub">Unpaid balances</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon yellow"><Truck size={18} /></div>
          <div className="stat-label">Purchases</div>
          <div className="stat-value">{fmt(totalPurchases)}</div>
          <div className="stat-sub">{(purQ.data ?? []).length} orders</div>
        </div>
        <div className="stat-card">
          <div className="stat-icon green"><DollarSign size={18} /></div>
          <div className="stat-label">Expenses</div>
          <div className="stat-value">{fmt(totalExpenses)}</div>
          <div className="stat-sub">{(expListQ.data ?? []).length} logged</div>
        </div>
      </div>

      <div className="dashboard-grid">
        <div className="card chart-card">
          <h3>Sales Trend</h3>
          {salesByMonth.length === 0 ? (
            <p className="no-alerts">No sales recorded yet.</p>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={salesByMonth}>
                <defs>
                  <linearGradient id="salesGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#2563eb" stopOpacity={0.15} />
                    <stop offset="95%" stopColor="#2563eb" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="month" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v: any) => '₦' + (v / 1000) + 'k'} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: any) => fmt(v)} />
                <Area type="monotone" dataKey="sales" stroke="#2563eb" strokeWidth={2} fill="url(#salesGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h3>Recent Sales</h3>
          {recentSales.length === 0 ? <p className="no-alerts">No sales yet.</p> : (
            <table className="dash-table">
              <thead><tr><th>Date</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {recentSales.map(s => (
                  <tr key={s.id}>
                    <td>{s.transaction_date}</td>
                    <td>{fmt(s.total_amount)}</td>
                    <td><span className={`badge-${statusBadge(s.payment_status)}`}>{statusLabel(s.payment_status)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h3>Low Stock Alerts</h3>
          {lowMaterials.length === 0 && lowGoods.length === 0 ? (
            <p className="no-alerts">All stock levels are healthy.</p>
          ) : (
            <>
              {lowGoods.map(g => (
                <div className="alert-row alert-warning" key={g.id}>
                  <AlertTriangle size={14} />
                  <div><strong>{g.name}</strong><span>{g.qty_balance} {g.unit} remaining</span></div>
                </div>
              ))}
              {lowMaterials.map(m => (
                <div className="alert-row alert-warning" key={m.id}>
                  <AlertTriangle size={14} />
                  <div><strong>{m.name}</strong><span>{m.qty_balance} {m.unit} remaining</span></div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
