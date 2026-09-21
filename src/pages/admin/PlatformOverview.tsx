import React from 'react';
import { Link } from 'react-router-dom';
import { Building2, DollarSign, Wallet, LifeBuoy, UserMinus, AlertTriangle } from 'lucide-react';
import {
  AreaChart, Area, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { platform, PLANS } from '../../lib/api';
import { useQuery } from '../../lib/hooks';
import { Loading, ErrorState } from '../../components/DataStates';
import PlatformGate from '../../components/PlatformGate';

const COLORS = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2'];
const fmt = (n: number) => '₦' + (n || 0).toLocaleString();
const planPrice = (id: string) => PLANS.find(p => p.id === id)?.price ?? 0;

const attentionLabel: Record<string, string> = {
  trial_expiring: 'Trial expiring',
  renewal_due: 'Renewal due',
  past_due: 'Past due',
};

export default function PlatformOverview() {
  return <PlatformGate><Overview /></PlatformGate>;
}

function Overview() {
  const stats = useQuery(() => platform.overviewStats(), []);
  const signups = useQuery(() => platform.signupsSeries(12), []);
  const revenue = useQuery(() => platform.revenueSeries(12), []);
  const planDist = useQuery(() => platform.planDistribution(), []);
  const attention = useQuery(() => platform.needsAttention(), []);

  const loading = stats.loading || signups.loading || revenue.loading || planDist.loading || attention.loading;
  const error = stats.error || signups.error || revenue.error || planDist.error || attention.error;

  const mrr = (planDist.data ?? []).reduce((sum, p) => sum + (p.plan === 'trial' ? 0 : p.tenant_count * planPrice(p.plan)), 0);

  const signupsData = (signups.data ?? []).map(p => ({
    month: new Date(p.month).toLocaleDateString('en-GB', { month: 'short' }),
    signups: p.signups,
  }));
  const revenueData = (revenue.data ?? []).map(p => ({
    month: new Date(p.month).toLocaleDateString('en-GB', { month: 'short' }),
    revenue: p.revenue,
  }));
  const planData = (planDist.data ?? []).filter(p => p.tenant_count > 0).map(p => ({
    name: p.plan.charAt(0).toUpperCase() + p.plan.slice(1), value: p.tenant_count,
  }));

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Platform Overview</h1><p>How StockFlow is doing across every tenant</p></div>
      </div>

      {loading && <Loading label="Loading platform overview…" />}
      {error && <ErrorState message={error} onRetry={() => { stats.refetch(); signups.refetch(); revenue.refetch(); planDist.refetch(); attention.refetch(); }} />}

      {!loading && !error && stats.data && (
        <>
          <div className="stat-cards">
            <div className="stat-card">
              <div className="stat-icon blue"><Building2 size={18} /></div>
              <div className="stat-label">Tenants</div>
              <div className="stat-value">{stats.data.total_tenants}</div>
              <div className="stat-sub">{stats.data.active_tenants} active · {stats.data.trial_tenants} trial · {stats.data.suspended_tenants} suspended</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon green"><DollarSign size={18} /></div>
              <div className="stat-label">MRR</div>
              <div className="stat-value">{fmt(mrr)}</div>
              <div className="stat-sub">Monthly recurring revenue</div>
            </div>
            <div className="stat-card">
              <div className="stat-icon green"><Wallet size={18} /></div>
              <div className="stat-label">Revenue Collected</div>
              <div className="stat-value">{fmt(stats.data.revenue_this_month)}</div>
              <div className="stat-sub">This month</div>
            </div>
            <Link to="/platform/support" className="stat-card" style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
              <div className="stat-icon yellow"><LifeBuoy size={18} /></div>
              <div className="stat-label">Open Tickets</div>
              <div className="stat-value">{stats.data.open_tickets}</div>
              <div className="stat-sub">Awaiting a reply</div>
            </Link>
            <div className="stat-card">
              <div className="stat-icon red"><UserMinus size={18} /></div>
              <div className="stat-label">Churned</div>
              <div className="stat-value">{stats.data.churned_this_month}</div>
              <div className="stat-sub">Suspended this month</div>
            </div>
          </div>

          <div className="grid-2" style={{ marginTop: '1.5rem' }}>
            <div className="card">
              <h3 style={{ marginBottom: '1rem' }}>Signups, last 12 months</h3>
              {signupsData.every(d => d.signups === 0) ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No signups yet.</p> : (
                <ResponsiveContainer width="100%" height={260}>
                  <AreaChart data={signupsData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis allowDecimals={false} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip />
                    <Area type="monotone" dataKey="signups" name="Signups" stroke="#2563eb" fill="#2563eb" fillOpacity={0.15} />
                  </AreaChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="card">
              <h3 style={{ marginBottom: '1rem' }}>Revenue collected, last 12 months</h3>
              {revenueData.every(d => d.revenue === 0) ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No payments recorded yet.</p> : (
                <ResponsiveContainer width="100%" height={260}>
                  <BarChart data={revenueData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="month" tick={{ fontSize: 12 }} axisLine={false} tickLine={false} />
                    <YAxis tickFormatter={(v: any) => '₦' + (v / 1000) + 'k'} tick={{ fontSize: 11 }} axisLine={false} tickLine={false} />
                    <Tooltip formatter={(v: any) => fmt(v)} />
                    <Bar dataKey="revenue" name="Revenue" fill="#16a34a" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="grid-2" style={{ marginTop: '1.5rem' }}>
            <div className="card">
              <h3 style={{ marginBottom: '1rem' }}>Plan Distribution</h3>
              {planData.length === 0 ? <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>No tenants yet.</p> : (
                <ResponsiveContainer width="100%" height={240}>
                  <PieChart>
                    <Pie data={planData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={85}
                      label={({ name, percent }: any) => `${name} ${((percent || 0) * 100).toFixed(0)}%`}>
                      {planData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                    </Pie>
                    <Tooltip />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
            <div className="card">
              <h3 style={{ marginBottom: '1rem' }}>Needs Attention</h3>
              {(attention.data ?? []).length === 0 ? (
                <p style={{ color: '#94a3b8', fontSize: '0.875rem' }}>Nothing needs attention right now.</p>
              ) : (
                <div>
                  {(attention.data ?? []).map((a, i) => (
                    <Link key={i} to={`/platform/tenants/${a.tenant_id}`}
                      style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', padding: '0.65rem 0', borderBottom: '1px solid #f1f5f9', color: 'inherit', textDecoration: 'none' }}>
                      <AlertTriangle size={15} color={a.kind === 'past_due' ? '#dc2626' : '#d97706'} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: '0.875rem', fontWeight: 600 }}>{a.tenant_name}</div>
                        <div style={{ fontSize: '0.78rem', color: '#64748b' }}>{attentionLabel[a.kind]} · {a.detail}</div>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
