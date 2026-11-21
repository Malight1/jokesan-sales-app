import React, { useState } from 'react';
import { Printer, MessageCircle } from 'lucide-react';
import Modal from './Modal';
import { ErrorState } from './DataStates';
import NumberInput from './NumberInput';
import { shifts as shiftsApi, ShiftReport } from '../lib/api';
import { NOTE_VALUES, printHtml, zReportHtml, zReportText, getReceiptWidth } from '../lib/receipt';
import { whatsappLink } from '../lib/whatsapp';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// The expected figure is never shown until after the count is submitted —
// a blind count, so the cashier can't just copy the number they're
// supposed to land on (tenants.shift_rules.blind_count).
//
// The drawer is counted note by note (₦1000 × 12, ₦500 × 7…) plus one
// figure for coins and anything else; the total is worked out here and
// the breakdown is kept on the shift for the Z report.
export default function CloseTillModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [notesCount, setNotesCount] = useState<Record<string, number>>({});
  const [other, setOther] = useState(0);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShiftReport | null>(null);

  const countedCash = NOTE_VALUES.reduce((s, n) => s + n * (notesCount[n] || 0), 0) + (other || 0);

  const submit = async () => {
    setPending(true);
    setError(null);
    const breakdown: Record<string, number> = {};
    NOTE_VALUES.forEach(n => { if (notesCount[n]) breakdown[String(n)] = notesCount[n]; });
    if (other) breakdown.other = other;
    try {
      const z = await shiftsApi.close(countedCash, Object.keys(breakdown).length ? breakdown : null, notes.trim() || null);
      // onDone (which swaps the till for the "open till" screen) waits until
      // the cashier dismisses the result, or the Z report would vanish
      // before they could print or send it.
      setResult(z);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setPending(false);
    }
  };

  const finish = () => { onClose(); onDone(); };

  if (result) {
    const variance = result.variance ?? 0;
    const z = { ...result, expected: result.expected as unknown as Record<string, number | undefined> };
    return (
      <Modal onClose={finish} maxWidth={400}>
        <div className="modal-header"><h2>Till closed — {result.doc_no}</h2></div>
        <div className="modal-body">
          <div className="till-close-figures">
            <div><span>Expected cash</span><strong>{fmt(result.expected.cash)}</strong></div>
            <div><span>Counted</span><strong>{fmt(result.counted_cash ?? 0)}</strong></div>
            <div className={variance === 0 ? 'ok' : variance > 0 ? 'over' : 'short'}>
              <span>{variance === 0 ? 'Balanced' : variance > 0 ? 'Over' : 'Short'}</span>
              <strong>{fmt(Math.abs(variance))}</strong>
            </div>
          </div>
          <p className="till-close-summary">
            {result.sales_count} sale{result.sales_count === 1 ? '' : 's'} · {fmt(result.sales_total)} total
            {result.refunds_total ? ` · ${fmt(result.refunds_total)} refunded` : ''}
            {result.credit_given ? ` · ${fmt(result.credit_given)} left owing` : ''}
          </p>
          <div className="till-z-actions">
            <button type="button" className="btn-secondary" onClick={() => printHtml(zReportHtml(z, getReceiptWidth()))}>
              <Printer size={16} aria-hidden="true" /> Print Z report
            </button>
            <button type="button" className="btn-secondary" onClick={() => window.open(whatsappLink(null, zReportText(z)), '_blank')}>
              <MessageCircle size={16} aria-hidden="true" /> Send on WhatsApp
            </button>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-primary" onClick={finish}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} maxWidth={400}>
      <div className="modal-header"><h2>Close till</h2></div>
      <div className="modal-body">
        {error && <ErrorState message={error} />}
        <p className="till-close-hint">Count the drawer note by note. What the drawer should hold only shows after you close.</p>
        <div className="till-count" role="group" aria-label="Cash counted, by note">
          {NOTE_VALUES.map(n => (
            <div className="till-count-row" key={n}>
              <label htmlFor={`count-${n}`}>{fmt(n)} ×</label>
              <NumberInput id={`count-${n}`} value={notesCount[n] || 0}
                           onChange={v => setNotesCount(c => ({ ...c, [n]: Math.max(0, Math.floor(v || 0)) }))} />
              <span>{fmt(n * (notesCount[n] || 0))}</span>
            </div>
          ))}
          <div className="till-count-row">
            <label htmlFor="count-other">Coins and other</label>
            <NumberInput id="count-other" value={other} onChange={v => setOther(Math.max(0, v || 0))} />
            <span />
          </div>
          <div className="till-count-total">
            <span>Counted cash</span>
            <strong>{fmt(countedCash)}</strong>
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="close-notes">Notes (optional)</label>
          <input id="close-notes" value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. counted twice" />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={pending} onClick={submit}>
          {pending ? 'Closing…' : 'Close till'}
        </button>
      </div>
    </Modal>
  );
}
