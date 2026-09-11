import React from 'react';
import { Link } from 'react-router-dom';
import {
  ShoppingCart, Truck, DollarSign, AlertTriangle, TrendingUp, Sparkles,
  MessageCircle, BellRing, Package, FlaskConical, XCircle, Receipt, Wallet, ArrowLeftRight, Building2,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { dashboard, customers as customersApi, DashboardSummary, LowStockItem } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { whatsappLink } from '../lib/whatsapp';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from '../components/DataStates';
import OfflineBanner from '../components/OfflineBanner';
import './Dashboard.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const num = (n: number) => (n || 0).toLocaleString();

// ------------------------------------------------------------------
// One dashboard used to serve all four roles, with a single line of
// difference between them — so a cashier signed in and saw the company's
// gross profit and total expenses.
//
// Now each role gets a view built for its job, and the split is enforced
// on the server: dashboard_summary() (migration 0018) computes a different
// payload per role, so the figures a cashier shouldn't see are never sent
// to their browser rather than merely hidden in it.
// ------------------------------------------------------------------

function StatCard({ icon, tone, label, value, sub }: {
  icon: React.ReactNode; tone: string; label: string; value: string; sub?: string;
}) {
  return (
    <div className="stat-card">
      <div className={`stat-icon ${tone}`}>{icon}</div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function LowStockCard({ items, title = 'Low Stock Alerts', showBranch = false }: { items: LowStockItem[]; title?: string; showBranch?: boolean }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {items.length === 0 ? (
        <p className="no-alerts">All stock levels are healthy.</p>
      ) : (
        <>
          {items.map((i, k) => (
            <div className="alert-row alert-warning" key={`${i.kind}-${i.name}-${k}`}>
              <AlertTriangle size={14} />
              <div>
                <strong>{i.name}</strong>
                <span>{num(Number(i.qty))} {i.unit ?? ''} left · reorder at {num(Number(i.min))}{showBranch && i.branch ? ` · ${i.branch}` : ''}</span>
              </div>
            </div>
          ))}
          <Link className="btn-ghost btn-sm" to="/stock-alerts" style={{ marginTop: '0.6rem', display: 'inline-flex' }}>
            View all stock alerts
          </Link>
        </>
      )}
    </div>
  );
}

const payBadge = (s: string) => `badge-${s === 'full' ? 'success' : s === 'unpaid' ? 'danger' : 'warning'}`;

// ------------------------------------------------------------------
// CASHIER — the till, today. No margin, no expenses, no company totals.
// ------------------------------------------------------------------
function CashierDashboard({ d }: { d: DashboardSummary }) {
  const week = (d.week_trend ?? []).map(w => ({
    label: new Date(w.day).toLocaleDateString('en-GB', { weekday: 'short' }),
    total: Number(w.total),
  }));

  return (
    <>
      <div className="stat-cards">
        <StatCard icon={<Wallet size={18} />} tone="blue" label="My sales today"
          value={fmt(Number(d.my_today_total ?? 0))}
          sub={`${num(Number(d.my_today_count ?? 0))} transaction${Number(d.my_today_count ?? 0) !== 1 ? 's' : ''}`} />
        <StatCard icon={<ShoppingCart size={18} />} tone="green"
          label={d.multi_branch ? `${d.branch_name} total today` : 'Counter total today'}
          value={fmt(Number(d.today_total ?? 0))}
          sub={`${num(Number(d.today_count ?? 0))} across all staff`} />
        <StatCard icon={<Receipt size={18} />} tone="red" label="Left on credit today"
          value={fmt(Number(d.today_unpaid ?? 0))} sub="Still to be collected" />
        <StatCard icon={<Package size={18} />} tone="yellow" label="Products running low"
          value={num(Number(d.low_goods_count ?? 0))} sub="Tell the storekeeper" />
      </div>

      <div className="dashboard-grid">
        <div className="card chart-card">
          <h3>Last 7 Days at the Counter</h3>
          {week.length === 0 ? <p className="no-alerts">No sales in the last week.</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={week}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={(v: any) => '₦' + (v / 1000) + 'k'} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip formatter={(v: any) => fmt(v)} />
                <Bar dataKey="total" fill="#2563eb" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="card">
          <h3>My Recent Sales</h3>
          {(d.my_recent ?? []).length === 0 ? <p className="no-alerts">You haven't rung up a sale yet.</p> : (
            <table className="dash-table">
              <thead><tr><th>Customer</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {(d.my_recent ?? []).map(s => (
                  <tr key={s.id}>
                    <td>{s.customer}</td>
                    <td>{fmt(Number(s.total))}</td>
                    <td><span className={payBadge(s.status)}>
                      {s.status === 'full' ? 'Paid' : s.status === 'unpaid' ? 'Unpaid' : 'Part'}
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Link className="btn-primary btn-sm" to="/pos" style={{ marginTop: '0.75rem', display: 'inline-flex' }}>
            Open the till
          </Link>
        </div>

        <LowStockCard items={(d.low_stock ?? []).filter(i => i.kind === 'finished_good')}
                      title="Products Running Low" />
      </div>
    </>
  );
}

// ------------------------------------------------------------------
// STOREKEEPER — stock and production. Deliberately no money at all.
// ------------------------------------------------------------------
function InventoryDashboard({ d }: { d: DashboardSummary }) {
  const movementLabel: Record<string, string> = {
    PURCHASE: 'Purchase in', PRODUCTION: 'Production', SALE: 'Sold', ADJUSTMENT: 'Adjustment', TRANSFER: 'Transfer',
  };

  return (
    <>
      <div className="stat-cards">
        <StatCard icon={<XCircle size={18} />} tone="red" label="Out of stock"
          value={num(Number(d.out_of_stock_count ?? 0))}
          sub={d.multi_branch ? `Nothing left at ${d.branch_name}` : 'Nothing left at all'} />
        <StatCard icon={<AlertTriangle size={18} />} tone="yellow" label="Below reorder level"
          value={num(Number(d.low_goods_count ?? 0) + Number(d.low_materials_count ?? 0))}
          sub={`${num(Number(d.low_goods_count ?? 0))} products · ${num(Number(d.low_materials_count ?? 0))} materials`} />
        <StatCard icon={<FlaskConical size={18} />} tone="green" label="Produced this month"
          value={num(Number(d.production_this_month ?? 0))}
          sub={`${num(Number(d.production_runs_this_month ?? 0))} run${Number(d.production_runs_this_month ?? 0) !== 1 ? 's' : ''}`} />
        <StatCard icon={<Truck size={18} />} tone="blue" label="Open purchases"
          value={num(Number(d.open_purchases ?? 0))} sub="Not fully settled" />
      </div>

      <div className="dashboard-grid">
        <LowStockCard items={d.low_stock ?? []} title="Needs Reordering" />

        <div className="card">
          <h3>Recent Production</h3>
          {(d.recent_production ?? []).length === 0 ? <p className="no-alerts">No production runs yet.</p> : (
            <table className="dash-table">
              <thead><tr><th>Date</th><th>Product</th><th>Qty</th></tr></thead>
              <tbody>
                {(d.recent_production ?? []).map(r => (
                  <tr key={r.id}>
                    <td>{r.date}</td>
                    <td>{r.product}</td>
                    <td>{num(Number(r.qty))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <Link className="btn-primary btn-sm" to="/production" style={{ marginTop: '0.75rem', display: 'inline-flex' }}>
            Record production
          </Link>
        </div>

        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <ArrowLeftRight size={16} /> Latest Stock Movements
          </h3>
          {(d.recent_movements ?? []).length === 0 ? <p className="no-alerts">Nothing has moved yet.</p> : (
            <table className="dash-table">
              <thead><tr><th>When</th><th>Type</th><th>Qty</th></tr></thead>
              <tbody>
                {(d.recent_movements ?? []).map(m => (
                  <tr key={m.id}>
                    <td>{new Date(m.at).toLocaleDateString('en-GB')}</td>
                    <td>{movementLabel[m.type] ?? m.type}</td>
                    <td style={{ color: Number(m.qty) < 0 ? '#dc2626' : '#16a34a', fontWeight: 600 }}>
                      {Number(m.qty) > 0 ? '+' : ''}{num(Number(m.qty))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------
// OWNER / ACCOUNTS — the full financial picture.
// ------------------------------------------------------------------
function OwnerDashboard({ d, onReminded }: { d: DashboardSummary; onReminded: () => void }) {
  const { tenant } = useAuth();
  const toast = useToast();
  const remindMut = useMutation(customersApi.markReminded);

  const trend = (d.month_trend ?? []).map(m => ({ month: m.label, sales: Number(m.total) }));

  const sendReminder = async (r: { id: string; name: string; phone: string | null; balance: number }) => {
    const lines = [
      `Dear ${r.name},`, '',
      `This is a friendly payment reminder from *${tenant?.name ?? 'us'}*.`,
      `Your outstanding balance is *₦${Number(r.balance).toLocaleString()}*.`,
      '', 'Kindly settle at your earliest convenience. Thank you! 🙏',
    ];
    window.open(whatsappLink(r.phone, lines.join('\n')), '_blank');
    const res = await remindMut.mutate(r.id);
    if (res !== null) { toast.success(`Marked ${r.name} as reminded.`); onReminded(); }
  };

  return (
    <>
      <div className="stat-cards">
        <StatCard icon={<ShoppingCart size={18} />} tone="blue" label="Total Sales"
          value={fmt(Number(d.total_sales ?? 0))} sub={`${num(Number(d.sales_count ?? 0))} transactions`} />
        <StatCard icon={<TrendingUp size={18} />} tone="green" label="Gross Profit"
          value={fmt(Number(d.gross_profit ?? 0))} sub="Revenue − COGS" />
        <StatCard icon={<AlertTriangle size={18} />} tone="red" label="Owed to you"
          value={fmt(Number(d.outstanding ?? 0))} sub="Unpaid customer balances" />
        <StatCard icon={<Truck size={18} />} tone="yellow" label="Purchases"
          value={fmt(Number(d.total_purchases ?? 0))} sub={`${num(Number(d.purchase_count ?? 0))} orders`} />
        <StatCard icon={<DollarSign size={18} />} tone="green" label="Expenses"
          value={fmt(Number(d.total_expenses ?? 0))} sub={`${num(Number(d.expense_count ?? 0))} logged`} />
        <StatCard icon={<Receipt size={18} />} tone="red" label="You owe suppliers"
          value={fmt(Number(d.creditors ?? 0))} sub="Unpaid purchase balances" />
      </div>

      <div className="dashboard-grid">
        {d.multi_branch && (d.by_branch ?? []).length > 0 && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}><Building2 size={16} /> Branches this month</h3>
            <div className="table-wrapper">
              <table className="dash-table">
                <thead>
                  <tr><th>Branch</th><th>Today</th><th>This month</th><th>Profit (month)</th><th>Owed to you</th><th>Low stock</th></tr>
                </thead>
                <tbody>
                  {(d.by_branch ?? []).map(b => (
                    <tr key={b.id}>
                      <td><strong>{b.name}</strong></td>
                      <td>{fmt(Number(b.today))}</td>
                      <td>{fmt(Number(b.month))}</td>
                      <td style={{ color: Number(b.month_profit) >= 0 ? '#16a34a' : '#dc2626', fontWeight: 600 }}>{fmt(Number(b.month_profit))}</td>
                      <td>{fmt(Number(b.outstanding))}</td>
                      <td>{Number(b.low_stock) > 0 ? <span className="badge-warning">{num(Number(b.low_stock))}</span> : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div className="card chart-card">
          <h3>Sales Trend</h3>
          {trend.length === 0 ? <p className="no-alerts">No sales recorded yet.</p> : (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={trend}>
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
          {(d.recent_sales ?? []).length === 0 ? <p className="no-alerts">No sales yet.</p> : (
            <table className="dash-table">
              <thead><tr><th>Customer</th><th>Amount</th><th>Status</th></tr></thead>
              <tbody>
                {(d.recent_sales ?? []).map(s => (
                  <tr key={s.id}>
                    <td>
                      {s.customer}
                      {d.multi_branch && s.branch && <div style={{ fontSize: '0.72rem', color: '#94a3b8' }}>{s.branch}</div>}
                    </td>
                    <td>{fmt(Number(s.total))}</td>
                    <td><span className={payBadge(s.status)}>
                      {s.status === 'full' ? 'Full' : s.status === 'unpaid' ? 'Unpaid' : 'Part'}
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <BellRing size={16} /> Debtor Reminders Due
          </h3>
          {(d.reminders ?? []).length === 0 ? (
            <p className="no-alerts">No reminders due — you're all caught up.</p>
          ) : (d.reminders ?? []).map(r => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '0.6rem 0', borderBottom: '1px solid #f1f5f9' }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>{r.name}</div>
                <div style={{ fontSize: '0.75rem', color: '#94a3b8' }}>
                  {fmt(Number(r.balance))} · {num(Number(r.days))} days overdue
                </div>
              </div>
              <button className="btn-secondary btn-sm" onClick={() => sendReminder(r)} disabled={remindMut.pending}>
                <MessageCircle size={13} /> Remind
              </button>
            </div>
          ))}
        </div>

        <LowStockCard items={d.low_stock ?? []} showBranch={!!d.multi_branch} />
      </div>
    </>
  );
}

export default function Dashboard() {
  const { tenant, profile } = useAuth();
  const { data, loading, error, refetch, isOffline } =
    useQuery<DashboardSummary>(() => dashboard.summary(), [], { cacheKey: 'dashboard-summary' });

  if (loading) return <Loading label="Loading dashboard…" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!data) return <ErrorState message="No dashboard data available." onRetry={refetch} />;

  const trialEnds = tenant?.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const trialDaysLeft = trialEnds ? Math.ceil((trialEnds.getTime() - Date.now()) / 86400000) : null;
  // The read-only banner in the shell already covers an expired account —
  // no need to say it twice.
  const showTrial = tenant?.plan === 'trial' && trialDaysLeft !== null && data.account_live;

  const role = data.role ?? profile?.role;

  return (
    <div className="dashboard">
      {isOffline && <OfflineBanner label="dashboard data" />}

      {showTrial && (
        <div className="alert alert-info" style={{ alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Sparkles size={16} />
            You have {trialDaysLeft} day{trialDaysLeft !== 1 ? 's' : ''} left on your free trial.
          </span>
          {role === 'admin' && <Link className="btn-primary btn-sm" to="/settings">Choose a plan</Link>}
        </div>
      )}

      {role === 'sales'
        ? <CashierDashboard d={data} />
        : role === 'inventory'
          ? <InventoryDashboard d={data} />
          : <OwnerDashboard d={data} onReminded={refetch} />}
    </div>
  );
}
