import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, ShoppingCart, Package, Truck,
  FlaskConical, DollarSign, Users, UserCheck, BarChart2, ArrowLeftRight, Bell, LogOut, Settings as SettingsIcon
} from 'lucide-react';
import { materials as materialsApi, finishedGoods as goodsApi } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { canAccess } from '../lib/permissions';
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
      { to: '/sales', label: 'Sales Orders', icon: ShoppingCart },
      { to: '/customers', label: 'Customers', icon: Users },
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
      { to: '/settings', label: 'Settings', icon: SettingsIcon },
    ],
  },
];

const pageTitles: Record<string, string> = {
  '/': 'Dashboard',
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
  '/settings': 'Settings',
};

const roleLabels: Record<string, string> = {
  admin: 'Administrator',
  sales: 'Sales',
  inventory: 'Inventory',
  accounts: 'Accounts',
};

export default function Layout({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const { profile, tenant, signOut } = useAuth();
  const { data: mats } = useQuery(() => materialsApi.list(), []);
  const { data: fgoods } = useQuery(() => goodsApi.list(), []);
  const alertCount =
    (mats ?? []).filter(m => m.qty_balance <= m.min_stock_level).length +
    (fgoods ?? []).filter(g => g.qty_balance <= g.min_stock_level).length;
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

  return (
    <div className="app-shell">
      <aside className="sidebar">
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
            <button className="signout-btn" onClick={signOut} title="Sign out">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main-content">
        <header className="topbar">
          <div className="topbar-left"><h2>{title}</h2></div>
          <div className="topbar-right">
            <span className="date-badge">{today}</span>
          </div>
        </header>

        <main className="page-content">{children}</main>
      </div>
    </div>
  );
}
