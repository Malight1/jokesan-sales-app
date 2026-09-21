import React from 'react';
import { DashboardSummary } from '../../lib/api';
import TakingsHero from '../components/TakingsHero';
import StockValueCard from '../components/StockValueCard';
import DebtorsPanel from '../components/DebtorsPanel';
import RestockList from '../components/RestockList';
import DeadStockList from '../components/DeadStockList';
import MoversChart from '../components/MoversChart';
import '../RetailDashboard.scss';

// The retail owner's dashboard: today first, week second, and the
// insight the manufacturing dashboard never had — cash tied up on the
// shelf and what's dead there. Order follows plan §1.1's four questions:
// takings -> running out -> dead stock -> who owes me, with stock value
// standing beside the debt figure since both are "money not in hand yet."
export default function RetailDashboard({ d, onReminded }: {
  d: DashboardSummary; onReminded: () => void;
}) {
  return (
    <div className="rt">
      <TakingsHero d={d} />

      <div className="rt-row">
        <StockValueCard d={d} />
        <DebtorsPanel d={d} onReminded={onReminded} />
      </div>

      <RestockList d={d} />
      <DeadStockList d={d} />
      <MoversChart d={d} />
    </div>
  );
}
