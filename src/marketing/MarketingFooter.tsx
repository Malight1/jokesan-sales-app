import React from 'react';
import { Link } from 'react-router-dom';
import { MessageCircle } from 'lucide-react';
import { whatsappLink } from '../lib/whatsapp';

export default function MarketingFooter() {
  return (
    <footer className="mkt-footer">
      <div className="mkt-footer__inner">
        <div className="mkt-footer__brand">
          <strong>StockFlow</strong>
          <p>Manufacturing &amp; sales, under control.</p>
        </div>

        <nav className="mkt-footer__links">
          <Link to="/product">Product</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/faq">FAQ</Link>
          <Link to="/login">Log in</Link>
        </nav>

        <nav className="mkt-footer__links">
          <Link to="/terms">Terms</Link>
          <Link to="/privacy">Privacy</Link>
          <a href={whatsappLink(null, 'Hi StockFlow, ')} target="_blank" rel="noreferrer" className="mkt-footer__whatsapp">
            <MessageCircle size={14} /> WhatsApp us
          </a>
        </nav>
      </div>
      <div className="mkt-footer__bottom">
        &copy; {new Date().getFullYear()} StockFlow. Built for Nigerian manufacturers and traders.
      </div>
    </footer>
  );
}
