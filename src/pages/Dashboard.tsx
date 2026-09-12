import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  ShoppingCart, Wallet, AlertTriangle, XCircle, CheckCircle2, FlaskConical, Truck, Repeat,
  ArrowUpRight, ArrowDownRight, Minus, MessageCircle, ArrowRight, Sparkles,
} from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, Cell, LabelList, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { dashboard, customers as customersApi, DashboardSummary, LowStockItem } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { whatsappLink } from '../lib/whatsapp';
import { useToast } from '../lib/ToastContext';
import { ErrorState } from '../components/DataStates';
import OfflineBanner from '../components/OfflineBanner';
import './Dashboard.scss';

// ------------------------------------------------------------------
// Three dashboards, one per job. The split is enforced on the server
// (dashboard_summary(), migrations 0018/0020): a cashier's payload never
// contains the P&L, so it can't leak into their browser.
//
// Design: flat surfaces, one accent (the locked brand blue), semantic
// colour only where it carries state and always paired with an icon or
// words, tabular figures so columns of naira line up.
//   Cashier      a till: one big number, two big buttons, touch-first
//   Storekeeper  a stock board: shelf health, then what to reorder
//   Owner        the business: month to date against the same days
//                last month, then what needs attention
// ------------------------------------------------------------------

const num = (n: unknown) => Number(n) || 0;
export const naira = (n: unknown) => '₦' + Math.round(num(n)).toLocaleString('en-NG');
export const nairaShort = (n: unknown) => {
  const v = num(n);
  const a = Math.abs(v);
  if (a >= 1_000_000) return `₦${(v / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1)}m`;
  if (a >= 1_000) return `₦${Math.round(v / 1_000)}k`;
  return `₦${Math.round(v)}`;
};
const count = (n: unknown) => num(n).toLocaleString('en-NG');
const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${n === 1 ? one : many}`;
const shortDate = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
}

const dayKey = (dt: Date) =>
  `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;

// The server only returns days that had sales; a till chart needs the quiet
// days too, or a closed Sunday silently disappears from the week.
function lastSevenDays(trend: { day: string; total: number }[]) {
  const byDay = new Map(trend.map(t => [String(t.day).slice(0, 10), num(t.total)]));
  const out: { key: string; label: string; long: string; total: number; today: boolean }[] = [];
  for (let i = 6; i >= 0; i--) {
    const dt = new Date();
    dt.setDate(dt.getDate() - i);
    const key = dayKey(dt);
    out.push({
      key,
      total: byDay.get(key) ?? 0,
      today: i === 0,
      label: i === 0 ? 'Today' : dt.toLocaleDateString('en-GB', { weekday: 'short' }),
      long: i === 0 ? 'today' : dt.toLocaleDateString('en-GB', { weekday: 'long' }),
    });
  }
  return out;
}

// ------------------------------------------------------------------
// Shared pieces
// ------------------------------------------------------------------

function Panel({ title, sub, action, children }: {
  title: string; sub?: string; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="db-panel">
      <header className="db-panel-head">
        <div>
          <h3>{title}</h3>
          {sub && <p className="db-panel-sub">{sub}</p>}
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function Figure({ label, value, note, tone, to, bare }: {
  label: string; value: string; note?: React.ReactNode; tone?: 'warn'; to?: string; bare?: boolean;
}) {
  const cls = `db-fig${bare ? ' bare' : ''}${to ? ' is-link' : ''}`;
  const inner = (
    <>
      <span className="db-fig-label">{label}</span>
      <span className={`db-fig-value${tone ? ` ${tone}` : ''}`}>{value}</span>
      {note && <span className="db-fig-note">{note}</span>}
    </>
  );
  return to ? <Link to={to} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>;
}

// Direction is carried by an arrow AND a word, never by colour alone.
function Delta({ now, before, vs, none }: { now: number; before: number; vs: string; none: string }) {
  if (before <= 0) return <span className="db-delta flat">{none}</span>;
  const p = ((now - before) / before) * 100;
  if (Math.abs(p) < 1) {
    return <span className="db-delta flat"><Minus size={14} aria-hidden="true" /> Same as {vs}</span>;
  }
  const up = p > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`db-delta ${up ? 'up' : 'down'}`}>
      <Icon size={14} aria-hidden="true" /> {up ? 'Up' : 'Down'} {Math.abs(p).toFixed(0)}% on {vs}
    </span>
  );
}

