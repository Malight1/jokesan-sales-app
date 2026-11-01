import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, Store, Users, Building2 } from 'lucide-react';
import { PLANS } from '../lib/api';
import Reveal from './Reveal';

const money = (n: number) => '₦' + n.toLocaleString();

// Plain-language "which one is for me": what each plan is for and the moment
// an owner outgrows the one below it. The limits and tiers it describes are
// the ones enforced in plan_user_limit(), plan_branch_limit() and
// features.ts, so keep this in step with those.
const GUIDE: {
  id: (typeof PLANS)[number]['id'];
  icon: typeof Store;
  fit: string;
  picks: string[];
}[] = [
  {
    id: 'free',
    icon: Store,
    fit: 'One small shop, run by you.',
    picks: [
      'You sell from one location on your own and want to stop using a notebook or Excel.',
      'You have up to 50 products and make up to 100 sales a month.',
      'You want your till, stock and real profit in one place, at no cost.',
    ],
  },
  {
    id: 'growth',
    icon: Users,
    fit: 'Stock to protect, prices to control.',
    picks: [
      'You have staff on the till, more than 50 products, or more than 100 sales a month.',
      'You sell drugs, food or cosmetics, so you need expiry dates and batch numbers to stop expired stock being sold.',
      'You charge different customers different prices, or want a manager PIN on big discounts.',
      'You order from suppliers who deliver in parts, send quotes before a sale, or run up to three branches.',
    ],
  },
  {
    id: 'business',
    icon: Building2,
    fit: 'Many branches, more control.',
    picks: [
      'You run more than three branches, or need up to 15 staff logins.',
      'You want customer payments to confirm themselves through your own Paystack account.',
      'You want custom fields, an e-invoicing readiness check and priority support.',
    ],
  },
];

export default function PlanGuide({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`mkt-fit${compact ? ' mkt-fit--compact' : ''}`}>
      {GUIDE.map((g, i) => {
        const plan = PLANS.find(p => p.id === g.id)!;
        return (
          <Reveal key={g.id} delay={i * 70} className="mkt-fit__card">
            <div className="mkt-fit__head">
              <span className="mkt-fit__icon"><g.icon size={18} aria-hidden="true" /></span>
              <div>
                <h3>{plan.name}</h3>
                {!compact && <span className="mkt-fit__price">{plan.price === 0 ? 'Free for ever' : `${money(plan.price)} a month`}</span>}
              </div>
            </div>
            <p className="mkt-fit__line">{g.fit}</p>
            {!compact && (
              <ul>
                {g.picks.map(p => <li key={p}>{p}</li>)}
              </ul>
            )}
          </Reveal>
        );
      })}
      <p className="mkt-fit__note">
        {compact
          ? <Link to="/pricing#which-plan" className="mkt-link">Not sure which plan? See which fits you <ArrowRight size={14} aria-hidden="true" /></Link>
          : 'Not sure? Every feature is unlocked during your 14-day free trial. If you do not choose a plan, you move to Free and nothing is deleted.'}
      </p>
    </div>
  );
}
