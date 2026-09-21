import React from 'react';
import { MessageCircle, CheckCircle2 } from 'lucide-react';
import { DashboardSummary, customers as customersApi } from '../../lib/api';
import { naira, count } from '../../pages/Dashboard';
import { useMutation } from '../../lib/hooks';
import { useAuth } from '../../lib/AuthContext';
import { whatsappLink } from '../../lib/whatsapp';
import { useToast } from '../../lib/ToastContext';

// Who owes me — question 4 of 4 (plan §1.1). Same WhatsApp-reminder flow as
// OwnerDashboard's "Needs your attention" panel (Dashboard.tsx), reused
// here rather than re-derived: build the message, open the WhatsApp link,
// mark reminded, refresh.
export default function DebtorsPanel({ d, onReminded }: { d: DashboardSummary; onReminded: () => void }) {
  const { tenant } = useAuth();
  const toast = useToast();
  const remindMut = useMutation(customersApi.markReminded);
  const debtors = (d.reminders ?? []).slice(0, 6);
  const outstanding = d.outstanding ?? 0;

  const sendReminder = async (r: { id: string; name: string; phone: string | null; balance: number }) => {
    const lines = [
      `Dear ${r.name},`, '',
      `This is a friendly payment reminder from *${tenant?.name ?? 'us'}*.`,
      `Your outstanding balance is *${naira(r.balance)}*.`,
      '', 'Kindly settle at your earliest convenience. Thank you!',
    ];
    window.open(whatsappLink(r.phone, lines.join('\n')), '_blank');
    const res = await remindMut.mutate(r.id);
    if (res !== null) { toast.success(`Marked ${r.name} as reminded.`); onReminded(); }
  };

  return (
    <section className="rt-panel" aria-labelledby="rt-debtors-title">
      <header className="rt-panel-head">
        <div>
          <h3 id="rt-debtors-title">Who owes you</h3>
          <p className="rt-panel-sub">{naira(outstanding)} out on credit, across all customers</p>
        </div>
      </header>
      {debtors.length === 0 ? (
        <div className="rt-empty is-good">
          <CheckCircle2 size={26} aria-hidden="true" />
          <p>No one owes you money right now.</p>
        </div>
      ) : (
        <ul className="rt-list">
          {debtors.map(r => (
            <li key={r.id}>
              <div className="rt-list-main">
                <span className="rt-list-title">{r.name}</span>
                <span className="rt-list-meta">{count(r.days)} days overdue</span>
              </div>
              <div className="rt-list-end">
                <span className="rt-num">{naira(r.balance)}</span>
                <button type="button" className="rt-btn rt-btn-ghost rt-btn-sm"
                  onClick={() => sendReminder(r)} disabled={remindMut.pending}>
                  <MessageCircle size={14} aria-hidden="true" /> Remind
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
