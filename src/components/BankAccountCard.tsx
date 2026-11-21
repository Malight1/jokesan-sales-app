import React, { useState } from 'react';
import { Landmark, Pencil, Copy } from 'lucide-react';
import { tenantApi } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { hasBank } from '../lib/whatsapp';

// The business's own bank account: the one customers pay into. Shown
// wherever a document asks someone for money (quotes, proformas, payment
// requests). An admin can fill it in right here instead of hunting
// through Settings; everyone else sees it read-only.
export default function BankAccountCard({ compact = false }: { compact?: boolean }) {
  const { tenant, profile, refresh } = useAuth();
  const toast = useToast();
  const bank = tenant?.bank_details;
  const isAdmin = profile?.role === 'admin';
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [bankName, setBankName] = useState(bank?.bank_name ?? '');
  const [accountNumber, setAccountNumber] = useState(bank?.account_number ?? '');
  const [accountName, setAccountName] = useState(bank?.account_name ?? '');

  const startEdit = () => {
    setBankName(bank?.bank_name ?? '');
    setAccountNumber(bank?.account_number ?? '');
    setAccountName(bank?.account_name ?? '');
    setEditing(true);
  };

  const save = async () => {
    if (!tenant) return;
    const digits = accountNumber.replace(/\s+/g, '');
    if (!bankName.trim() || !digits) { toast.error('Enter at least the bank and the account number.'); return; }
    setSaving(true);
    try {
      await tenantApi.update(tenant.id, { bank_details: { bank_name: bankName.trim(), account_number: digits, account_name: accountName.trim() } });
      await refresh();
      toast.success('Bank account saved. It now shows on quotes, invoices and payment requests.');
      setEditing(false);
    } catch (e: any) {
      toast.error(e?.message ?? 'Could not save the bank account.');
    } finally {
      setSaving(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText([bank?.bank_name, bank?.account_number, bank?.account_name].filter(Boolean).join('\n'));
      toast.success('Bank details copied.');
    } catch { toast.error('Could not copy.'); }
  };

  if (editing || (isAdmin && !hasBank(bank) && !compact)) {
    return (
      <div className="bank-card is-editing">
        <div className="bank-card-head">
          <Landmark size={16} aria-hidden="true" />
          <span>Account customers pay into</span>
        </div>
        <div className="grid-2">
          <div className="form-group">
            <label htmlFor="bank-name">Bank</label>
            <input id="bank-name" value={bankName} onChange={e => setBankName(e.target.value)} placeholder="e.g. Access Bank" />
          </div>
          <div className="form-group">
            <label htmlFor="bank-number">Account number</label>
            <input id="bank-number" inputMode="numeric" maxLength={14} value={accountNumber} onChange={e => setAccountNumber(e.target.value)} placeholder="10 digits" />
          </div>
        </div>
        <div className="form-group">
          <label htmlFor="bank-acct-name">Account name</label>
          <input id="bank-acct-name" value={accountName} onChange={e => setAccountName(e.target.value)} placeholder="As it appears on the account" />
        </div>
        <div className="bank-card-actions">
          {editing && <button type="button" className="btn-ghost btn-sm" onClick={() => setEditing(false)}>Cancel</button>}
          <button type="button" className="btn-primary btn-sm" onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save bank account'}</button>
        </div>
      </div>
    );
  }

  if (!hasBank(bank)) {
    return (
      <div className="bank-card is-missing">
        <Landmark size={16} aria-hidden="true" />
        <span>
          No bank account saved, so customers won't see where to pay.
          {isAdmin ? <> <button type="button" className="link-inline" onClick={startEdit}>Add it now</button></> : ' Ask your admin to add it in Settings.'}
        </span>
      </div>
    );
  }

  return (
    <div className="bank-card">
      <div className="bank-card-lines">
        <span className="bank-card-label">Customers pay into</span>
        <strong>{bank.account_number}</strong>
        <span>{[bank.bank_name, bank.account_name].filter(Boolean).join(' · ')}</span>
      </div>
      <div className="bank-card-actions">
        <button type="button" className="btn-ghost btn-sm" onClick={copy} aria-label="Copy bank details"><Copy size={14} /></button>
        {isAdmin && <button type="button" className="btn-secondary btn-sm" onClick={startEdit}><Pencil size={13} /> Change</button>}
      </div>
    </div>
  );
}
