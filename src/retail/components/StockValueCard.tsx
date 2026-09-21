import React from 'react';
import { Link } from 'react-router-dom';
import { Lock, PackageSearch } from 'lucide-react';
import { DashboardSummary } from '../../lib/api';
import { naira, count } from '../../pages/Dashboard';

// The standing figure the manufacturing dashboard never surfaces: how much
// cash is sitting on the shelf right now, at cost (not what it would sell
// for). retail_stock_value() (migration 0046) returns null for value_at_cost
// when the caller isn't accounts/admin — this dashboard only ever renders
// for that role, but the null case is handled anyway rather than assumed away.
export default function StockValueCard({ d }: { d: DashboardSummary }) {
  const sv = d.stock_value;
  const value = sv?.value_at_cost;

  return (
    <section className="rt-panel" aria-labelledby="rt-stockvalue-title">
      <header className="rt-panel-head">
        <div>
          <h3 id="rt-stockvalue-title">Cash tied up in stock</h3>
          <p className="rt-panel-sub">Valued at what you paid, not what you'll sell it for</p>
        </div>
      </header>

      {!sv || value === null || value === undefined ? (
        <div className="rt-empty">
          <Lock size={26} aria-hidden="true" />
          <p>Only visible to accounts and admin.</p>
        </div>
      ) : sv.product_count === 0 ? (
        <div className="rt-empty">
          <PackageSearch size={26} aria-hidden="true" />
          <p>Nothing in stock yet.</p>
          <Link to="/finished-goods" className="rt-link rt-empty-action">Add your first product</Link>
        </div>
      ) : (
        <>
          <p className="rt-stat-value">{naira(value)}</p>
          <div className="rt-stat-row">
            <div className="rt-stat">
              <span className="rt-stat-label">Units on hand</span>
              <span className="rt-stat-num">{count(sv.units_on_hand)}</span>
            </div>
            <div className="rt-stat">
              <span className="rt-stat-label">Products stocked</span>
              <span className="rt-stat-num">{count(sv.product_count)}</span>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
