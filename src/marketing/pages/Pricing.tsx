import React from 'react';
import { PLANS, FOUNDING_SPOTS } from '../../lib/api';
import useMeta from '../useMeta';
import PlanCards from '../PlanCards';
import PlanGuide from '../PlanGuide';
import PlanCompare from '../PlanCompare';

const money = (n: number) => '₦' + n.toLocaleString();

const BILLING_FAQ = [
  { q: 'Is the Free plan really free?', a: 'Yes, for ever. One owner, one branch, up to 50 products and 100 sales a month. Move to Growth when you add staff or outgrow it.' },
  { q: 'Do I need a card to start?', a: 'No. You start with a 14-day free trial of everything. You only add a card when you choose a paid plan.' },
  { q: 'Can I switch plans later?', a: 'Yes, upgrade or downgrade any time from Settings. If you pay before your current plan runs out, the new time is added on to the end, so you never lose days you have paid for.' },
  { q: 'Can I pay yearly?', a: 'Yes. Pay for 10 months and get 12. You can choose monthly or yearly each time you pay.' },
  { q: 'What is the founding price?', a: `The first ${FOUNDING_SPOTS} businesses to subscribe keep the price they paid on day one for life, even when our prices go up later.` },
  { q: 'What happens if I stop paying?', a: 'You move to the Free plan. Nothing is deleted, and the owner can keep selling within Free’s limits. Staff can look but not save until you upgrade again.' },
  { q: 'Is Paystack safe to pay through?', a: 'Yes. ProfixBook never sees or stores your card details. Paystack handles the payment directly.' },
];

export default function Pricing() {
  // Reads the first paid price from PLANS itself rather than a hardcoded
  // number, so this line can never drift from what's actually charged.
  const firstPaid = PLANS.find(p => p.price > 0)!;
  useMeta(
    'Pricing, ProfixBook',
    `A free plan for one-person shops, then Growth from ${money(firstPaid.price)}/month and Business, with 2 months free when you pay yearly. Start with a 14-day free trial, no card required.`
  );
  return (
    <div className="mkt-pricing-page">
      <section className="mkt-section mkt-section--intro">
        <span className="mkt-eyebrow">Pricing</span>
        <h1>Free for a small shop, then a plan for a growing team and one for multiple branches.</h1>
        <p>Every plan includes the till, stock, WhatsApp invoices and real profit, for shops and manufacturers alike. Start with a 14-day free trial of everything, no card required.</p>
      </section>

      <section className="mkt-section">
        <PlanCards showTrialNote />
      </section>

      <section id="which-plan" className="mkt-section mkt-section--alt">
        <div className="mkt-section__head">
          <span className="mkt-eyebrow">Which plan?</span>
          <h2>Pick the plan for where your business is today.</h2>
          <p>Start small and move up when you outgrow it. Your records come with you.</p>
        </div>
        <PlanGuide />
      </section>

      <section id="compare" className="mkt-section">
        <div className="mkt-section__head">
          <span className="mkt-eyebrow">Compare plans</span>
          <h2>Everything each plan includes.</h2>
        </div>
        <PlanCompare />
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
