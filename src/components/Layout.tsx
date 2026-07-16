import React, { useState, useEffect, useRef } from 'react';
import { NavLink, useLocation, useNavigate, Link } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingCart, Package, Truck,
  FlaskConical, DollarSign, Users, UserCheck, BarChart2, ArrowLeftRight, Bell, LogOut, Settings as SettingsIcon, Lightbulb, Monitor, Upload, ShieldCheck, Landmark, CloudOff, WifiOff, AlertTriangle, XCircle, Menu
} from 'lucide-react';
import { materials as materialsApi, finishedGoods as goodsApi, platform } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { canAccess } from '../lib/permissions';
import { useOnlineSync } from '../lib/useOnlineSync';
import PendingSyncPanel from './PendingSyncPanel';
import ConfirmDialog from './ConfirmDialog';
import '../styles/layout.scss';

const navItems = [
  {
    section: 'Overview',
    items: [
      { to: '/', label: 'Dashboard', icon: LayoutDashboard },
    ],
  },
  {
    section: 'Sales',
    items: [
      { to: '/pos', label: 'Point of Sale', icon: Monitor },
      { to: '/sales', label: 'Sales Orders', icon: ShoppingCart },
      { to: '/customers', label: 'Customers', icon: Users },
      { to: '/match-payment', label: 'Match Bank Payment', icon: Landmark },
    ],
  },
  {
    section: 'Production',
    items: [
      { to: '/production', label: 'Production', icon: FlaskConical },
      { to: '/finished-goods', label: 'Finished Goods', icon: Package },
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
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

const pageTitles: Record<string, string> = {
  '/': 'Dashboard',
  '/pos': 'Point of Sale',
  '/match-payment': 'Match Bank Payment',
  '/import': 'Import Data',
  '/sales': 'Sales Orders',
  '/customers': 'Customers',
  '/production': 'Production',
  '/finished-goods': 'Finished Goods',
  '/purchases': 'Purchases',
  '/inventory': 'Raw Materials',
  '/suppliers': 'Suppliers',
  '/expenses': 'Expenses',
  '/stock-movement': 'Stock Movement',
  '/reports': 'Reports',
  '/stock-alerts': 'Stock Alerts',
  '/insights': 'Smart Insights',
  '/settings': 'Settings',
  '/platform': 'Platform Admin',
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
  const { profile, tenant, signOut } = useAuth();
  const { data: mats } = useQuery(() => materialsApi.list(), []);
  const { data: fgoods } = useQuery(() => goodsApi.list(), []);
  const { data: isPlatformAdmin } = useQuery(() => platform.isAdmin().catch(() => false), []);
  const { online, pendingCount, failedCount, queue } = useOnlineSync();
  const [showSync, setShowSync] = useState(false);
  const [confirmSignOut, setConfirmSignOut] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  const handleSignOutClick = () => {
    if (pendingCount + failedCount > 0) setConfirmSignOut(true);
    else signOut();
  };

  // Low/out-of-stock items feeding the notification bell.
  const alertItems = [
    ...(mats ?? []).filter(m => m.qty_balance <= m.min_stock_level)
      .map(m => ({ id: 'm' + m.id, name: m.name, out: m.qty_balance === 0, kind: 'material' as const })),
    ...(fgoods ?? []).filter(g => g.qty_balance <= g.min_stock_level)
      .map(g => ({ id: 'g' + g.id, name: g.name, out: g.qty_balance === 0, kind: 'product' as const })),
  ].sort((a, b) => Number(b.out) - Number(a.out));
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

  const title = pageTitles[location.pathname] ?? 'StockFlow';
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

  const role = profile?.role;
  const tenantName = tenant?.name ?? 'StockFlow';
  const initial = (tenantName[0] ?? 'S').toUpperCase();
  const userName = profile?.full_name ?? 'User';
  const userInitial = (userName[0] ?? 'U').toUpperCase();

  // Only show sections/items this role may access.
  const visibleSections = navItems
    .map(sec => ({ ...sec, items: sec.items.filter(it => canAccess(role, it.to)) }))
    .filter(sec => sec.items.length > 0);

  // Platform owner gets an extra section (not part of the tenant role system).
  if (isPlatformAdmin) {
    visibleSections.push({ section: 'Platform', items: [{ to: '/platform', label: 'Platform Admin', icon: ShieldCheck }] });
  }

  return (
    <div className="app-shell">
      <div className={`sidebar-scrim${drawerOpen ? ' show' : ''}`} onClick={() => setDrawerOpen(false)} />
      <aside className={`sidebar${drawerOpen ? ' open' : ''}`}>
        <div className="sidebar-logo">
          <div className="logo-icon">{initial}</div>
          <div className="logo-text">
            <div className="name">{tenantName}</div>
            <div className="tagline">Powered by StockFlow</div>
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
                  end={to === '/'}
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
              <div className="user-role">{role ? roleLabels[role] : ''}</div>
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
                              <span className="notif-sub">{a.out ? 'Out of stock' : 'Low stock'} · {a.kind}</span>
                            </span>
                          </Link>
                        ))
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Settings */}
            {canAccess(role, '/settings') && (
              <button className="icon-btn" onClick={() => navigate('/settings')} aria-label="Settings" title="Settings">
                <SettingsIcon size={18} />
              </button>
            )}
          </div>
        </header>

        <main className="page-content">{children}</main>
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
