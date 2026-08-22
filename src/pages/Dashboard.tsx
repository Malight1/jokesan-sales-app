import React from 'react';
import { Link } from 'react-router-dom';
import { ShoppingCart, Truck, DollarSign, AlertTriangle, TrendingUp, Sparkles, MessageCircle, BellRing } from 'lucide-react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { reports, sales as salesApi, materials as materialsApi, finishedGoods as goodsApi, expenses as expensesApi, customers as customersApi } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { whatsappLink } from '../lib/whatsapp';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from '../components/DataStates';
import OfflineBanner from '../components/OfflineBanner';
import './Dashboard.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function Dashboard() {
  const toast = useToast();
  const { tenant, profile } = useAuth();
  const salesQ = useQuery(() => reports.salesSummary(), [], { cacheKey: 'dash-sales-summary' });
  const expQ = useQuery(() => reports.expenseSummary(), [], { cacheKey: 'dash-expense-summary' });
  const purQ = useQuery(() => reports.purchaseSummary(), [], { cacheKey: 'dash-purchase-summary' });
  const ordersQ = useQuery(() => salesApi.list(), [], { cacheKey: 'dash-orders' });
  const matQ = useQuery(() => materialsApi.list(), [], { cacheKey: 'dash-materials' });
  const goodQ = useQuery(() => goodsApi.list(), [], { cacheKey: 'dash-goods' });
  const expListQ = useQuery(() => expensesApi.list(), [], { cacheKey: 'dash-expenses' });
  const custQ = useQuery(() => customersApi.list(), [], { cacheKey: 'dash-customers' });
  const remindMut = useMutation(customersApi.markReminded);

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

  // ---- daily reminder queue: debtors overdue 14+ days, not reminded in the last 3 days ----
  const daysSince = (d: string) => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
  const custName = (id: string | null) => {
    const c = custQ.data?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer' : 'Walk-in';
  };
  const debtorMap: Record<string, { name: string; phone: string | null; balance: number; oldestDays: number; lastRemindedAt: string | null }> = {};
  (ordersQ.data ?? []).filter(s => !s.voided && s.balance > 0 && s.customer_id).forEach(s => {
    const key = s.customer_id!;
    const cust = custQ.data?.find(c => c.id === key);
    const age = daysSince(s.transaction_date);
    if (!debtorMap[key]) {
      debtorMap[key] = { name: custName(key), phone: cust?.phone ?? null, balance: 0, oldestDays: age, lastRemindedAt: cust?.last_reminded_at ?? null };
    }
    debtorMap[key].balance += s.balance;
    debtorMap[key].oldestDays = Math.max(debtorMap[key].oldestDays, age);
  });
  const reminderQueue = Object.entries(debtorMap)
    .filter(([, d]) => d.oldestDays >= 14 && (!d.lastRemindedAt || daysSince(d.lastRemindedAt) >= 3))
    .map(([id, d]) => ({ id, ...d }))
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 8);

  const sendReminder = async (d: { id: string; name: string; phone: string | null; balance: number }) => {
    const lines = [
      `Dear ${d.name},`, '',
      `This is a friendly payment reminder from *${tenant?.name ?? 'us'}*.`,
      `Your outstanding balance is *₦${d.balance.toLocaleString()}*.`,
      '', `Kindly settle at your earliest convenience. Thank you! 🙏`,
    ];
    window.open(whatsappLink(d.phone, lines.join('\n')), '_blank');
    const res = await remindMut.mutate(d.id);
    if (res !== null) { toast.success(`Marked ${d.name} as reminded.`); custQ.refetch(); }
  };

  const showReminders = profile?.role !== 'inventory';

  if (loading) return <Loading label="Loading dashboard…" />;
  if (error) return <ErrorState message={error} onRetry={() => { salesQ.refetch(); expQ.refetch(); purQ.refetch(); }} />;

  const trialEnds = tenant?.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const trialDaysLeft = trialEnds ? Math.ceil((trialEnds.getTime() - Date.now()) / 86400000) : null;
  const showTrial = tenant?.plan === 'trial' && trialDaysLeft !== null;

  const isOffline = salesQ.isOffline || expQ.isOffline || purQ.isOffline || ordersQ.isOffline;

  return (
    <div className="dashboard">
      {isOffline && <OfflineBanner label="dashboard data" />}
      {showTrial && (
        <div className="alert alert-info" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} />
            {trialDaysLeft! > 0
              ? `You have ${trialDaysLeft} day${trialDaysLeft !== 1 ? 's' : ''} left on your free trial.`
              : 'Your free trial has ended — subscribe to keep your data flowing.'}
          </span>
          <Link className="btn-primary btn-sm" to="/settings">Choose a plan</Link>
        </div>
      )}

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

        {showReminders && (
          <div className="card">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><BellRing size={16} /> Debtor Reminders Due Today</h3>
            {reminderQueue.length === 0 ? (
              <p className="no-alerts">No reminders due — you're all caught up.</p>
            ) : (
              <>
                {reminderQueue.map(d => (
                  <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.6rem 0', borderBottom: '1px solid #f1f5f9' }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{d.name}</div>
                      <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>{fmt(d.balance)} · {d.oldestDays} days overdue</div>
                    </div>
                    <button className="btn-secondary btn-sm" onClick={() => sendReminder(d)} disabled={remindMut.pending}>
                      <MessageCircle size={13} /> Remind
                    </button>
                  </div>
                ))}
              </>
            )}
          </div>
        )}

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
