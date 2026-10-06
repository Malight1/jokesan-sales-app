import React from 'react';
import { PLANS, FOUNDING_SPOTS } from '../../lib/api';
import useMeta from '../useMeta';
import PlanCards from '../PlanCards';

const money = (n: number) => '₦' + n.toLocaleString();

const BILLING_FAQ = [
  { q: 'Do I need a card to start?', a: 'No. Every plan starts with a 14-day free trial. You only add a card when you choose a plan to continue on.' },
  { q: 'Can I switch plans later?', a: 'Yes, upgrade or downgrade any time from Settings. If you pay before your current plan runs out, the new time is added on to the end, so you never lose days you have paid for.' },
  { q: 'Can I pay yearly?', a: 'Yes. Pay for 10 months and get 12. You can choose monthly or yearly each time you pay.' },
  { q: 'What is the founding price?', a: `The first ${FOUNDING_SPOTS} businesses to subscribe keep the price they paid on day one for life, even when our prices go up later.` },
  { q: 'What happens to my data if I stop paying?', a: 'Your account moves to read-only rather than being deleted, so nothing you have recorded is lost while you decide.' },
  { q: 'Is Paystack safe to pay through?', a: 'Yes. ProfixBook never sees or stores your card details. Paystack handles the payment directly.' },
];

export default function Pricing() {
  // Reads the starting price from PLANS itself rather than a hardcoded
  // number, so this line can never drift from what's actually charged.
  const cheapest = PLANS[0];
  useMeta(
    'Pricing, ProfixBook',
    `Starter, Growth and Business plans from ${money(cheapest.price)}/month, or 2 months free when you pay yearly. Every plan starts with a 14-day free trial, no card required.`
  );
  return (
    <div className="mkt-pricing-page">
      <section className="mkt-section mkt-section--intro">
        <span className="mkt-eyebrow">Pricing</span>
        <h1>One plan for a small shop, one for a growing team, one for multiple branches.</h1>
        <p>Every plan includes the till, stock, purchases, WhatsApp invoices and real profit, for shops and manufacturers alike. Start with a 14-day free trial, no card required.</p>
      </section>

      <section className="mkt-section">
        <PlanCards showTrialNote />
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
