import React, { useState } from 'react';
import { X } from 'lucide-react';
import { debts } from '../lib/api';
import { useToast } from '../lib/ToastContext';
import { todayIso } from '../lib/debts';
import Modal from './Modal';
import NumberInput from './NumberInput';
import { ErrorState } from './DataStates';

// What a customer already owed you (or you already owed a supplier) before
// ProfixBook (migration 0062). Becomes an "OB-" document that owes money
// but adds nothing to sales or purchases.
export default function OpeningDebtModal({ kind, partyId, partyName, onClose, onDone }: {
  kind: 'customer' | 'supplier'; partyId: string; partyName: string; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(0);
  const [date, setDate] = useState(todayIso());
  const [due, setDue] = useState('');
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (amount <= 0) { setError('Enter an amount above zero.'); return; }
    setPending(true); setError(null);
    try {
      await debts.addOpening(kind, partyId, amount, date, due || null, note.trim() || null);
      toast.success(kind === 'customer' ? `Added. ${partyName} now owes it.` : `Added. You now owe ${partyName} it.`);
      onDone();
    } catch (err: any) {
      setError(err?.message ?? 'Could not add it.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={460}>
      <div className="modal-header">
        <h2>{kind === 'customer' ? 'What they owed before' : 'What you owed before'}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <ErrorState message={error} />}
          <p style={{ fontSize: '0.875rem', color: '#475569', lineHeight: 1.55, margin: '0 0 1rem' }}>
            {kind === 'customer'
              ? <>Money {partyName} already owed you before you started using ProfixBook, from your notebook or old records. It shows as a debt you can collect, but it isn't counted as a sale.</>
              : <>Money you already owed {partyName} before you started using ProfixBook. It shows as a bill to pay, but it isn't counted as a purchase.</>}
          </p>
          <div className="grid-2">
            <div className="form-group">
              <label htmlFor="ob-amount">Amount (₦)</label>
              <NumberInput id="ob-amount" value={amount} onChange={setAmount} autoFocus />
            </div>
            <div className="form-group">
              <label htmlFor="ob-date">Owed as of</label>
              <input id="ob-date" type="date" value={date} max={todayIso()} onChange={e => setDate(e.target.value)} />
            </div>
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label htmlFor="ob-due">Due by (optional)</label>
              <input id="ob-due" type="date" value={due} onChange={e => setDue(e.target.value)} />
            </div>
            <div className="form-group">
              <label htmlFor="ob-note">Note (optional)</label>
              <input id="ob-note" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. From the old ledger book" />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={pending}>{pending ? 'Saving…' : 'Add'}</button>
        </div>
      </form>
    </Modal>
  );
}
