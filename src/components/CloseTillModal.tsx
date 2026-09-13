import React, { useState } from 'react';
import Modal from './Modal';
import { ErrorState } from './DataStates';
import NumberInput from './NumberInput';
import { shifts as shiftsApi, ShiftReport } from '../lib/api';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// The expected figure is never shown until after the count is submitted —
// a blind count, so the cashier can't just copy the number they're
// supposed to land on (tenants.shift_rules.blind_count).
export default function CloseTillModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [countedCash, setCountedCash] = useState(0);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ShiftReport | null>(null);

  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const z = await shiftsApi.close(countedCash, null, notes.trim() || null);
      setResult(z);
      onDone();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setPending(false);
    }
  };

  if (result) {
    const variance = result.variance ?? 0;
    return (
      <Modal onClose={onClose} maxWidth={380}>
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
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-primary" onClick={onClose}>Done</button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose} maxWidth={360}>
      <div className="modal-header"><h2>Close till</h2></div>
      <div className="modal-body">
        {error && <ErrorState message={error} />}
        <p className="till-close-hint">Count the drawer and enter what's actually there — the expected figure only shows up after you submit the count.</p>
        <div className="form-group">
          <label>Counted cash</label>
          <NumberInput value={countedCash} onChange={setCountedCash} autoFocus />
        </div>
        <div className="form-group">
          <label>Notes (optional)</label>
          <input value={notes} onChange={e => setNotes(e.target.value)} placeholder="e.g. counted twice" />
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
