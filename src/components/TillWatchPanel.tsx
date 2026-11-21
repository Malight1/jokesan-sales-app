import React from 'react';
import { Link } from 'react-router-dom';
import { Eye, HandCoins, Undo2 } from 'lucide-react';
import { tillWatch, team, TillWatchEntry, TeamMember } from '../lib/api';
import { useQuery } from '../lib/hooks';
import './TillWatchPanel.scss';

const fmt = (n: number) => '₦' + (Number(n) || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const when = (iso: string) => new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// The owner's eye on the till (migration 0054): every credit sale a
// cashier gave and every return a manager approved, last 7 days. Shown on
// the admin dashboard only when the business has cashiers or entries.
export default function TillWatchPanel() {
  const entriesQ = useQuery<TillWatchEntry[]>(() => tillWatch.recent(7).catch(() => []), []);
  const membersQ = useQuery<TeamMember[]>(() => team.members().catch(() => []), []);
  const entries = entriesQ.data ?? [];
  const custIds = Array.from(new Set(entries.map(e => e.meta?.customer_id).filter(Boolean))) as string[];
  const custQ = useQuery(() => tillWatch.customerNames(custIds).catch(() => []), [custIds.join(',')]);

  const hasCashiers = (membersQ.data ?? []).some(m => m.role === 'cashier');
  if (entriesQ.loading || membersQ.loading) return null;
  if (!hasCashiers && entries.length === 0) return null;

  const person = (id: string | null) => {
    const m = (membersQ.data ?? []).find(x => x.id === id);
    return m ? (m.full_name || m.email || 'A cashier') : 'A cashier';
  };
  const customer = (id: string | undefined) => {
    const c = (custQ.data ?? []).find(x => x.id === id);
    if (!c) return 'a customer';
    return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'a customer';
  };
  const credit = entries.filter(e => e.action === 'till_credit_sale');
  const creditTotal = credit.reduce((s, e) => s + Number(e.meta?.balance ?? 0), 0);

  return (
    <section className="tw" aria-labelledby="tw-title">
      <header className="tw-head">
        <div>
          <h3 id="tw-title"><Eye size={17} aria-hidden="true" /> Till watch</h3>
          <p>What cashiers did at the till in the last 7 days that needs your eye.</p>
        </div>
        <div className="tw-figure">
          <span>Credit given</span>
          <strong>{fmt(creditTotal)}</strong>
          <small>{credit.length} {credit.length === 1 ? 'sale' : 'sales'}</small>
        </div>
      </header>
      {entries.length === 0 ? (
        <p className="tw-empty">No credit sales or returns by cashiers this week.</p>
      ) : (
        <ul className="tw-list">
          {entries.map(e => (
            <li key={String(e.id)}>
              <span className={`tw-icon ${e.action === 'till_credit_sale' ? 'is-credit' : 'is-return'}`}>
                {e.action === 'till_credit_sale' ? <HandCoins size={15} /> : <Undo2 size={15} />}
              </span>
              <span className="tw-body">
                {e.action === 'till_credit_sale' ? (
                  <><strong>{person(e.user_id)}</strong> gave <strong>{fmt(e.meta?.balance)}</strong> credit to {customer(e.meta?.customer_id)}
                    {e.meta?.doc_no ? ` on ${e.meta.doc_no}` : ''} (paid {fmt(e.meta?.paid)} of {fmt(e.meta?.total)})</>
                ) : (
                  <><strong>{person(e.user_id)}</strong> did a return{e.meta?.return_doc_no ? ` (${e.meta.return_doc_no})` : ''}, approved by <strong>{person(e.meta?.approved_by ?? null)}</strong></>
                )}
              </span>
              <span className="tw-when">{when(e.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
      <footer className="tw-foot"><Link to="/audit">Full audit log</Link> · <Link to="/customers">See who owes you</Link></footer>
    </section>
  );
}
