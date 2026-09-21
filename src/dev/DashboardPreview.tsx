import React, { useState } from 'react';
import { DashboardView } from '../pages/Dashboard';
import { DashboardSummary } from '../lib/api';
import {
  cashierFixture, inventoryFixture, ownerFixture, expiryFixture,
  retailOwnerFixture, retailEmptyFixture,
} from './dashboardFixtures';

// DEVELOPMENT ONLY. App.tsx registers this route only when NODE_ENV is
// 'development', so it's stripped from production builds. It renders each
// dashboard from sample data, so the design can be checked without signing
// in as five different people.
//
//   /__dev/dashboards?view=sales|inventory|admin|retail|retail-empty&single=1

type View = 'sales' | 'inventory' | 'admin' | 'retail' | 'retail-empty';

const FIXTURES: Record<View, DashboardSummary> = {
  sales: cashierFixture,
  inventory: inventoryFixture,
  admin: ownerFixture,
  retail: retailOwnerFixture,
  'retail-empty': retailEmptyFixture,
};

const LABELS: Record<View, string> = {
  sales: 'Cashier',
  inventory: 'Storekeeper',
  admin: 'Owner (manufacturing)',
  retail: 'Owner (retail)',
  'retail-empty': 'Owner (retail, day one)',
};

export default function DashboardPreview() {
  const params = new URLSearchParams(window.location.search);
  const [view, setView] = useState<View>((params.get('view') as View) || 'sales');
  const [multi, setMulti] = useState(params.get('single') !== '1');

  const base = FIXTURES[view];
  const d = { ...base, multi_branch: multi };
  // retail-empty stays fully empty regardless of the multi-branch toggle,
  // so the empty states can always be checked without extra clicks.
  if (view === 'retail-empty') d.multi_branch = false;

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: '1.5rem' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 20 }}>
          {(Object.keys(FIXTURES) as View[]).map(v => (
            <button key={v} type="button" className={view === v ? 'btn-primary' : 'btn-secondary'} onClick={() => setView(v)}>
              {LABELS[v]}
            </button>
          ))}
          {view !== 'retail-empty' && (
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 12, fontSize: 14 }}>
              <input type="checkbox" checked={multi} onChange={e => setMulti(e.target.checked)} /> Multi-branch company
            </label>
          )}
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>Development preview, sample data</span>
        </div>
        <DashboardView d={d} onRefresh={() => {}} expiry={expiryFixture} />
      </div>
    </div>
  );
}
