import React, { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { ShoppingCart, ArrowUpRight, ArrowDownRight, Minus, BarChart3 } from 'lucide-react';
import { BarChart, Bar, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';
import { DashboardSummary } from '../../lib/api';
import { naira, lastSevenDays, greeting } from '../../pages/Dashboard';

const num = (n: unknown) => Number(n) || 0;

// Same "arrow + word, never colour alone" rule as the manufacturing
// dashboard's Delta, restyled for the dark ground.
function RtDelta({ now, before, vs, none }: { now: number; before: number; vs: string; none: string }) {
  if (before <= 0) return <span className="rt-delta flat">{none}</span>;
  const p = ((now - before) / before) * 100;
  if (Math.abs(p) < 1) {
    return <span className="rt-delta flat"><Minus size={14} aria-hidden="true" /> Same as {vs}</span>;
  }
  const up = p > 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`rt-delta ${up ? 'up' : 'down'}`}>
      <Icon size={14} aria-hidden="true" /> {up ? 'Up' : 'Down'} {Math.abs(p).toFixed(0)}% on {vs}
    </span>
  );
}

// What did I take today, against yesterday, with the week behind it. The
// anchor question of the whole dashboard (plan §1.1) — everything else
// sits below this.
export default function TakingsHero({ d }: { d: DashboardSummary }) {
  const week = useMemo(() => lastSevenDays(d.week_trend ?? []), [d.week_trend]);
  const best = week.reduce((b, w) => (w.total > b.total ? w : b), week[0]);
  const hasData = week.some(w => w.total > 0);
  const multi = !!d.multi_branch;

  return (
    <section className="rt-hero" aria-labelledby="rt-hero-title">
      <div>
        <p className="rt-hero-greet">{greeting()}</p>
        <h2 id="rt-hero-title" className="rt-hero-label">Today's takings{multi ? ', all branches' : ''}</h2>
        <p className="rt-hero-value">{naira(d.today_total)}</p>
        <p className="rt-hero-sub">
          <RtDelta now={num(d.today_total)} before={num(d.yesterday_total)} vs="yesterday" none="No sales yesterday to compare with" />
        </p>
        <div className="rt-hero-actions">
          <Link to="/pos" className="rt-btn rt-btn-accent"><ShoppingCart size={18} aria-hidden="true" /> Ring up a sale</Link>
          <Link to="/sales" className="rt-btn rt-btn-ghost">View sales</Link>
        </div>
      </div>

      <div className="rt-hero-chart">
        <p className="rt-hero-chart-label">Last 7 days</p>
        {!hasData ? (
          <div className="rt-empty" style={{ padding: '0.75rem 0' }}>
            <BarChart3 size={22} aria-hidden="true" />
            <p>No sales in the last 7 days yet.</p>
          </div>
        ) : (
          <div
            className="rt-chart"
            role="img"
            aria-label={`Takings over the last 7 days. The best day was ${best.long}, with ${naira(best.total)}.`}
          >
            <ResponsiveContainer width="100%" height={160}>
              <BarChart data={week} margin={{ top: 20, right: 4, left: 4, bottom: 0 }}>
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#92a1c2' }} axisLine={false} tickLine={false} />
                <YAxis hide />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.06)' }}
                  contentStyle={{ background: '#182642', border: '1px solid rgba(255,255,255,0.16)', borderRadius: 8, color: '#eef2fa' }}
                  formatter={(v: any) => naira(v)}
                  labelFormatter={(_: any, p: any) => p?.[0]?.payload?.long ?? ''}
                />
                <Bar dataKey="total" radius={[6, 6, 0, 0]} isAnimationActive={false}>
                  {week.map(w => <Cell key={w.key} fill={w.today ? '#22d3ee' : '#33415f'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </section>
  );
}
