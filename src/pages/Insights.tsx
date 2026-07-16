import React from 'react';
import { TrendingUp, TrendingDown, PackageX, Clock, AlertTriangle, Target, Lightbulb, CheckCircle2 } from 'lucide-react';
import {
  sales as salesApi, materials as materialsApi, finishedGoods as goodsApi,
  production as productionApi, stock, customers as customersApi,
  SalesOrder, Material, FinishedGood, ProductionRun, StockMovement, Customer,
} from '../lib/api';
import { useQuery } from '../lib/hooks';
import { Loading, ErrorState } from '../components/DataStates';
import './Insights.scss';

const fmt = (n: number) => '₦' + Math.round(n || 0).toLocaleString();
const daysAgo = (d: string) => Math.floor((Date.now() - new Date(d).getTime()) / 86400000);

type Severity = 'danger' | 'warning' | 'info' | 'success';
interface Insight {
  severity: Severity;
  icon: React.ReactNode;
  title: string;
  detail: React.ReactNode;
  action?: string;
}

export default function Insights() {
  const salesQ = useQuery<SalesOrder[]>(() => salesApi.list(), []);
  const matsQ = useQuery<Material[]>(() => materialsApi.list(), []);
  const goodsQ = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const prodQ = useQuery<ProductionRun[]>(() => productionApi.list(), []);
  const moveQ = useQuery<StockMovement[]>(() => stock.movements(1000), []);
  const custQ = useQuery<Customer[]>(() => customersApi.list(), []);

  const loading = salesQ.loading || matsQ.loading || goodsQ.loading || prodQ.loading || moveQ.loading;
  const error = salesQ.error || matsQ.error || goodsQ.error || prodQ.error || moveQ.error;

  if (loading) return <Loading label="Analysing your business…" />;
  if (error) return <ErrorState message={error} onRetry={() => { salesQ.refetch(); matsQ.refetch(); goodsQ.refetch(); prodQ.refetch(); moveQ.refetch(); }} />;

  const sales = (salesQ.data ?? []).filter(s => !s.voided);
  const mats = matsQ.data ?? [];
  const goods = goodsQ.data ?? [];
  const runs = (prodQ.data ?? []).filter(r => !r.voided);
  const moves = moveQ.data ?? [];
  const custs = custQ.data ?? [];

  const custName = (id: string | null) => {
    const c = custs.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer' : 'Walk-in';
  };

  const insights: Insight[] = [];

  // ---- 1. Margin erosion (cost rising faster than price) ----
  goods.forEach(g => {
    const gRuns = runs.filter(r => r.finished_good_id === g.id && r.unit_cost > 0)
      .sort((a, b) => new Date(a.production_date).getTime() - new Date(b.production_date).getTime());
    if (gRuns.length < 2 || g.selling_price <= 0) return;
    const first = gRuns[0].unit_cost, last = gRuns[gRuns.length - 1].unit_cost;
    if (last <= first) return;
    const costRise = (last - first) / first;
    const markup = g.default_markup || 1.5;
    const targetPrice = Math.ceil((last * markup) / 50) * 50; // round up to ₦50
    const currentMargin = (g.selling_price - last) / g.selling_price;
    if (g.selling_price < last * markup && costRise > 0.03) {
      insights.push({
        severity: currentMargin < 0.2 ? 'danger' : 'warning',
        icon: <TrendingDown size={18} />,
        title: `${g.name}: margin is shrinking`,
        detail: <>Production cost rose <strong>{(costRise * 100).toFixed(0)}%</strong> (from {fmt(first)} to {fmt(last)}/unit) but your price is still {fmt(g.selling_price)}. Your margin is now only <strong>{(currentMargin * 100).toFixed(0)}%</strong>.</>,
        action: `Raise price to ${fmt(targetPrice)} to restore your ${((markup - 1) * 100).toFixed(0)}% markup.`,
      });
    }
  });

  // ---- 2. Reorder forecast (materials running out) ----
  const periodDays = 90;
  const since = Date.now() - periodDays * 86400000;
  mats.forEach(m => {
    const used = moves
      .filter(mv => mv.product_kind === 'material' && mv.product_id === m.id && mv.movement_type === 'PRODUCTION' && new Date(mv.created_at).getTime() > since)
      .reduce((s, mv) => s + Math.abs(mv.quantity), 0);
    if (used <= 0 || m.qty_balance <= 0) return;
    const daily = used / periodDays;
    const daysLeft = Math.floor(m.qty_balance / daily);
    if (daysLeft <= 21) {
      insights.push({
        severity: daysLeft <= 7 ? 'danger' : 'warning',
        icon: <Clock size={18} />,
        title: `${m.name} runs out in ~${daysLeft} day${daysLeft !== 1 ? 's' : ''}`,
        detail: <>You use about <strong>{daily.toFixed(1)} {m.unit ?? 'units'}/day</strong> and have <strong>{m.qty_balance.toLocaleString()} {m.unit ?? ''}</strong> left.</>,
        action: `Reorder ${m.name} now to avoid stopping production.`,
      });
    }
  });

  // ---- 3. Dead stock (finished goods not selling) ----
  goods.forEach(g => {
    if (g.qty_balance <= 0) return;
    const lastSale = moves
      .filter(mv => mv.product_kind === 'finished_good' && mv.product_id === g.id && mv.movement_type === 'SALE')
      .reduce<number>((max, mv) => Math.max(max, new Date(mv.created_at).getTime()), 0);
    const idle = lastSale === 0 ? 999 : daysAgo(new Date(lastSale).toISOString());
    if (idle >= 45) {
      insights.push({
        severity: 'warning',
        icon: <PackageX size={18} />,
        title: `${g.name}: ${lastSale === 0 ? 'never sold' : `no sale in ${idle} days`}`,
        detail: <><strong>{g.qty_balance.toLocaleString()}</strong> units sitting in stock — <strong>{fmt(g.selling_price * g.qty_balance)}</strong> of capital tied up.</>,
        action: `Run a promo or bundle ${g.name} to free up cash.`,
      });
    }
  });

  // ---- 4. Debtor aging ----
  const aged = sales.filter(s => s.balance > 0 && daysAgo(s.transaction_date) > 30);
  if (aged.length > 0) {
    const total = aged.reduce((s, x) => s + x.balance, 0);
    const worst = [...aged].sort((a, b) => daysAgo(b.transaction_date) - daysAgo(a.transaction_date))[0];
    insights.push({
      severity: 'danger',
      icon: <AlertTriangle size={18} />,
      title: `${fmt(total)} owed to you for over 30 days`,
      detail: <><strong>{aged.length}</strong> invoice{aged.length !== 1 ? 's' : ''} overdue. Oldest: <strong>{custName(worst.customer_id)}</strong> — {fmt(worst.balance)}, {daysAgo(worst.transaction_date)} days old.</>,
      action: 'Go to Reports → Debtors and send WhatsApp reminders.',
    });
  }

  // ---- 5. Profit trend (this month vs last) ----
  const monthKey = (d: string) => { const x = new Date(d); return x.getFullYear() * 12 + x.getMonth(); };
  const thisM = monthKey(new Date().toISOString());
  const cur = sales.filter(s => monthKey(s.transaction_date) === thisM);
  const prev = sales.filter(s => monthKey(s.transaction_date) === thisM - 1);
  const sum = (arr: SalesOrder[], k: keyof SalesOrder) => arr.reduce((s, x) => s + (Number(x[k]) || 0), 0);
  if (prev.length > 0 && cur.length > 0) {
    const curProfit = sum(cur, 'gross_profit'), prevProfit = sum(prev, 'gross_profit');
    const change = prevProfit !== 0 ? (curProfit - prevProfit) / Math.abs(prevProfit) : 0;
    insights.push({
      severity: change >= 0 ? 'success' : 'warning',
      icon: change >= 0 ? <TrendingUp size={18} /> : <TrendingDown size={18} />,
      title: `Profit is ${change >= 0 ? 'up' : 'down'} ${Math.abs(change * 100).toFixed(0)}% vs last month`,
      detail: <>This month: <strong>{fmt(curProfit)}</strong> gross profit from {cur.length} sales. Last month: {fmt(prevProfit)}.</>,
    });
  }

  // ---- 6. Best customer by profit ----
  const byCust: Record<string, number> = {};
  sales.forEach(s => { const k = s.customer_id ?? 'walkin'; byCust[k] = (byCust[k] || 0) + (s.gross_profit || 0); });
  const bestCust = Object.entries(byCust).sort((a, b) => b[1] - a[1])[0];
  if (bestCust && bestCust[1] > 0) {
    insights.push({
      severity: 'info',
      icon: <Target size={18} />,
      title: `Your most profitable customer: ${custName(bestCust[0] === 'walkin' ? null : bestCust[0])}`,
      detail: <>They've generated <strong>{fmt(bestCust[1])}</strong> in gross profit. Protect this relationship — offer priority service.</>,
    });
  }

  const sevOrder: Record<Severity, number> = { danger: 0, warning: 1, info: 2, success: 3 };
  insights.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);

  const actionCount = insights.filter(i => i.severity === 'danger' || i.severity === 'warning').length;

  return (
    <div className="insights-page">
      <div className="page-header">
        <div className="page-title">
          <h1>Smart Insights</h1>
          <p>{insights.length === 0 ? 'Not enough data yet — record more sales & production.' : `${actionCount} thing${actionCount !== 1 ? 's' : ''} needing your attention`}</p>
        </div>
      </div>

      {insights.length === 0 ? (
        <div className="card" style={{ textAlign: 'center', padding: '3rem 1rem' }}>
          <Lightbulb size={30} color="#2563eb" style={{ marginBottom: '0.5rem' }} />
          <h3>Insights appear as you trade</h3>
          <p style={{ color: '#64748b', fontSize: '0.9rem', marginTop: '0.35rem' }}>
            Once you have a few weeks of purchases, production and sales, StockFlow will spot cost creep, reorder timing, slow stock and overdue debts automatically.
          </p>
        </div>
      ) : (
        <div className="insight-grid">
          {insights.map((ins, i) => (
            <div key={i} className={`insight-card ${ins.severity}`}>
              <div className="insight-head">
                <span className="insight-icon">{ins.icon}</span>
                <h3>{ins.title}</h3>
              </div>
              <p className="insight-detail">{ins.detail}</p>
              {ins.action && (
                <div className="insight-action">
                  <CheckCircle2 size={14} />
                  <span>{ins.action}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
