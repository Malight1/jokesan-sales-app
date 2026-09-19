import React from 'react';
import MarketingNav from './MarketingNav';
import MarketingFooter from './MarketingFooter';
import './Marketing.scss';

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mkt">
      <MarketingNav />
      <main className="mkt-main">{children}</main>
      <MarketingFooter />
    </div>
  );
}
