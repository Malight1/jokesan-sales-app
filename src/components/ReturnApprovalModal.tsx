import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import Modal from './Modal';
import { ErrorState } from './DataStates';
import { team } from '../lib/api';
import { useQuery } from '../lib/hooks';

const ROLE_NAME: Record<string, string> = { admin: 'Admin', sales: 'Sales', accounts: 'Accounts' };

// A cashier's return needs an admin, a sales lead or accounts to approve
// it on the spot (migration 0054). They pick themselves and type their
// own PIN on the cashier's screen; the server checks it and keeps a
// record of who approved, and locks after five wrong PINs.
export default function ReturnApprovalModal({ saleId, invoiceNo, onApproved, onCancel }: {
  saleId: string; invoiceNo: string; onApproved: () => void; onCancel: () => void;
}) {
  const { data: approvers, loading } = useQuery(() => team.returnApprovers(), []);
  const [approverId, setApproverId] = useState('');
  const [pin, setPin] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!approverId && approvers && approvers.length > 0) setApproverId(approvers[0].id);
  }, [approvers, approverId]);

  const canSubmit = !!approverId && /^[0-9]{4,6}$/.test(pin) && !pending;

  const approve = async () => {
    if (!canSubmit) return;
    setPending(true); setError(null);
    try {
      const ok = await team.approveReturn(saleId, approverId, pin);
      if (ok) { onApproved(); return; }
      setError('That PIN is not right. Try again.');
      setPin('');
    } catch (e: any) {
      setError(e?.message ?? 'Could not check the PIN.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal onClose={onCancel} maxWidth={380}>
      <div className="modal-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ShieldCheck size={18} color="#2563eb" /> Approve this return</h2>
      </div>
      <div className="modal-body">
        {error && <ErrorState message={error} />}
        <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem', lineHeight: 1.5 }}>
          A return on {invoiceNo} needs a manager's OK. Ask an admin, a sales lead or accounts to choose their name and type their PIN.
        </p>
        {loading ? null : (approvers ?? []).length === 0 ? (
          <p style={{ fontSize: '0.85rem', color: '#b45309', lineHeight: 1.5 }}>
            Nobody can approve returns yet. An admin, sales lead or accounts person has to set an approval PIN under My Profile first.
          </p>
        ) : (
          <>
            <div className="form-group">
              <label htmlFor="ra-approver">Approved by</label>
              <select id="ra-approver" value={approverId} onChange={e => setApproverId(e.target.value)}>
                {(approvers ?? []).map(a => <option key={a.id} value={a.id}>{a.name} ({ROLE_NAME[a.role] ?? a.role})</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="ra-pin">Their PIN</label>
              <input id="ra-pin" type="password" inputMode="numeric" autoComplete="off" autoFocus maxLength={6} value={pin}
                     onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                     onKeyDown={e => { if (e.key === 'Enter') approve(); }} />
            </div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!canSubmit} onClick={approve}>
          {pending ? 'Checking…' : 'Approve return'}
        </button>
      </div>
    </Modal>
  );
}
