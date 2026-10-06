import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Star } from 'lucide-react';
import { PLANS, ANNUAL_MONTHS_CHARGED, FOUNDING_SPOTS, BillingInterval, billing } from '../lib/api';

const money = (n: number) => '₦' + Math.round(n).toLocaleString();

// The plan cards shared by the home page and /pricing: a monthly/yearly
// switch, the founding-customer offer with a live spots count, and the
// three plans. Prices come from PLANS; the database charges the same.
export default function PlanCards({ showTrialNote = false }: { showTrialNote?: boolean }) {
  const [period, setPeriod] = useState<BillingInterval>('monthly');
  const [spotsLeft, setSpotsLeft] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    billing.spotsLeft().then(n => { if (live) setSpotsLeft(n); });
    return () => { live = false; };
  }, []);

  return (
    <>
      {spotsLeft !== 0 && (
        <p className="mkt-founding">
          <Star size={16} aria-hidden="true" />
          <span>
            <strong>Founding offer:</strong> the first {FOUNDING_SPOTS} businesses to subscribe keep these prices for life.
            {spotsLeft !== null && <> <strong className="mkt-founding__count">{spotsLeft} of {FOUNDING_SPOTS} spots left.</strong></>}
          </span>
        </p>
      )}

      <div className="mkt-period" role="group" aria-label="Billing period">
        <button type="button" aria-pressed={period === 'monthly'} onClick={() => setPeriod('monthly')}>Monthly</button>
        <button type="button" aria-pressed={period === 'annual'} onClick={() => setPeriod('annual')}>
          Yearly <span className="mkt-period__save">2 months free</span>
        </button>
      </div>

      <div className="mkt-pricing">
        {PLANS.map(p => {
          const yearly = p.price * ANNUAL_MONTHS_CHARGED;
          return (
            <div className={`mkt-plan ${p.id === 'growth' ? 'mkt-plan--popular' : ''}`} key={p.id}>
              {p.id === 'growth' && <span className="mkt-plan__badge">Most popular</span>}
              <h3>{p.name}</h3>
              {period === 'monthly' ? (
                <div className="mkt-plan__price">{money(p.price)}<small>/month</small></div>
              ) : (
                <>
                  <div className="mkt-plan__price">{money(yearly)}<small>/year</small></div>
                  <p className="mkt-plan__per">{money(yearly / 12)} a month, you save {money(p.price * 12 - yearly)}</p>
                </>
              )}
              <p className="mkt-plan__blurb">{p.blurb}</p>
              <ul>
                {p.features.map(f => <li key={f}><CheckCircle2 size={14} aria-hidden="true" /> {f}</li>)}
              </ul>
              <Link to="/login?signup=1" className={p.id === 'growth' ? 'btn-primary' : 'btn-secondary'}>Start free trial</Link>
              {showTrialNote && <p className="mkt-plan__trial">14-day free trial, no card required</p>}
            </div>
          );
        })}
      </div>
    </>
  );
}
