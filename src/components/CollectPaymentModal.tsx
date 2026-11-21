import React, { useState } from 'react';
import { X } from 'lucide-react';
import { sales as salesApi, Lookup } from '../lib/api';
import { useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { ErrorState } from './DataStates';
import Modal from './Modal';
import NumberInput from './NumberInput';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// Transfer first: in practice that is how most owed money comes back.
const defaultPayType = (types: Lookup[]) =>
  (types.find(t => /transfer|bank/i.test(t.name)) ?? types.find(t => /cash/i.test(t.name)) ?? types[0])?.id ?? '';

// Money a customer paid against one invoice. Used from the customer's
// account screen; Sales keeps its own row action for the same thing.
export default function CollectPaymentModal({ saleId, docNo, customerName, balance, payTypes, onClose, onDone }: {
  saleId: string; docNo: string; customerName: string; balance: number;
  payTypes: Lookup[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const types = payTypes.filter(t => !/credit/i.test(t.name));
  const payMut = useMutation(salesApi.addPayment);
  const [amount, setAmount] = useState(balance);
  const [payType, setPayType] = useState(() => defaultPayType(types));
  const [reference, setReference] = useState('');
  const half = Math.round(balance / 2);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(amount > 0)) { toast.error('Enter the amount they paid.'); return; }
    const pay = Math.min(amount, balance);
    const res = await payMut.mutate(saleId, pay, payType || null, reference.trim() || undefined);
    if (res !== null) {
      const left = balance - pay;
      toast.success(left > 0 ? `${fmt(pay)} received. ${customerName} still owes ${fmt(left)} on ${docNo}.` : `${docNo} is fully paid.`);
      onDone();
    } else {
      toast.error(payMut.error ?? 'Could not record the payment.');
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={420}>
      <div className="modal-header">
        <h2>Record a payment</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {payMut.error && <ErrorState message={payMut.error} />}
          <div className="acct-pay-head">
            <span>{customerName} owes on {docNo}</span>
            <strong>{fmt(balance)}</strong>
          </div>
          <div className="form-group">
            <label htmlFor="collect-amount">Amount received (₦)</label>
            <NumberInput id="collect-amount" value={amount} max={balance} onChange={setAmount} />
            <div className="acct-quick">
              <button type="button" className={amount === balance ? 'is-on' : ''} onClick={() => setAmount(balance)}>Full balance</button>
              {half > 0 && half < balance && (
                <button type="button" className={amount === half ? 'is-on' : ''} onClick={() => setAmount(half)}>Half ({fmt(half)})</button>
              )}
            </div>
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label htmlFor="collect-type">Paid by</label>
              <select id="collect-type" value={payType} onChange={e => setPayType(e.target.value)}>
                <option value="">Not stated</option>
                {types.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="collect-ref">Reference (optional)</label>
              <input id="collect-ref" value={reference} onChange={e => setReference(e.target.value)} placeholder="Transfer ref, teller no." />
            </div>
          </div>
          {amount > 0 && amount < balance && (
            <p className="acct-note">{fmt(balance - amount)} will still be owed after this.</p>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={payMut.pending || !(amount > 0)}>
            {payMut.pending ? 'Saving…' : amount > 0 ? `Record ${fmt(Math.min(amount, balance))}` : 'Enter an amount'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
