import React from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';
import { useAuth } from '../lib/AuthContext';
import { Feature, planFor } from '../lib/features';
import './PlanLock.scss';

// Shown in place of a screen the business's plan doesn't include. Says
// what it is and what it's for, so the owner can decide; nothing is lost
// by being on a lower plan.
export default function PlanLock({ feature, title, children }: { feature: Feature; title: string; children: React.ReactNode }) {
  const { profile } = useAuth();
  const plan = planFor(feature);
  return (
    <section className="plan-lock" aria-label={`${title} is on the ${plan} plan`}>
      <span className="plan-lock-icon" aria-hidden="true"><Lock size={18} /></span>
      <div className="plan-lock-body">
        <span className="plan-lock-tag">{plan} plan</span>
        <h2>{title}</h2>
        <div className="plan-lock-text">{children}</div>
        {profile?.role === 'admin'
          ? <Link to="/settings?tab=billing" className="btn-primary">See plans</Link>
          : <p className="plan-lock-ask">Ask the owner to upgrade under Settings, Billing.</p>}
      </div>
    </section>
  );
}

/** One line for a small spot (a modal, a form) where a whole panel is too much. */
export function PlanNote({ children }: { children: React.ReactNode }) {
  return <p className="plan-note"><Lock size={13} aria-hidden="true" /> <span>{children}</span></p>;
}
