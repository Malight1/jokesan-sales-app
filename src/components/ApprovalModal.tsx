import React, { useEffect, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import Modal from './Modal';
import { ErrorState } from './DataStates';
import { team, TeamMember } from '../lib/api';
import { useQuery } from '../lib/hooks';

// Shown when create_sale refuses a discount for being over the cashier's
// limit. A manager picks themselves from the team list and types their own
// PIN (set under Settings → Pricing) — the server is still the one that
// actually checks it; this just collects what the retry needs.
export default function ApprovalModal({ onApprove, onCancel, pending, error }: {
  onApprove: (managerId: string, pin: string) => void;
  onCancel: () => void;
  pending?: boolean;
  error?: string | null;
}) {
  const { data: members } = useQuery<TeamMember[]>(() => team.members(), []);
  const admins = (members ?? []).filter(m => m.role === 'admin' && m.is_active);
  const [managerId, setManagerId] = useState('');
  const [pin, setPin] = useState('');

  useEffect(() => {
    if (!managerId && admins.length > 0) setManagerId(admins[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admins.length]);

  const canSubmit = !!managerId && /^[0-9]{4,6}$/.test(pin) && !pending;

  return (
    <Modal onClose={onCancel} maxWidth={360}>
      <div className="modal-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ShieldCheck size={18} color="#2563eb" /> Manager Approval</h2>
      </div>
      <div className="modal-body">
        {error && <ErrorState message={error} />}
        <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem' }}>
          This discount is above what you're allowed on your own. Ask a manager to approve it.
        </p>
        {admins.length === 0 ? (
          <p style={{ fontSize: '0.85rem', color: '#dc2626' }}>
            No admin has set up an approval PIN yet — ask one to do this under Settings → Pricing.
          </p>
        ) : (
          <>
            <div className="form-group">
              <label>Manager</label>
              <select value={managerId} onChange={e => setManagerId(e.target.value)}>
                {admins.map(a => <option key={a.id} value={a.id}>{a.full_name ?? a.email ?? 'Admin'}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Manager PIN</label>
              <input type="password" inputMode="numeric" autoFocus maxLength={6} value={pin}
                     onChange={e => setPin(e.target.value.replace(/\D/g, ''))}
                     onKeyDown={e => { if (e.key === 'Enter' && canSubmit) onApprove(managerId, pin); }} />
            </div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn-primary" disabled={!canSubmit} onClick={() => onApprove(managerId, pin)}>
          {pending ? 'Checking…' : 'Approve'}
        </button>
      </div>
    </Modal>
  );
}
