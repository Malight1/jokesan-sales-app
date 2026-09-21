import React, { useState, useEffect, useRef } from 'react';
import { NavLink, useLocation, useNavigate, Link } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingCart, Package, Truck,
  FlaskConical, DollarSign, Users, UserCheck, BarChart2, ArrowLeftRight, Bell, LogOut, Settings as SettingsIcon, Lightbulb, Monitor, Upload, ShieldCheck, Landmark, CloudOff, WifiOff, AlertTriangle, XCircle, Menu, UserCircle, MapPin, Repeat, Layers, Receipt, Send, Sparkles, LifeBuoy, Building2
} from 'lucide-react';
import { stock, branches as branchesApi, StockLevel } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { accountState } from '../lib/accountState';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { canAccess } from '../lib/permissions';
import { useBranches } from '../lib/useBranches';
import { lowStockRows } from '../lib/branchStock';
import { useOnlineSync } from '../lib/useOnlineSync';
import PendingSyncPanel from './PendingSyncPanel';
import ConfirmDialog from './ConfirmDialog';
import { isRetail, label } from '../retail';
import '../styles/layout.scss';

const navItems = [
  {
    section: 'Overview',
    items: [
      { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
      { to: '/assistant', label: 'Ask StockFlow', icon: Sparkles },
    ],
  },
  {
    section: 'Sales',
    items: [
      { to: '/pos', label: 'Point of Sale', icon: Monitor },
      { to: '/sales', label: 'Sales Orders', icon: ShoppingCart },
      { to: '/quotes', label: 'Quotes', icon: Receipt },
      { to: '/deliveries', label: 'Deliveries', icon: Send },
      { to: '/customers', label: 'Customers', icon: Users },
      { to: '/match-payment', label: 'Match Bank Payment', icon: Landmark },
    ],
  },
  {
    section: 'Production',
    items: [
      { to: '/production', label: 'Production', icon: FlaskConical },
      { to: '/finished-goods', label: 'Finished Goods', icon: Package },
      { to: '/batches', label: 'Batches', icon: Layers },
      { to: '/transfers', label: 'Stock Transfers', icon: Repeat },
    ],
  },
  {
    section: 'Procurement',
    items: [
      { to: '/purchases', label: 'Purchases', icon: Truck },
      { to: '/inventory', label: 'Raw Materials', icon: Package },
      { to: '/suppliers', label: 'Suppliers', icon: UserCheck },
    ],
  },
  {
    section: 'Finance',
    items: [
      { to: '/expenses', label: 'Expenses', icon: DollarSign },
      { to: '/stock-movement', label: 'Stock Movement', icon: ArrowLeftRight },
      { to: '/reports', label: 'Reports', icon: BarChart2 },
      { to: '/insights', label: 'Smart Insights', icon: Lightbulb },
    ],
  },
  {
    section: 'Alerts',
    items: [
      { to: '/stock-alerts', label: 'Stock Alerts', icon: Bell },
    ],
  },
  {
    section: 'Admin',
    items: [
      { to: '/import', label: 'Import Data', icon: Upload },
      { to: '/audit', label: 'Audit Log', icon: ShieldCheck },
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
  {
    section: 'Help',
    items: [
      { to: '/support', label: 'Contact Support', icon: LifeBuoy },
    ],
  },
];

// Only meaningful when there's somewhere to send stock.
const MULTI_BRANCH_ONLY = new Set(['/transfers']);

// A retail tenant buys sellable stock directly (migration 0045) rather
// than manufacturing it from raw materials, so these two screens have
// nothing for it to do — see plan §1.3 / §3.6.
const MANUFACTURING_ONLY = new Set(['/production', '/inventory']);

const pageTitles: Record<string, string> = {
  '/dashboard': 'Dashboard',
  '/pos': 'Point of Sale',
  '/match-payment': 'Match Bank Payment',
  '/import': 'Import Data',
  '/sales': 'Sales Orders',
  '/quotes': 'Quotes',
  '/deliveries': 'Deliveries',
  '/customers': 'Customers',
  '/production': 'Production',
  '/finished-goods': 'Finished Goods',
  '/batches': 'Batches',
  '/transfers': 'Stock Transfers',
  '/purchases': 'Purchases',
  '/inventory': 'Raw Materials',
  '/suppliers': 'Suppliers',
  '/expenses': 'Expenses',
  '/stock-movement': 'Stock Movement',
  '/reports': 'Reports',
  '/stock-alerts': 'Stock Alerts',
  '/insights': 'Smart Insights',
  '/profile': 'My Profile',
  '/settings': 'Settings',
  '/audit': 'Audit Log',
  '/assistant': 'Ask StockFlow',
  '/support': 'Support',
  '/platform': 'Platform Overview',
  '/platform/tenants': 'Tenants',
  '/platform/payments': 'Payments',
  '/platform/support': 'Support Tickets',
};

const roleLabels: Record<string, string> = {
  admin: 'Administrator',
  sales: 'Sales',
  inventory: 'Inventory',
  accounts: 'Accounts',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const { profile, tenant, isPlatformAdmin, signOut } = useAuth();
  const role = profile?.role;
  const { multi, active, myBranchId, myBranchName } = useBranches();

  // Staff are alerted about their own branch's shelves; admin and accounts
  // about every branch. Quantities only — stock_levels() carries no costs.
  // A tenant-less platform admin (profile is null) has no branch to ask
  // about at all — stock.levels() is simply skipped for that account.
  const seeAll = role === 'admin' || role === 'accounts';
  const { data: levels } = useQuery<StockLevel[]>(
    () => (profile ? stock.levels(seeAll ? null : myBranchId) : Promise.resolve([])), [profile, seeAll, myBranchId]);
  const { online, pendingCount, failedCount, queue } = useOnlineSync();
  const [showSync, setShowSync] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  const handleSignOutClick = () => {
    if (pendingCount + failedCount > 0) setConfirmSignOut(true);
    else signOut();
  };

  // An admin's "working at" branch decides where their sales, purchases and
  // production are recorded. Every open screen is keyed to the old branch
  // (till stock, dashboard, alerts), so a full reload is the honest way to
  // make sure nothing stale is left showing.
  const switchBranch = async (id: string) => {
    if (!id || id === myBranchId) return;
    setSwitching(true);
    try {
      await branchesApi.setMine(id);
      window.location.reload();
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not switch branch.');
      setSwitching(false);
    }
  };

  // Low/out-of-stock items feeding the notification bell.
  const alertItems = lowStockRows(levels).map(l => ({
    id: `${l.branch_id}:${l.product_id}`,
    name: l.name,
    where: multi && seeAll ? l.branch_name : '',
    out: Number(l.qty) <= 0,
    kind: l.product_kind === 'material' ? 'material' : 'product',
  }));
  const alertCount = alertItems.length;

  // Close the notification dropdown on outside click / route change.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) setNotifOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  useEffect(() => { setNotifOpen(false); setDrawerOpen(false); }, [location.pathname]);

  const retail = isRetail(tenant);
  const title = (retail && location.pathname === '/finished-goods') ? 'Products' : pageTitles[location.pathname] ?? 'StockFlow';
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  const acct = accountState(tenant);
  // A platform admin's own account still has a tenant (every signup gets
  // one, even one created purely to be an admin) — but while they're
  // actually inside /platform/*, that tenant's own nav (POS, Production,
  // Raw Materials...) is irrelevant clutter, not a lighter version of the
  // app. Admin mode replaces the sidebar with just the platform tools
  // instead of appending them to an unrelated tenant's full nav.
  const inAdminMode = isPlatformAdmin && location.pathname.startsWith('/platform');
  const tenantName = inAdminMode ? 'StockFlow' : (tenant?.name ?? 'StockFlow');
  const initial = (tenantName[0] ?? 'S').toUpperCase();
  const userName = profile?.full_name ?? 'User';
  const userInitial = (userName[0] ?? 'U').toUpperCase();

  // Only show sections/items this role may access. A retail tenant also
  // loses Production and Raw Materials entirely (plan §1.3/§3.6) and gets
  // "Finished Goods" relabelled to "Products" via src/retail/labels.
  const visibleSections = inAdminMode ? [] : navItems
    .map(sec => ({
      ...sec,
      section: retail && sec.section === 'Production' ? 'Stock' : sec.section,
      items: sec.items
        .filter(it => canAccess(role, it.to) && (multi || !MULTI_BRANCH_ONLY.has(it.to)) && !(retail && MANUFACTURING_ONLY.has(it.to)))
        .map(it => it.to === '/finished-goods' ? { ...it, label: label(retail, it.label, 'Products') } : it),
    }))
    .filter(sec => sec.items.length > 0);

  // A shop's most-used screen is the till: Sales (Point of Sale first
  // within it) leads the whole sidebar in retail mode, ahead of Overview.
  if (retail) {
    const salesIdx = visibleSections.findIndex(s => s.section === 'Sales');
    if (salesIdx > 0) visibleSections.unshift(...visibleSections.splice(salesIdx, 1));
  }

  // Platform owner gets an extra section (not part of the tenant role
  // system) — the ONLY section at all once in admin mode.
  if (isPlatformAdmin) {
    visibleSections.push({
      section: 'Platform',
      items: [
        { to: '/platform', label: 'Overview', icon: ShieldCheck },
        { to: '/platform/tenants', label: 'Tenants', icon: Building2 },
        { to: '/platform/payments', label: 'Payments', icon: Receipt },
        { to: '/platform/support', label: 'Support Tickets', icon: LifeBuoy },
      ],
    });
    // Only shown for an admin who ALSO runs a real tenant of their own —
    // a pure platform-admin account (no profile/tenant at all) has
    // nowhere to "go back" to.
    if (inAdminMode && tenant) {
      visibleSections.push({ section: 'My Business', items: [{ to: '/dashboard', label: 'Back to my dashboard', icon: LayoutDashboard }] });
    }
  }

  return (
    <div className="app-shell">
      <div className={`sidebar-scrim${drawerOpen ? ' show' : ''}`} onClick={() => setDrawerOpen(false)} />
      <aside className={`sidebar${drawerOpen ? ' open' : ''}`}>
        <div className="sidebar-logo">
          <div className="logo-icon">{initial}</div>
          <div className="logo-text">
            <div className="name">{tenantName}</div>
            <div className="tagline">{inAdminMode ? 'Platform Admin' : (multi ? myBranchName : 'Powered by StockFlow')}</div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {visibleSections.map(({ section, items }) => (
            <div className="nav-section" key={section}>
              <div className="nav-label">{section}</div>
              {items.map(({ to, label, icon: Icon }) => (
                <NavLink
                  key={to}
                  to={to}
                  end={to === '/' || to === '/platform'}
                  className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}
                >
                  <Icon size={16} />
                  {label}
                  {to === '/stock-alerts' && alertCount > 0 && (
                    <span className="nav-badge">{alertCount}</span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            <div className="avatar">{userInitial}</div>
            <div className="user-meta">
              <div className="user-name">{userName}</div>
              <div className="user-role">{inAdminMode ? 'Platform Admin' : (role ? roleLabels[role] : '')}</div>
            </div>
            <button className="signout-btn" onClick={handleSignOutClick} title="Sign out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main-content">
        <header className="topbar">
          <div className="topbar-left" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <button className="topbar-menu-btn" onClick={() => setDrawerOpen(true)} aria-label="Open menu">
              <Menu size={20} />
            </button>
            <h2>{title}</h2>
          </div>
          <div className="topbar-right">
            {(!online || pendingCount > 0 || failedCount > 0) && (
              <button
                onClick={() => setShowSync(true)}
                className="date-badge"
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', border: 'none',
                  background: !online ? '#fef2f2' : failedCount > 0 ? '#fef2f2' : '#fffbeb',
                  color: !online || failedCount > 0 ? '#dc2626' : '#d97706',
                }}
                title="View pending sync"
              >
                {!online ? <WifiOff size={13} /> : <CloudOff size={13} />}
                {!online ? 'Offline' : `${pendingCount + failedCount} pending sync`}
              </button>
            )}

            {/* Branch — an admin chooses where they're working; staff just see theirs */}
            {multi && (role === 'admin' ? (
              <label
                className="date-badge"
                style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                title="Where your sales, purchases and production are recorded"
              >
                <MapPin size={13} />
                <select
                  value={myBranchId ?? ''}
                  onChange={e => switchBranch(e.target.value)}
                  disabled={switching}
                  aria-label="Branch you're working at"
                  style={{ border: 'none', background: 'transparent', font: 'inherit', color: 'inherit', cursor: 'pointer', padding: 0 }}
                >
                  {active.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            ) : (
              <span className="date-badge" style={{ display: 'flex', alignItems: 'center', gap: 6 }} title="Your branch">
                <MapPin size={13} /> {myBranchName}
              </span>
            ))}

            <span className="date-badge">{today}</span>

            {/* Notifications */}
            {canAccess(role, '/stock-alerts') && (
              <div className="notif-wrap" ref={notifRef}>
                <button
                  className={`icon-btn${notifOpen ? ' active-surface' : ''}`}
                  onClick={() => setNotifOpen(o => !o)}
                  aria-label={`Notifications${alertCount ? `, ${alertCount} stock alerts` : ''}`}
                  aria-expanded={notifOpen}
                >
                  <Bell size={18} />
                  {alertCount > 0 && <span className="icon-btn-badge">{alertCount > 9 ? '9+' : alertCount}</span>}
                </button>
                {notifOpen && (
                  <div className="notif-dropdown" role="menu">
                    <div className="notif-head">
                      <h3>Stock Alerts</h3>
                      <Link to="/stock-alerts">View all</Link>
                    </div>
                    <div className="notif-list">
                      {alertItems.length === 0 ? (
                        <div className="notif-empty">All stock levels are healthy.</div>
                      ) : (
                        alertItems.slice(0, 8).map(a => (
                          <Link key={a.id} to="/stock-alerts" className="notif-item">
                            <span className={`notif-dot ${a.out ? 'crit' : 'warn'}`}>
                              {a.out ? <XCircle size={15} /> : <AlertTriangle size={15} />}
                            </span>
                            <span className="notif-body">
                              <span className="notif-title">{a.name}</span>
                              <span className="notif-sub">
                                {a.out ? 'Out of stock' : 'Low stock'} · {a.kind}{a.where ? ` · ${a.where}` : ''}
                              </span>
                            </span>
                          </Link>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Profile — every role, so staff can change their own password */}
            <button className="icon-btn" onClick={() => navigate('/profile')} aria-label="My profile" title="My profile">
              <UserCircle size={18} />
            </button>

            {/* Settings */}
            {canAccess(role, '/settings') && (
              <button className="icon-btn" onClick={() => navigate('/settings')} aria-label="Settings" title="Settings">
                <SettingsIcon size={18} />
              </button>
            )}
          </div>
        </header>

        <main className="page-content">
          {!acct.live && (
            <div className="alert alert-warning" style={{ alignItems: 'flex-start', gap: 10, marginBottom: '1rem' }}>
              <AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <strong>Read-only — nothing can be saved right now.</strong>
                <div style={{ fontSize: '0.85rem', marginTop: 2 }}>{acct.message}</div>
              </div>
              {canAccess(role, '/settings') && (
                <Link className="btn-primary btn-sm" to="/settings" style={{ marginLeft: 'auto', flexShrink: 0 }}>
                  Billing
                </Link>
              )}
            </div>
          )}
          {children}
        </main>
      </div>

      {showSync && <PendingSyncPanel queue={queue} online={online} onClose={() => setShowSync(false)} />}

      {confirmSignOut && (
        <ConfirmDialog
          title="Unsynced sales pending"
          message={<>You have <strong>{pendingCount + failedCount}</strong> sale{pendingCount + failedCount !== 1 ? 's' : ''} not yet synced to the server. Signing out now will <strong>discard them</strong>. Click Cancel, then use the "pending sync" badge in the top bar to sync first if you'd rather not lose them.</>}
          confirmLabel="Sign out anyway"
          pending={false}
          onConfirm={() => { setConfirmSignOut(false); signOut(); }}
          onCancel={() => setConfirmSignOut(false)}
        />
      )}
    </div>
  );
}
