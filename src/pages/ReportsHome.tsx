import React from 'react';
import { Link } from 'react-router-dom';
import {
  TrendingUp, ArrowLeftRight, Scale, Receipt, ShoppingBag, Trophy, Tag, Undo2, Users,
  Package, Wallet, Truck, FolderDown, Lock, ChevronRight,
} from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { hasFeature, planFor } from '../lib/features';
import { REPORTS, GROUPS, ReportId } from './reportCatalog';
import './ReportsHome.scss';

const ICONS: Record<ReportId, React.ComponentType<{ size?: number }>> = {
  pnl: TrendingUp, cashflow: ArrowLeftRight, balance: Scale, vat: Receipt,
  sales: ShoppingBag, products: Trophy, discounts: Tag, returns: Undo2, debtors: Users,
  stock: Package, expenses: Wallet, creditors: Truck, accountant: FolderDown,
};

// Reports home: every report, grouped by what you want to find out.
export default function ReportsHome() {
  const { tenant } = useAuth();
  const shown = REPORTS.filter(r => (!r.vatOnly || tenant?.vat_enabled) && (!r.tiersOnly || hasFeature(tenant, 'price_tiers')));

  return (
    <div className="rh">
      <div className="page-header">
        <div className="page-title">
          <h1>Reports</h1>
          <p>Pick what you want to find out. Every report downloads as Excel or PDF.</p>
        </div>
      </div>

      {GROUPS.map(g => {
        const items = shown.filter(r => r.group === g.id);
        if (items.length === 0) return null;
        return (
          <section key={g.id} className="rh-group" aria-labelledby={`rh-${g.id}`}>
            <h2 id={`rh-${g.id}`}>{g.title}</h2>
            <div className={`rh-grid${g.id === 'accountant' ? ' is-wide' : ''}`}>
              {items.map(r => {
                const Icon = ICONS[r.id];
                const locked = !!r.feature && !hasFeature(tenant, r.feature);
                return (
                  <Link key={r.id} to={`/reports/${r.id}`} className={`rh-card${locked ? ' is-locked' : ''}`}>
                    <span className="rh-icon" aria-hidden="true"><Icon size={18} /></span>
                    <span className="rh-text">
                      <span className="rh-title">
                        {r.title}
                        {locked && <span className="rh-plan"><Lock size={11} aria-hidden="true" /> {planFor(r.feature!)}</span>}
                      </span>
                      <span className="rh-question">{r.question}</span>
                    </span>
                    <ChevronRight size={16} className="rh-go" aria-hidden="true" />
                  </Link>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
