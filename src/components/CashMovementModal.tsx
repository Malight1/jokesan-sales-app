import React, { useState } from 'react';
import Modal from './Modal';
import ApprovalModal from './ApprovalModal';
import { ErrorState } from './DataStates';
import NumberInput from './NumberInput';
import { shifts as shiftsApi } from '../lib/api';

const NEEDS_APPROVAL = /manager'?s? pin/i;

// Pay money into or out of the till — a top-up of change, a delivery
// rider's fuel, a bank drop. A pay-out over the tenant's limit is refused
// until a manager's PIN is supplied, same mechanism as a POS discount.
export default function CashMovementModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [kind, setKind] = useState<'pay_in' | 'pay_out'>('pay_in');
  const [amount, setAmount] = useState(0);
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const submit = async (approval?: { userId: string; pin: string }) => {
    if (amount <= 0) { setError('Enter an amount above zero.'); return; }
    if (!reason.trim()) { setError('A reason is required.'); return; }
    setPending(true);
    if (approval) { setApproving(true); setApprovalError(null); }
    try {
      await shiftsApi.addCashMovement(kind, amount, reason.trim(), approval ?? null);
      onDone();
      onClose();
    } catch (e: any) {
      const msg = e.message ?? String(e);
      if (!approval && NEEDS_APPROVAL.test(msg)) { setNeedsApproval(true); return; }
      if (approval) { setApprovalError(msg); return; }
      setError(msg);
    } finally {
      setPending(false);
      setApproving(false);
    }
  };

  if (needsApproval) {
    return (
      <ApprovalModal
        pending={approving}
        error={approvalError}
        onCancel={() => setNeedsApproval(false)}
        onApprove={(managerId, pin) => submit({ userId: managerId, pin })}
      />
    );
  }

  return (
    <Modal onClose={onClose} maxWidth={360}>
      <div className="modal-header"><h2>Cash movement</h2></div>
      <div className="modal-body">
        {error && <ErrorState message={error} />}
        <div className="form-group">
          <label>Kind</label>
          <div className="till-kind-toggle">
            <button type="button" className={kind === 'pay_in' ? 'active' : ''} onClick={() => setKind('pay_in')}>Pay in</button>
            <button type="button" className={kind === 'pay_out' ? 'active' : ''} onClick={() => setKind('pay_out')}>Pay out</button>
          </div>
        </div>
        <div className="form-group">
          <label>Amount</label>
          <NumberInput value={amount} onChange={setAmount} autoFocus />
        </div>
        <div className="form-group">
          <label>Reason</label>
          <input value={reason} onChange={e => setReason(e.target.value)}
                 placeholder={kind === 'pay_in' ? 'e.g. change top-up' : 'e.g. fuel for delivery bike'} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={pending} onClick={() => submit()}>
          {pending ? 'Saving…' : kind === 'pay_in' ? 'Pay in' : 'Pay out'}
        </button>
      </div>
    </Modal>
  );
}
