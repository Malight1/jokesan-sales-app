import React, { useState } from 'react';
import { DashboardView } from '../pages/Dashboard';
import { cashierFixture, inventoryFixture, ownerFixture } from './dashboardFixtures';

// DEVELOPMENT ONLY. App.tsx registers this route only when NODE_ENV is
// 'development', so it's stripped from production builds. It renders the
// three role dashboards from sample data, so the design can be checked
// without signing in as three different people.
//
//   /__dev/dashboards?role=sales|inventory|admin&single=1

type Role = 'sales' | 'inventory' | 'admin';

export default function DashboardPreview() {
  const params = new URLSearchParams(window.location.search);
  const [role, setRole] = useState<Role>((params.get('role') as Role) || 'sales');
  const [multi, setMulti] = useState(params.get('single') !== '1');

  const base = role === 'sales' ? cashierFixture : role === 'inventory' ? inventoryFixture : ownerFixture;
  const d = { ...base, multi_branch: multi };

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', padding: '1.5rem' }}>
      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, marginBottom: 20 }}>
          {(['sales', 'inventory', 'admin'] as const).map(r => (
            <button key={r} type="button" className={role === r ? 'btn-primary' : 'btn-secondary'} onClick={() => setRole(r)}>
              {r === 'sales' ? 'Cashier' : r === 'inventory' ? 'Storekeeper' : 'Owner'}
            </button>
          ))}
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 12, fontSize: 14 }}>
            <input type="checkbox" checked={multi} onChange={e => setMulti(e.target.checked)} /> Multi-branch company
          </label>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: '#64748b' }}>Development preview, sample data</span>
        </div>
        <DashboardView d={d} onRefresh={() => {}} />
      </div>
    </div>
  );
}
