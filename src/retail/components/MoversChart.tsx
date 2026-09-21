import React from 'react';
import { Link } from 'react-router-dom';
import { TrendingUp } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { DashboardSummary } from '../../lib/api';
import { count } from '../../pages/Dashboard';

// Fast/slow sellers: a horizontal bar reads product names better than a
// vertical one once labels get long, and this list never exceeds 10 rows
// (retail_movers() already caps it server-side) — no pagination needed.
export default function MoversChart({ d }: { d: DashboardSummary }) {
  const items = (d.movers?.fast_movers ?? []).slice(0, 8);
  const days = d.movers?.period_days ?? 30;

  return (
    <section className="rt-panel" aria-labelledby="rt-movers-title">
      <header className="rt-panel-head">
        <div>
          <h3 id="rt-movers-title">Best sellers</h3>
          <p className="rt-panel-sub">Units sold in the last {days} days</p>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="rt-empty">
          <TrendingUp size={26} aria-hidden="true" />
          <p>Ring up a few sales to see your best sellers here.</p>
          <Link to="/pos" className="rt-link rt-empty-action">Go to Point of Sale</Link>
        </div>
      ) : (
        <div
          className="rt-chart"
          role="img"
          aria-label={`Best-selling products over the last ${days} days. Top seller: ${items[0].name}, ${count(items[0].qty_sold)} sold.`}
        >
          <ResponsiveContainer width="100%" height={Math.max(160, items.length * 34)}>
            <BarChart data={items} layout="vertical" margin={{ top: 4, right: 24, left: 4, bottom: 4 }}>
              <XAxis type="number" hide />
              <YAxis type="category" dataKey="name" width={120} tick={{ fontSize: 12, fill: '#92a1c2' }} axisLine={false} tickLine={false} />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.06)' }}
                contentStyle={{ background: '#182642', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, color: '#eef2fa' }}
                formatter={(v: any) => [`${count(v)} sold`, '']}
              />
              <Bar dataKey="qty_sold" radius={[0, 6, 6, 0]} isAnimationActive={false} fill="#22d3ee" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
