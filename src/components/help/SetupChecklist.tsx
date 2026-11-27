import React from 'react';
import { Link } from 'react-router-dom';
import { Check, X } from 'lucide-react';
import { useAuth } from '../../lib/AuthContext';
import { useQuery } from '../../lib/hooks';
import { setupStatus, SetupStatus } from '../../lib/api';
import { effectivePlan, hasFeature } from '../../lib/features';
import { isRetail } from '../../retail';
import { useHelpState, writeHelp } from '../../lib/helpState';
import './help.scss';

interface Step { id: string; name: string; why: string; done: boolean; to: string; action: string }

// "Get set up" card on a new owner's dashboard. Each step ticks itself off
// from the business's own records; the card goes once everything is done,
// or when the owner hides it.
export default function SetupChecklist() {
  const { tenant, profile } = useAuth();
  const help = useHelpState(profile?.id);
  const q = useQuery<SetupStatus | null>(() => setupStatus().catch(() => null), [], { cacheKey: 'setup-status' });
  if (profile?.role !== 'admin' || !tenant || help.checklistHidden || !q.data) return null;
  const s = q.data;
  const retail = isRetail(tenant);

  const steps: Step[] = [
    { id: 'bank', name: 'Add your bank details', why: 'Invoices, statements and WhatsApp reminders then show customers where to pay.',
      done: !!tenant.bank_details?.account_number, to: '/settings', action: 'Add details' },
    { id: 'products', name: retail ? 'Add your products' : 'Add your products and materials', why: 'Type them in, scan barcodes, or bring them all in from an Excel sheet.',
      done: s.products > 0, to: s.products > 0 ? '/finished-goods' : '/import', action: 'Add products' },
    ...(effectivePlan(tenant) !== 'free' ? [{ id: 'staff', name: 'Invite your staff', why: 'Each person gets their own login and only sees what their job needs.',
      done: s.staff > 1 || s.invites > 0, to: '/settings?tab=team', action: 'Invite' }] : []),
    { id: 'sale', name: 'Make your first sale', why: 'Ring it up at the till. Your dashboard starts showing profit straight away.',
      done: s.sales > 0, to: '/pos', action: 'Open the till' },
    ...(hasFeature(tenant, 'accounting') ? [{ id: 'money', name: 'Set your starting cash and bank balances', why: 'So Bank & Cash matches the money you really have.',
      done: s.moneyStarted > 0, to: '/money', action: 'Set balances' }] : []),
  ];
  const done = steps.filter(x => x.done).length;
  if (done === steps.length) return null;

  return (
    <section className="setup-card" aria-labelledby="setup-title">
      <div className="setup-top">
        <div>
          <h2 id="setup-title">Get set up</h2>
          <p>{done} of {steps.length} done. A few minutes now and ProfixBook is ready for your first day.</p>
        </div>
        <button type="button" className="close-btn" onClick={() => writeHelp(profile?.id, { checklistHidden: true })}
                aria-label="Hide the setup checklist" title="Hide this">
          <X size={18} />
        </button>
      </div>
      <div className="setup-bar" aria-hidden="true"><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ul className="setup-list">
        {steps.map(st => (
          <li key={st.id} className={`setup-item${st.done ? ' is-done' : ''}`}>
            <span className={`setup-mark${st.done ? ' is-done' : ''}`} aria-hidden="true">{st.done && <Check size={14} strokeWidth={3} />}</span>
            <span className="setup-text">
              <span className="setup-name">{st.name}<span className="sr-only">{st.done ? ', done' : ', not done yet'}</span></span>
              {!st.done && <span className="setup-why">{st.why}</span>}
            </span>
            {!st.done && <Link to={st.to} className="btn-secondary btn-sm">{st.action}</Link>}
          </li>
        ))}
      </ul>
    </section>
  );
}
