import React from 'react';
import { CheckCircle2 } from 'lucide-react';
import { DashboardSummary } from '../../lib/api';
import { count } from '../../pages/Dashboard';

// What's dead on the shelf — question 3 of 4 (plan §1.1), and the one
// insight the app has never surfaced before: money sitting still.
export default function DeadStockList({ d }: { d: DashboardSummary }) {
  const items = d.movers?.dead_stock ?? [];
  const days = d.movers?.period_days ?? 30;

  return (
    <section className="rt-panel" aria-labelledby="rt-deadstock-title">
      <header className="rt-panel-head">
        <div>
          <h3 id="rt-deadstock-title">Sitting on the shelf</h3>
          <p className="rt-panel-sub">Hasn't sold in the last {days} days</p>
        </div>
      </header>

      {items.length === 0 ? (
        <div className="rt-empty is-good">
          <CheckCircle2 size={26} aria-hidden="true" />
          <p>Nothing sitting still — everything in stock has sold recently.</p>
        </div>
      ) : (
        <ul className="rt-list">
          {items.slice(0, 8).map(i => (
            <li key={i.product_id}>
              <div className="rt-list-main">
                <span className="rt-list-title">{i.name}</span>
                <span className="rt-list-meta">
                  {i.days_since_sale == null ? 'Never sold' : `Last sold ${count(i.days_since_sale)} days ago`}
                </span>
              </div>
              <div className="rt-list-end">
                <span className="rt-num">{count(i.on_hand)}{i.unit ? ` ${i.unit}` : ''}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
