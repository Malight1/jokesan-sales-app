import React from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2 } from 'lucide-react';
import { PLANS } from '../../lib/api';

const money = (n: number) => '₦' + n.toLocaleString();

const BILLING_FAQ = [
  { q: 'Do I need a card to start?', a: 'No. Every plan starts with a 14-day free trial — you only add a card when you choose a plan to continue on.' },
  { q: 'Can I switch plans later?', a: 'Yes, upgrade or downgrade any time from Settings — you\'re never locked into the plan you started on.' },
  { q: 'What happens to my data if I stop paying?', a: 'Your account moves to read-only rather than being deleted, so nothing you\'ve recorded is lost while you decide.' },
  { q: 'Is Paystack safe to pay through?', a: 'Yes — StockFlow never sees or stores your card details. Paystack handles the payment directly.' },
];

export default function Pricing() {
  return (
    <div className="mkt-pricing-page">
      <section className="mkt-section mkt-section--intro">
        <span className="mkt-eyebrow">Pricing</span>
        <h1>One plan for a solo owner, one for a growing team, one for multiple branches.</h1>
        <p>Every plan includes the full FIFO engine, WhatsApp invoices, and a 14-day free trial. No card required to start.</p>
      </section>

      <section className="mkt-section">
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
              <p className="mkt-plan__trial">14-day free trial, no card required</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mkt-section mkt-section--alt">
        <div className="mkt-section__head">
          <span className="mkt-eyebrow">Billing questions</span>
          <h2>Before you start a trial.</h2>
        </div>
        <div className="mkt-faq-teaser">
          {BILLING_FAQ.map(f => (
            <div key={f.q}><h4>{f.q}</h4><p>{f.a}</p></div>
          ))}
        </div>
      </section>
    </div>
  );
}
