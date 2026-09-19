import React, { useState } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { Building2, Menu, X } from 'lucide-react';

const LINKS = [
  { to: '/product', label: 'Product' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/faq', label: 'FAQ' },
];

export default function MarketingNav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="mkt-nav">
      <div className="mkt-nav__inner">
        <Link to="/" className="mkt-nav__brand" onClick={() => setOpen(false)}>
          <span className="mkt-nav__logo"><Building2 size={18} /></span>
          StockFlow
        </Link>

        <nav className="mkt-nav__links mkt-nav__links--desktop">
          {LINKS.map(l => (
            <NavLink key={l.to} to={l.to} className={({ isActive }) => isActive ? 'active' : ''}>{l.label}</NavLink>
          ))}
        </nav>

        <div className="mkt-nav__actions mkt-nav__actions--desktop">
          <Link to="/login" className="mkt-nav__login">Log in</Link>
          <Link to="/login?signup=1" className="btn-primary">Start free trial</Link>
        </div>

        <button className="mkt-nav__burger" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen(o => !o)}>
          {open ? <X size={22} /> : <Menu size={22} />}
        </button>
      </div>

      {open && (
        <div className="mkt-nav__mobile">
          {LINKS.map(l => (
            <NavLink key={l.to} to={l.to} onClick={() => setOpen(false)} className={({ isActive }) => isActive ? 'active' : ''}>{l.label}</NavLink>
          ))}
          <Link to="/login" onClick={() => setOpen(false)}>Log in</Link>
          <Link to="/login?signup=1" className="btn-primary" onClick={() => setOpen(false)}>Start free trial</Link>
        </div>
      )}
    </header>
  );
}
