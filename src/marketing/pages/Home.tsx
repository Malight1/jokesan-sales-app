import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, CheckCircle2 } from 'lucide-react';
import { PLANS } from '../../lib/api';
import ScreenshotFrame from '../ScreenshotFrame';

const PROBLEMS: { problem: string; solution: React.ReactNode }[] = [
  { problem: "I sell for what feels right — I don't actually know my margin.",
    solution: <>Real <b>FIFO costing</b> on every sale, raw material through production to finished-goods COGS. Not an estimate.</> },
  { problem: 'Someone sent a fake bank alert and I only found out at closing.',
    solution: <><b>Paystack pay links</b> confirm themselves the moment a customer actually pays.</> },
  { problem: "My storekeeper's WhatsApp is my inventory system.",
    solution: <>Real-time stock, barcode scanning, and <b>WhatsApp invoices/reminders</b> sent from the system itself.</> },
  { problem: 'One branch runs out while another has too much, and I never see it until it’s a fire.',
    solution: <><b>Branches with their own stock</b>, transfers between them, a dashboard per role.</> },
  { problem: 'A customer wants 2 of 10 cartons back — I have no clean way to handle that.',
    solution: <><b>Partial returns</b>, credit notes, store credit. Not an all-or-nothing void.</> },
  { problem: 'I have no idea what to reorder or when.',
    solution: <><b>Reorder suggestions</b> from real 90-day usage statistics and lead times.</> },
  { problem: "I don't know if I'm ready for the new e-invoicing rules.",
    solution: <>A live <b>e-invoicing readiness score</b> against the actual NRS requirements.</> },
];

const CAPABILITIES = [
  { title: 'Know your real profit', img: '/screenshots/dashboard.png',
    body: "FIFO costing tracked layer by layer, from the raw material you bought to the sale you rang up. Your dashboard shows what you actually made — not a guess." },
  { title: 'Sell with no signal', img: '/screenshots/pos.png',
    body: 'Point of sale that keeps working with no internet, and syncs for real the moment you’re back. Branches keep their own stock, with transfers that preserve original cost.' },
  { title: 'NAFDAC-ready tracking', img: '/screenshots/batches.png',
    body: 'Batch numbers, manufacture and expiry dates, first-expiry-first-out picking, and a full recall trace — which batch went where, in one search.' },
];

const money = (n: number) => '₦' + n.toLocaleString();

export default function Home() {
  return (
    <>
      <section className="mkt-hero">
        <div className="mkt-hero__copy">
          <h1>Know your real profit — not just your sales total.</h1>
          <p>Real FIFO costing, WhatsApp invoices and reminders, and a till that keeps working with no internet — built for Nigerian manufacturers and traders, not adapted from somewhere else.</p>
          <div className="mkt-hero__cta">
            <Link to="/login?signup=1" className="btn-primary btn-lg">Start free trial <ArrowRight size={16} /></Link>
            <a href="#how-it-helps" className="btn-secondary btn-lg">See how it helps</a>
          </div>
          <p className="mkt-hero__trust">14-day free trial &middot; no card needed &middot; cancel anytime</p>
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
        <div className="mkt-section__head">
          <span className="mkt-eyebrow">What you get</span>
          <h2>Three things no spreadsheet or general selling app does for you.</h2>
          <p><Link to="/product">See the full tour of everything StockFlow does &rarr;</Link></p>
        </div>
        <div className="mkt-capabilities">
          {CAPABILITIES.map(c => (
            <div className="mkt-capability" key={c.title}>
              <ScreenshotFrame src={c.img} alt={c.title} />
              <h3>{c.title}</h3>
              <p>{c.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mkt-section">
        <div className="mkt-section__head">
          <span className="mkt-eyebrow">Pricing</span>
          <h2>One plan for a solo owner, one for a growing team, one for multiple branches.</h2>
        </div>
        <div className="mkt-pricing">
          {PLANS.map(p => (
            <div className={`mkt-plan ${p.id === 'growth' ? 'mkt-plan--popular' : ''}`} key={p.id}>
              {p.id === 'growth' && <span className="mkt-plan__badge">Most popular</span>}
              <h3>{p.name}</h3>
              <div className="mkt-plan__price">{money(p.price)}<small>/month</small></div>
              <p className="mkt-plan__blurb">{p.blurb} &middot; {p.users} user{p.users > 1 ? 's' : ''}</p>
              <ul>
                {p.features.map(f => <li key={f}><CheckCircle2 size={14} /> {f}</li>)}
              </ul>
              <Link to="/login?signup=1" className="btn-primary">Start free trial</Link>
            </div>
          ))}
        </div>
        <p className="mkt-pricing__note">Every plan starts with a 14-day free trial, no card required. <Link to="/pricing">See full pricing &amp; FAQ &rarr;</Link></p>
      </section>

      <section className="mkt-section mkt-section--alt">
        <div className="mkt-section__head">
          <span className="mkt-eyebrow">Questions</span>
          <h2>A few things people ask before they start.</h2>
        </div>
        <div className="mkt-faq-teaser">
          <div><h4>Does it work with no internet?</h4><p>Yes — the till queues sales offline and syncs for real the moment you’re back online.</p></div>
          <div><h4>Can each branch have its own stock?</h4><p>Yes — every branch keeps separate stock, with transfers between them that preserve original cost.</p></div>
          <div><h4>Is this ready for the new e-invoicing rules?</h4><p>StockFlow scores your readiness against the real NRS requirements and shows exactly what’s missing.</p></div>
        </div>
        <p className="mkt-pricing__note"><Link to="/faq">See all FAQs &rarr;</Link></p>
      </section>

      <section className="mkt-final-cta">
        <h2>Stop guessing your margin.</h2>
        <p>Start free for 14 days. No card required.</p>
        <Link to="/login?signup=1" className="btn-primary btn-lg">Start free trial <ArrowRight size={16} /></Link>
      </section>
    </>
  );
}
