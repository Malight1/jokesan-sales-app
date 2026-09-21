import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { PLANS } from '../../lib/api';
import ScreenshotFrame from '../ScreenshotFrame';
import useMeta from '../useMeta';

const PROBLEMS: { problem: string; solution: React.ReactNode }[] = [
  { problem: "I sell for what feels right. I don't actually know my margin.",
    solution: <>Real <b>FIFO costing</b> on every sale, raw material through production to finished-goods COGS. Not an estimate.</> },
  { problem: 'Someone sent a fake bank alert and I only found out at closing.',
    solution: <><b>Paystack pay links</b> confirm themselves the moment a customer actually pays.</> },
  { problem: "My storekeeper's WhatsApp is my inventory system.",
    solution: <>Real-time stock and <b>WhatsApp invoices</b> sent from the system itself, not typed by hand.</> },
  { problem: 'One branch runs out while another has too much, and I never see it until it is a fire.',
    solution: <><b>Branches with their own stock</b>, transfers between them, a dashboard per role.</> },
  { problem: 'I have no idea what to reorder or when.',
    solution: <><b>Reorder suggestions</b> from real 90-day usage statistics and lead times.</> },
];

export default function Home() {
  useMeta(
    'StockFlow, Inventory & Sales for African SMEs',
    'Know your real profit, track stock, and chase debtors on WhatsApp. Real FIFO costing, offline POS, and NAFDAC-ready batch tracking, built for Nigerian manufacturers and traders.'
  );
  return (
    <>
      <section className="mkt-hero">
        <div className="mkt-hero__copy">
          <h1>Know your real profit, not just your sales total.</h1>
          <p>Real FIFO costing, WhatsApp invoices, and a till that keeps working with no internet.</p>
          <div className="mkt-hero__cta">
            <Link to="/login?signup=1" className="btn-primary btn-lg">Start free trial <ArrowRight size={16} /></Link>
            <a href="#how-it-helps" className="btn-secondary btn-lg">See how it helps</a>
          </div>
          <p className="mkt-hero__trust">14-day free trial. No card needed.</p>
        </div>
        <ScreenshotFrame src="/screenshots/dashboard.png" alt="StockFlow owner dashboard showing sales, profit and debtors" className="mkt-hero__shot" />
      </section>

      <section id="how-it-helps" className="mkt-section">
        <div className="mkt-section__head">
          <span className="mkt-eyebrow">The problem</span>
          <h2>Every one of these is a real reason a Nigerian SME loses money quietly.</h2>
        </div>
        <div className="mkt-pstable">
          {PROBLEMS.map((p, i) => (
            <div className="mkt-prow" key={i}>
              <div className="mkt-prow__problem">&ldquo;{p.problem}&rdquo;</div>
              <div className="mkt-prow__arrow"><ArrowRight size={16} /></div>
              <div className="mkt-prow__solution">{p.solution}</div>
            </div>
          ))}
        </div>
      </section>

      <section className="mkt-section mkt-section--alt">
        <div className="mkt-capabilities">
          <div className="mkt-capabilities__lead">
            <h2>Three things no spreadsheet or general selling app does for you.</h2>
            <p><Link to="/product">See the full tour of everything StockFlow does <ArrowRight size={14} /></Link></p>
          </div>
          <div className="mkt-capabilities__main">
            <ScreenshotFrame src="/screenshots/dashboard.png" alt="Know your real profit" />
            <h3>Know your real profit</h3>
            <p>FIFO costing tracked layer by layer, from the raw material you bought to the sale you rang up. Your dashboard shows what you actually made.</p>
          </div>
          <div className="mkt-capabilities__side">
            <div className="mkt-capabilities__item">
              <ScreenshotFrame src="/screenshots/pos.png" alt="Sell with no signal" />
              <h3>Sell with no signal</h3>
              <p>POS keeps working with no internet and syncs for real the moment you are back.</p>
            </div>
            <div className="mkt-capabilities__item">
              <ScreenshotFrame src="/screenshots/batches.png" alt="NAFDAC-ready tracking" />
              <h3>NAFDAC-ready tracking</h3>
              <p>Batch numbers, expiry dates, first-expiry-first-out picking, and a full recall trace.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="mkt-section">
        <div className="mkt-section__head">
          <h2>One plan for a solo owner, one for a growing team, one for multiple branches.</h2>
        </div>
        <div className="mkt-pricing">
          {PLANS.map(p => (
            <div className={`mkt-plan ${p.id === 'growth' ? 'mkt-plan--popular' : ''}`} key={p.id}>
              {p.id === 'growth' && <span className="mkt-plan__badge">Most popular</span>}
              <h3>{p.name}</h3>
              <div className="mkt-plan__price">&#8358;{p.price.toLocaleString()}<small>/month</small></div>
              <p className="mkt-plan__blurb">{p.blurb}, {p.users} user{p.users > 1 ? 's' : ''}</p>
              <ul>
                {p.features.map(f => <li key={f}><CheckCircle2 size={14} /> {f}</li>)}
              </ul>
              <Link to="/login?signup=1" className="btn-primary">Start free trial</Link>
            </div>
          ))}
        </div>
        <p className="mkt-pricing__note">Every plan starts with a 14-day free trial. <Link to="/pricing">See full pricing and FAQ <ArrowRight size={14} /></Link></p>
      </section>

      <section className="mkt-final-cta">
        <h2>Stop guessing your margin.</h2>
        <p>Start free for 14 days. No card required.</p>
        <Link to="/login?signup=1" className="btn-primary btn-lg">Start free trial <ArrowRight size={16} /></Link>
      </section>
    </>
  );
}