const STATUS: Record<string, { label: string; cls: string }> = {
  full: { label: 'Paid', cls: 'paid' },
  part: { label: 'Part paid', cls: 'part' },
  unpaid: { label: 'Unpaid', cls: 'unpaid' },
};
function Status({ s }: { s: string }) {
  const x = STATUS[s] ?? { label: s, cls: 'part' };
  return <span className={`db-status ${x.cls}`}>{x.label}</span>;
}

function Empty({ text }: { text: string }) {
  return <p className="db-empty">{text}</p>;
}

function LowList({ items, showBranch = false, actions = false }: {
  items: LowStockItem[]; showBranch?: boolean; actions?: boolean;
}) {
  return (
    <ul className="db-list">
      {items.map((i, k) => {
        const out = num(i.qty) <= 0;
        const unit = i.unit ? ` ${i.unit}` : '';
        return (
          <li key={`${i.kind}-${i.name}-${i.branch ?? ''}-${k}`}>
            <div className="db-list-main">
              <span className="db-list-title">
                <span className={`db-flag ${out ? 'out' : 'low'}`}>
                  {out ? <XCircle size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
                  <span className="sr-only">{out ? 'Out of stock:' : 'Low:'}</span>
                </span>
                {i.name}
              </span>
              <span className="db-list-meta">
                {i.kind === 'material' ? 'Material' : 'Product'}, reorder at {count(i.min)}{unit}
                {showBranch && i.branch ? `, ${i.branch}` : ''}
              </span>
            </div>
            <div className="db-list-end">
              <span className={`db-num ${out ? 'is-out' : 'is-low'}`}>{out ? 'None left' : `${count(i.qty)}${unit} left`}</span>
              {actions && (
                <Link to={i.kind === 'material' ? '/purchases' : '/production'} className="db-btn db-btn-secondary db-btn-sm">
                  {i.kind === 'material' ? 'Buy' : 'Produce'}
                </Link>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

// Skeleton in the shape of what's coming, instead of a spinner.
function DashboardSkeleton() {
  return (
    <div className="db-skel" aria-busy="true" aria-label="Loading dashboard">
      <div className="db-skel-block db-skel-hero" />
      <div className="db-skel-row">
        <div className="db-skel-block db-skel-fig" />
        <div className="db-skel-block db-skel-fig" />
        <div className="db-skel-block db-skel-fig" />
      </div>
      <div className="db-skel-grid">
        <div className="db-skel-block db-skel-panel" />
        <div className="db-skel-block db-skel-panel" />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// CASHIER: a till. What I've sold, two big buttons, the shelf warnings.
// ------------------------------------------------------------------
export function CashierDashboard({ d }: { d: DashboardSummary }) {
  const { profile } = useAuth();
  const first = (profile?.full_name ?? '').trim().split(/\s+/)[0] ?? '';
  const multi = !!d.multi_branch;
  const where = multi ? d.branch_name ?? 'your branch' : 'the counter';
  const week = useMemo(() => lastSevenDays(d.week_trend ?? []), [d.week_trend]);
  const best = week.reduce((b, w) => (w.total > b.total ? w : b), week[0]);
  const lowGoods = (d.low_stock ?? []).filter(i => i.kind === 'finished_good');
  const mine = num(d.my_today_count);
  const unpaid = num(d.today_unpaid);
  const low = num(d.low_goods_count);

  return (
    <div className="db">
      <section className="db-till" aria-labelledby="db-till-title">
        <div className="db-till-main">
          <p className="db-till-greet">{greeting()}{first ? `, ${first}` : ''}</p>
          <h3 id="db-till-title" className="db-till-label">Your sales today</h3>
          <p className="db-till-value">{naira(d.my_today_total)}</p>
          <p className="db-till-sub">
            {mine === 0 ? 'No sales rung up yet' : `${plural(mine, 'sale')} rung up`}{multi ? ` at ${d.branch_name}` : ''}
          </p>
        </div>
        <div className="db-till-actions">
          <Link to="/pos" className="db-btn db-btn-primary db-btn-lg"><ShoppingCart size={20} aria-hidden="true" /> New sale</Link>
          <Link to="/sales" className="db-btn db-btn-ondark db-btn-lg"><Wallet size={20} aria-hidden="true" /> Record a payment</Link>
        </div>
      </section>

      <div className="db-strip">
        <Figure
          label={multi ? `${d.branch_name} today` : 'Counter today'}
          value={naira(d.today_total)}
          note={<Delta now={num(d.today_total)} before={num(d.yesterday_total)} vs="yesterday" none="No sales yesterday to compare with" />}
        />
        <Figure
          label="Left on credit today"
          value={naira(unpaid)}
          tone={unpaid > 0 ? 'warn' : undefined}
          note={unpaid > 0 ? 'Still to be collected' : 'Every sale today is paid'}
        />
        <Figure
          label="Products running low"
          value={count(low)}
          tone={low > 0 ? 'warn' : undefined}
          note={low > 0 ? 'See which ones' : 'Shelves look fine'}
          to="/stock-alerts"
        />
      </div>

      <div className="db-grid">
        <Panel title="Last 7 days" sub={`Everything sold at ${where}`}>
          {week.every(w => w.total === 0) ? <Empty text="No sales in the last 7 days yet." /> : (
            <div
              className="db-chart"
              role="img"
              aria-label={`Sales at ${where} over the last 7 days. The best day was ${best.long}, with ${naira(best.total)}.`}
            >
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={week} margin={{ top: 24, right: 4, left: 4, bottom: 0 }}>
                  <XAxis dataKey="label" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis hide />
                  <Tooltip
                    cursor={{ fill: '#f1f5f9' }}
                    formatter={(v: any) => naira(v)}
                    labelFormatter={(_: any, p: any) => p?.[0]?.payload?.long ?? ''}
                  />
                  <Bar dataKey="total" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                    {week.map(w => <Cell key={w.key} fill={w.today ? '#2563eb' : '#64748b'} />)}
                    <LabelList
                      dataKey="total"
                      position="top"
                      formatter={(v: any) => (num(v) > 0 ? nairaShort(v) : '')}
                      style={{ fontSize: 11, fill: '#334155', fontWeight: 600 }}
                    />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel
          title="Your recent sales"
          action={<Link to="/sales" className="db-link">All sales <ArrowRight size={14} aria-hidden="true" /></Link>}
        >
          {(d.my_recent ?? []).length === 0 ? <Empty text="Sales you ring up will appear here." /> : (
            <ul className="db-list">
              {(d.my_recent ?? []).map(s => (
                <li key={s.id}>
                  <div className="db-list-main">
                    <span className="db-list-title">{s.customer}</span>
                    <span className="db-list-meta">{shortDate(s.date)}</span>
                  </div>
                  <div className="db-list-end">
                    <span className="db-num">{naira(s.total)}</span>
                    <Status s={s.status} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>

      <Panel
        title={multi ? `Running low at ${d.branch_name}` : 'Running low'}
        action={<Link to="/stock-alerts" className="db-link">Stock alerts <ArrowRight size={14} aria-hidden="true" /></Link>}
      >
        {lowGoods.length === 0
          ? <Empty text="Every product is above its reorder level." />
          : <LowList items={lowGoods.slice(0, 6)} />}
      </Panel>
    </div>
  );
}

// ------------------------------------------------------------------
// STOREKEEPER: a stock board. Shelf health first, then what to reorder.
// No money anywhere on this screen.
// ------------------------------------------------------------------
const MOVEMENT: Record<string, string> = {
  PURCHASE: 'Bought in', PRODUCTION: 'Produced', SALE: 'Sold', ADJUSTMENT: 'Adjusted', TRANSFER: 'Transfer',
};

export function InventoryDashboard({ d }: { d: DashboardSummary }) {
  const multi = !!d.multi_branch;
  const total = num(d.stock_items);
  const out = num(d.out_of_stock_count);
  const lowAll = num(d.low_goods_count) + num(d.low_materials_count);
  const lowOnly = Math.max(0, lowAll - out);
  const healthy = Math.max(0, total - lowAll);

  return (
    <div className="db">
      <section className="db-head">
        <div>
          <h3 className="db-head-title">{multi ? `${d.branch_name} stock` : 'Stock today'}</h3>
          <p className="db-head-sub">{plural(total, 'item')} tracked{multi ? ' at this branch' : ''}</p>
        </div>
        <div className="db-head-actions">
          <Link to="/purchases" className="db-btn db-btn-primary"><Truck size={18} aria-hidden="true" /> Record purchase</Link>
          <Link to="/production" className="db-btn db-btn-secondary"><FlaskConical size={18} aria-hidden="true" /> Record production</Link>
          {multi && <Link to="/transfers" className="db-btn db-btn-secondary"><Repeat size={18} aria-hidden="true" /> Transfer</Link>}
        </div>
      </section>

      <section className="db-health" aria-labelledby="db-health-title">
        <h3 id="db-health-title" className="sr-only">Stock health</h3>
        {total > 0 && (
          <div className="db-health-bar" aria-hidden="true">
            {out > 0 && <span className="seg out" style={{ flexGrow: out }} />}
            {lowOnly > 0 && <span className="seg low" style={{ flexGrow: lowOnly }} />}
            {healthy > 0 && <span className="seg ok" style={{ flexGrow: healthy }} />}
          </div>
        )}
        <ul className="db-health-legend">
          <li className="out"><XCircle size={16} aria-hidden="true" /><strong>{count(out)}</strong> out of stock</li>
          <li className="low"><AlertTriangle size={16} aria-hidden="true" /><strong>{count(lowOnly)}</strong> below reorder level</li>
          <li className="ok"><CheckCircle2 size={16} aria-hidden="true" /><strong>{count(healthy)}</strong> healthy</li>
        </ul>
      </section>

      <div className="db-grid">
        <Panel
          title="Needs reordering"
          sub="Emptiest first"
          action={<Link to="/stock-alerts" className="db-link">All alerts <ArrowRight size={14} aria-hidden="true" /></Link>}
        >
          {(d.low_stock ?? []).length === 0
            ? <Empty text="Nothing is below its reorder level." />
            : <LowList items={d.low_stock ?? []} actions />}
        </Panel>

        <div className="db-stack">
          <Panel title="This month">
            <div className="db-pair">
              <Figure bare label="Produced" value={count(d.production_this_month)}
                note={plural(num(d.production_runs_this_month), 'run')} />
              <Figure bare label="Purchases not fully paid" value={count(d.open_purchases)}
                note={num(d.open_purchases) > 0 ? 'Accounts will settle these' : 'All settled'} />
            </div>
          </Panel>

          <Panel
            title="Latest movements"
            action={<Link to="/stock-movement" className="db-link">Ledger <ArrowRight size={14} aria-hidden="true" /></Link>}
          >
            {(d.recent_movements ?? []).length === 0 ? <Empty text="Purchases, production and sales show up here." /> : (
              <ul className="db-list">
                {(d.recent_movements ?? []).map(m => {
                  const q = num(m.qty);
                  return (
                    <li key={m.id}>
                      <div className="db-list-main">
                        <span className="db-list-title">{m.name ?? (m.kind === 'material' ? 'Material' : 'Product')}</span>
                        <span className="db-list-meta">{MOVEMENT[m.type] ?? m.type}, {shortDate(m.at)}</span>
                      </div>
                      <div className="db-list-end">
                        <span className={`db-num ${q < 0 ? 'is-neg' : 'is-pos'}`}>{q > 0 ? '+' : q < 0 ? '-' : ''}{count(Math.abs(q))}</span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------
// OWNER / ACCOUNTS: the business. Month to date against the same days
// last month, then what needs attention, then how each branch is doing.
// ------------------------------------------------------------------
export function OwnerDashboard({ d, onReminded }: { d: DashboardSummary; onReminded: () => void }) {
  const { tenant } = useAuth();
  const toast = useToast();
  const remindMut = useMutation(customersApi.markReminded);

  const multi = !!d.multi_branch;
  const monthSales = num(d.month_sales);
  const monthProfit = num(d.month_profit);
  const margin = monthSales > 0 ? (monthProfit / monthSales) * 100 : null;
  const net = monthProfit - num(d.month_expenses);
  const trend = (d.month_trend ?? []).map(m => ({ month: m.label, sales: num(m.total) }));
  const now = new Date();
  const period = `1 to ${now.getDate()} ${now.toLocaleDateString('en-GB', { month: 'long' })}`;
  const branches = d.by_branch ?? [];
  const maxMonth = Math.max(1, ...branches.map(b => num(b.month)));
  const lowTotal = num(d.low_goods_count) + num(d.low_materials_count);
  const reminders = (d.reminders ?? []).slice(0, 4);

  const sendReminder = async (r: { id: string; name: string; phone: string | null; balance: number }) => {
    const lines = [
      `Dear ${r.name},`, '',
      `This is a friendly payment reminder from *${tenant?.name ?? 'us'}*.`,
      `Your outstanding balance is *${naira(r.balance)}*.`,
      '', 'Kindly settle at your earliest convenience. Thank you!',
    ];
    window.open(whatsappLink(r.phone, lines.join('\n')), '_blank');
    const res = await remindMut.mutate(r.id);
    if (res !== null) { toast.success(`Marked ${r.name} as reminded.`); onReminded(); }
  };

  return (
    <div className="db">
      <section className="db-head">
        <div>
          <h3 className="db-head-title">This month</h3>
          <p className="db-head-sub">{multi ? `All branches, ${period}` : period}</p>
        </div>
        <div className="db-head-actions">
          <Link to="/reports" className="db-btn db-btn-secondary">Open reports <ArrowRight size={16} aria-hidden="true" /></Link>
        </div>
      </section>

      <div className="db-strip">
        <Figure
          label="Sales"
          value={naira(monthSales)}
          note={<Delta now={monthSales} before={num(d.last_month_sales)} vs="the same days last month"
            none="Nothing to compare with last month yet" />}
        />
        <Figure
          label="Gross profit"
          value={naira(monthProfit)}
          note={margin === null ? 'No sales yet this month' : `${margin.toFixed(1)}% of sales`}
        />
        <Figure
          label="Owed to you"
          value={naira(d.outstanding)}
          tone={num(d.outstanding) > 0 ? 'warn' : undefined}
          note="Unpaid customer balances"
          to="/reports"
        />
        <Figure label="You owe suppliers" value={naira(d.creditors)} note="Unpaid purchases" />
      </div>
      <p className="db-aside">
        Expenses this month <strong className="db-num">{naira(d.month_expenses)}</strong>
        <span className="db-aside-sep" aria-hidden="true" />
        Profit after expenses <strong className={`db-num${net < 0 ? ' is-neg' : ''}`}>{naira(net)}</strong>
      </p>

      <div className="db-grid db-grid-wide">
        <Panel title="Sales, last 12 months">
          {trend.length < 2 ? <Empty text="The trend appears once there are two months of sales." /> : (
            <div
              className="db-chart"
              role="img"
              aria-label={`Monthly sales for the last ${trend.length} months. This month so far: ${naira(monthSales)}.`}
            >
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={trend} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#e2e8f0" />
                  <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#64748b' }} axisLine={false} tickLine={false} />
                  <YAxis tickFormatter={(v: any) => nairaShort(v)} tick={{ fontSize: 11, fill: '#64748b' }}
                    axisLine={false} tickLine={false} width={56} />
                  <Tooltip formatter={(v: any) => naira(v)} />
                  <Area type="monotone" dataKey="sales" stroke="#2563eb" strokeWidth={2} fill="#2563eb" fillOpacity={0.1}
                    isAnimationActive={false} dot={false} activeDot={{ r: 4 }} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </Panel>

        <Panel title="Needs your attention">
          {reminders.length === 0 && lowTotal === 0 ? <Empty text="Nothing needs you right now." /> : (
            <ul className="db-list">
              {reminders.map(r => (
                <li key={r.id}>
                  <div className="db-list-main">
                    <span className="db-list-title">{r.name}</span>
                    <span className="db-list-meta">{naira(r.balance)} owed, {plural(num(r.days), 'day')} overdue</span>
                  </div>
                  <div className="db-list-end">
                    <button type="button" className="db-btn db-btn-secondary db-btn-sm"
                      onClick={() => sendReminder(r)} disabled={remindMut.pending}>
                      <MessageCircle size={15} aria-hidden="true" /> Remind
                    </button>
                  </div>
                </li>
              ))}
              {lowTotal > 0 && (
                <li>
                  <div className="db-list-main">
                    <span className="db-list-title">{plural(lowTotal, 'item')} low on stock</span>
                    <span className="db-list-meta">{multi ? 'Across all branches' : 'Below their reorder level'}</span>
                  </div>
                  <div className="db-list-end">
                    <Link to="/stock-alerts" className="db-btn db-btn-secondary db-btn-sm">Review</Link>
                  </div>
                </li>
              )}
            </ul>
          )}
        </Panel>
      </div>

      {multi && branches.length > 0 && (
        <Panel title="Branches this month">
          <div className="db-table-wrap">
            <table className="db-table">
              <thead>
                <tr>
                  <th scope="col">Branch</th>
                  <th scope="col" className="r">Today</th>
                  <th scope="col">This month</th>
                  <th scope="col" className="r">Profit</th>
                  <th scope="col" className="r">Owed to you</th>
                  <th scope="col" className="r">Low stock</th>
                </tr>
              </thead>
              <tbody>
                {branches.map(b => (
                  <tr key={b.id}>
                    <th scope="row">{b.name}</th>
                    <td className="r db-num">{naira(b.today)}</td>
                    <td>
                      <div className="db-share">
                        <span className="db-num">{naira(b.month)}</span>
                        <span className="db-share-bar" aria-hidden="true"
                          style={{ width: `${Math.round((num(b.month) / maxMonth) * 100)}%` }} />
                      </div>
                    </td>
                    <td className={`r db-num${num(b.month_profit) < 0 ? ' is-neg' : ''}`}>{naira(b.month_profit)}</td>
                    <td className="r db-num">{naira(b.outstanding)}</td>
                    <td className="r">
                      {num(b.low_stock) > 0
                        ? <span className="db-status part">{count(b.low_stock)} items</span>
                        : <span className="db-muted">None</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      <Panel
        title="Recent sales"
        action={<Link to="/sales" className="db-link">All sales <ArrowRight size={14} aria-hidden="true" /></Link>}
      >
        {(d.recent_sales ?? []).length === 0 ? <Empty text="Your first sale will show up here." /> : (
          <ul className="db-list">
            {(d.recent_sales ?? []).map(s => (
              <li key={s.id}>
                <div className="db-list-main">
                  <span className="db-list-title">{s.customer}</span>
                  <span className="db-list-meta">{shortDate(s.date)}{multi && s.branch ? `, ${s.branch}` : ''}</span>
                </div>
                <div className="db-list-end">
                  <span className="db-num">{naira(s.total)}</span>
                  <Status s={s.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

// Picks the view for the role the SERVER says this person has.
export function DashboardView({ d, onRefresh }: { d: DashboardSummary; onRefresh: () => void }) {
  if (d.role === 'sales') return <CashierDashboard d={d} />;
  if (d.role === 'inventory') return <InventoryDashboard d={d} />;
  return <OwnerDashboard d={d} onReminded={onRefresh} />;
}

export default function Dashboard() {
  const { tenant } = useAuth();
  const { data, loading, error, refetch, isOffline } =
    useQuery<DashboardSummary>(() => dashboard.summary(), [], { cacheKey: 'dashboard-summary' });

  if (loading && !data) return <DashboardSkeleton />;
  if (error && !data) return <ErrorState message={error} onRetry={refetch} />;
  if (!data) return <ErrorState message="The dashboard has nothing to show yet." onRetry={refetch} />;

  const trialEnds = tenant?.trial_ends_at ? new Date(tenant.trial_ends_at) : null;
  const trialDaysLeft = trialEnds ? Math.ceil((trialEnds.getTime() - Date.now()) / 86400000) : null;
  // The read-only banner in the shell already covers an expired account.
  const showTrial = tenant?.plan === 'trial' && trialDaysLeft !== null && trialDaysLeft > 0 && data.account_live;

  return (
    <>
      {isOffline && <OfflineBanner label="dashboard figures" />}
      {showTrial && (
        <div className="db-notice">
          <Sparkles size={16} aria-hidden="true" />
          <span>You have {plural(trialDaysLeft!, 'day')} left on your free trial.</span>
          {data.role === 'admin' && <Link className="db-btn db-btn-primary db-btn-sm" to="/settings">Choose a plan</Link>}
        </div>
      )}
      <DashboardView d={data} onRefresh={refetch} />
    </>
  );
}
