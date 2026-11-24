import React, { useState } from 'react';
import { X, FileDown, MessageCircle } from 'lucide-react';
import { debts, Statement } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { whatsappLink, hasBank } from '../lib/whatsapp';
import { exportReport } from '../lib/exporters';
import { todayIso } from '../lib/debts';
import Modal from './Modal';
import { Loading, ErrorState } from './DataStates';
import './StatementModal.scss';

const naira = (n: number) => (n < 0 ? '−' : '') + '₦' + Math.abs(Number(n) || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 });
const pretty = (d: string) => new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const monthsAgo = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() - n, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`; };

const RANGES = [
  { id: 'month', label: 'This month', from: () => monthsAgo(0) },
  { id: '3m', label: 'Last 3 months', from: () => monthsAgo(2) },
  { id: 'all', label: 'Everything', from: () => '' },
] as const;

// A customer statement (migration 0062): every invoice, payment, return and
// write-off for a period with a running balance, as a PDF or a WhatsApp
// message. The closing balance is exactly what they owe.
export default function StatementModal({ customerId, customerName, phone, onClose }: {
  customerId: string; customerName: string; phone: string | null; onClose: () => void;
}) {
  const { tenant } = useAuth();
  const toast = useToast();
  const [from, setFrom] = useState(monthsAgo(2));
  const [to, setTo] = useState(todayIso());
  const q = useQuery<Statement>(() => debts.statement(customerId, from || null, to || null), [customerId, from, to]);
  const st = q.data;
  const period = `${from ? pretty(from) : 'The start'} to ${pretty(to || todayIso())}`;

  const pdf = async () => {
    if (!st) return;
    const bank = tenant?.bank_details;
    try {
      await exportReport('pdf', {
        name: `statement-${customerName.replace(/\s+/g, '-').toLowerCase()}`,
        title: `Statement for ${customerName}`,
        business: tenant?.name ?? undefined,
        subtitle: period,
        tables: [{
          columns: [
            { header: 'Date', value: (r: any) => r.date },
            { header: 'Invoice', value: (r: any) => r.ref ?? '' },
            { header: 'What', value: (r: any) => r.what },
            { header: 'Amount', value: (r: any) => r.amount, money: true },
            { header: 'Balance', value: (r: any) => r.balance, money: true },
          ],
          rows: [
            ...(from ? [{ date: from, ref: '', what: 'Owed at the start', amount: '', balance: st.opening }] : []),
            ...st.lines,
          ],
        }],
        notes: [
          `${st.closing > 0 ? 'Amount owed' : st.closing < 0 ? 'In your favour' : 'Nothing owed'}: ${naira(Math.abs(st.closing))}`,
          ...(st.closing > 0 && hasBank(bank) ? [`Pay into ${bank!.bank_name}, ${bank!.account_number}${bank!.account_name ? `, ${bank!.account_name}` : ''}.`] : []),
        ],
      });
    } catch {
      toast.error('Could not build the statement. Please try again.');
    }
  };

  const whatsapp = () => {
    if (!st) return;
    const bank = tenant?.bank_details;
    const lines = [
      `Hello ${customerName}, here is your statement from ${tenant?.name ?? 'us'} (${period}).`,
      '',
      ...(from ? [`Owed at the start: ${naira(st.opening)}`] : []),
      ...st.lines.slice(-12).map(l => `${pretty(l.date)}  ${l.what}${l.ref ? ` ${l.ref}` : ''}  ${l.amount > 0 ? '+' : ''}${naira(l.amount)}`),
      ...(st.lines.length > 12 ? [`(${st.lines.length - 12} earlier lines in the PDF)`] : []),
      '',
      st.closing > 0 ? `Balance owed: ${naira(st.closing)}` : 'You owe nothing. Thank you!',
      ...(st.closing > 0 && hasBank(bank) ? ['', `Pay into: ${bank!.bank_name}`, `Account: ${bank!.account_number}`, ...(bank!.account_name ? [`Name: ${bank!.account_name}`] : [])] : []),
    ];
    window.open(whatsappLink(phone, lines.join('\n')), '_blank');
  };

  return (
    <Modal onClose={onClose} maxWidth={720}>
      <div className="modal-header">
        <h2>Statement for {customerName}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        <div className="stmt-range">
          <div className="stmt-chips" role="group" aria-label="Period">
            {RANGES.map(r => (
              <button key={r.id} type="button" className={from === r.from() && to === todayIso() ? 'is-on' : ''}
                      onClick={() => { setFrom(r.from()); setTo(todayIso()); }}>{r.label}</button>
            ))}
          </div>
          <div className="stmt-dates">
            <label>From <input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
            <label>To <input type="date" value={to} max={todayIso()} onChange={e => setTo(e.target.value || todayIso())} /></label>
          </div>
        </div>

        {q.loading && !st && <Loading label="Building the statement…" />}
        {q.error && <ErrorState message={q.error} onRetry={q.refetch} />}
        {st && (
          <>
            <table className="stmt-table">
              <thead>
                <tr><th>Date</th><th>What</th><th className="r">Amount</th><th className="r">Balance</th></tr>
              </thead>
              <tbody>
                {from && (
                  <tr className="stmt-open"><td>{pretty(from)}</td><td>Owed at the start</td><td /><td className="r">{naira(st.opening)}</td></tr>
                )}
                {st.lines.length === 0 && <tr><td colSpan={4} className="stmt-empty">Nothing happened in this period.</td></tr>}
                {st.lines.map((l, i) => (
                  <tr key={i}>
                    <td>{pretty(l.date)}</td>
                    <td>{l.what}{l.ref && <span className="stmt-ref">{l.ref}</span>}</td>
                    <td className={`r${l.amount < 0 ? ' is-less' : ''}`}>{l.amount > 0 ? naira(l.amount) : `(${naira(-l.amount)})`}</td>
                    <td className="r">{naira(l.balance)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className={`stmt-close${st.closing > 0 ? ' is-owed' : ''}`}>
              <span>{st.closing > 0 ? `${customerName} owes you` : st.closing < 0 ? 'You owe them' : 'Nothing owed'}</span>
              <strong>{naira(Math.abs(st.closing))}</strong>
            </div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={pdf} disabled={!st}><FileDown size={16} /> Download PDF</button>
        <button type="button" className="btn-primary" onClick={whatsapp} disabled={!st}><MessageCircle size={16} /> Send on WhatsApp</button>
      </div>
    </Modal>
  );
}
