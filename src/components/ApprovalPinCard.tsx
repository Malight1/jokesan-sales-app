import React, { useState } from 'react';
import { Lock } from 'lucide-react';
import { pricing } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';

// Your own approval PIN. An admin's approves discounts above a cashier's
// limit AND cashier returns; a sales lead's or accounts' approves cashier
// returns only (migration 0054). Shown on My Profile and Settings → Pricing.
export default function ApprovalPinCard() {
  const toast = useToast();
  const { profile } = useAuth();
  const hasPinQ = useQuery<boolean>(() => pricing.hasApprovalPin(), []);
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const saveMut = useMutation(pricing.setApprovalPin);
  const isAdmin = profile?.role === 'admin';

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[0-9]{4,6}$/.test(pin)) { toast.error('Use a 4 to 6 digit PIN.'); return; }
    if (pin !== pin2) { toast.error("The two PINs don't match."); return; }
    const res = await saveMut.mutate(pin);
    if (res !== null) { toast.success('Your approval PIN is set.'); setPin(''); setPin2(''); hasPinQ.refetch(); }
    else toast.error(saveMut.error ?? 'Could not set the PIN.');
  };

  return (
    <div className="card">
      <h3 style={{ marginBottom: '0.25rem', display: 'flex', alignItems: 'center', gap: 8 }}><Lock size={16} /> Your approval PIN</h3>
      <p style={{ color: '#64748b', fontSize: '0.82rem', marginBottom: '1rem', lineHeight: 1.5 }}>
        {isAdmin
          ? 'Cashiers ask for this PIN to give a discount above their limit, and to do a return.'
          : 'Cashiers ask for this PIN when they need to do a return at the till.'}
        {' '}Keep it to yourself.
        {hasPinQ.data && ' A PIN is already set. Saving a new one replaces it.'}
      </p>
      <form onSubmit={submit} className="grid-2" style={{ maxWidth: 400 }}>
        <div className="form-group">
          <label htmlFor="pin-new">New PIN (4 to 6 digits)</label>
          <input id="pin-new" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="form-group">
          <label htmlFor="pin-again">Type it again</label>
          <input id="pin-again" type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin2} onChange={e => setPin2(e.target.value.replace(/\D/g, ''))} />
        </div>
        <button className="btn-primary" type="submit" disabled={saveMut.pending} style={{ gridColumn: '1 / -1', justifySelf: 'start' }}>
          {saveMut.pending ? 'Saving…' : 'Set PIN'}
        </button>
      </form>
    </div>
  );
}
