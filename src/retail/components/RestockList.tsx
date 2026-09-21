import React from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, XCircle, PackageSearch, CheckCircle2 } from 'lucide-react';
import { DashboardSummary } from '../../lib/api';
import { count } from '../../pages/Dashboard';

const num = (n: unknown) => Number(n) || 0;

// What's running out — question 2 of 4 (plan §1.1), actionable rather than
// a passive count: every row links straight to buying more.
export default function RestockList({ d }: { d: DashboardSummary }) {
  const items = (d.low_stock ?? []).filter(i => i.kind === 'finished_good');
  const noProducts = num(d.stock_value?.product_count) === 0;

  return (
    <section className="rt-panel" aria-labelledby="rt-restock-title">
      <header className="rt-panel-head">
        <div>
          <h3 id="rt-restock-title">Running out</h3>
          <p className="rt-panel-sub">Below their reorder level</p>
        </div>
        <Link to="/stock-alerts" className="rt-link">All alerts</Link>
      </header>

      {noProducts ? (
        <div className="rt-empty">
          <PackageSearch size={26} aria-hidden="true" />
          <p>You haven't added any products yet.</p>
          <Link to="/finished-goods" className="rt-link rt-empty-action">Add your first product</Link>
        </div>
      ) : items.length === 0 ? (
        <div className="rt-empty is-good">
          <CheckCircle2 size={26} aria-hidden="true" />
          <p>Every product is above its reorder level.</p>
        </div>
      ) : (
        <ul className="rt-list">
          {items.slice(0, 8).map((i, k) => {
            const out = num(i.qty) <= 0;
            const unit = i.unit ? ` ${i.unit}` : '';
            return (
              <li key={`${i.name}-${i.branch ?? ''}-${k}`}>
                <div className="rt-list-main">
                  <span className="rt-list-title">
                    <span className={`rt-flag ${out ? 'out' : 'low'}`}>
                      {out ? <XCircle size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
                      <span className="rt-sr-only">{out ? 'Out of stock:' : 'Low:'}</span>
                    </span>
                    {i.name}
                  </span>
                  <span className="rt-list-meta">Reorder at {count(i.min)}{unit}</span>
                </div>
                <div className="rt-list-end">
                  <span className={`rt-chip ${out ? 'bad' : 'warn'}`}>{out ? 'None left' : `${count(i.qty)}${unit} left`}</span>
                  <Link to="/purchases" className="rt-btn rt-btn-ghost rt-btn-sm">Buy</Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
