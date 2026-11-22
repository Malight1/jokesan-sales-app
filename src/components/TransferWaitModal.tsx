import React, { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Copy, Loader2, CheckCircle2, Clock, RefreshCw, ShieldCheck } from 'lucide-react';
import Modal from './Modal';
import { tillPayments, TillPayment } from '../lib/api';
import { useToast } from '../lib/ToastContext';
import './TransferWaitModal.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const PROVIDER_NAME: Record<string, string> = { monnify: 'Moniepoint', paystack: 'Paystack', opay: 'OPay' };

// The till's "waiting for the money" screen (migration 0058). Shows the
// one-time account number (Moniepoint) or a QR code to scan (Paystack,
// OPay), checks with the provider every few seconds, and only hands back
// once the provider says the money really arrived. A screenshot can't
// get past this: nothing here trusts the customer's phone.
export default function TransferWaitModal({ payment: initial, onPaid, onCancel, onRetry }: {
  payment: TillPayment;
  onPaid: (p: TillPayment) => void;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const toast = useToast();
  const [payment, setPayment] = useState<TillPayment>(initial);
  const [checking, setChecking] = useState(false);
  const [offline, setOffline] = useState(false);
  const [shortBy, setShortBy] = useState(0);
  const [qr, setQr] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const done = useRef(false);

  useEffect(() => {
    if (!payment.pay_url) return;
    QRCode.toDataURL(payment.pay_url, { margin: 1, width: 240, errorCorrectionLevel: 'M' }).then(setQr).catch(() => setQr(null));
  }, [payment.pay_url]);

  const check = useCallback(async (manual = false) => {
    if (done.current) return;
    setChecking(true);
    const res = await tillPayments.status(payment.id);
    setChecking(false);
    if (res.error) { setOffline(res.error === 'offline'); if (manual && res.error !== 'offline') toast.error(res.error); return; }
    setOffline(false);
    if (res.payment) setPayment(res.payment);
    if (res.shortBy) setShortBy(res.shortBy);
    if (res.status === 'paid' && res.payment && !done.current) {
      done.current = true;
      setTimeout(() => onPaid(res.payment!), 900);
    } else if (manual && res.status === 'pending') {
      toast.info('Not arrived yet. Transfers usually land within a minute.');
    }
  }, [payment.id, onPaid, toast]);

  // Check every 4 seconds while waiting; tick the countdown every second.
  useEffect(() => {
    const t = setInterval(() => { if (payment.status === 'pending') check(); }, 4000);
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => { clearInterval(t); clearInterval(c); };
  }, [check, payment.status]);

  const left = payment.expires_at ? Math.max(0, Math.floor((new Date(payment.expires_at).getTime() - now) / 1000)) : null;
  const expired = payment.status === 'expired' || (left === 0 && payment.status === 'pending');
  const paid = payment.status === 'paid' || payment.status === 'used';
  const provider = PROVIDER_NAME[payment.provider] ?? payment.provider;

  const copy = async (text: string) => {
    try { await navigator.clipboard.writeText(text); toast.success('Copied.'); } catch { toast.error('Could not copy.'); }
  };

  const cancel = async () => {
    if (!paid) { try { await tillPayments.cancel(payment.id); } catch { /* best effort */ } }
    onCancel();
  };

  return (
    <Modal onClose={paid ? () => {} : cancel} maxWidth={440}>
      <div className="modal-header">
        <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}><ShieldCheck size={18} color="#2563eb" /> Pay by transfer</h2>
      </div>
      <div className="modal-body tw-modal">
        <div className="tw-amount">
          <span>Customer pays exactly</span>
          <strong>{fmt(Number(payment.amount))}</strong>
        </div>

        {paid ? (
          <div className="tw-state is-paid" role="status">
            <CheckCircle2 size={36} aria-hidden="true" />
            <strong>Money received</strong>
            <span>Confirmed by {provider}. Finishing the sale…</span>
          </div>
        ) : expired ? (
          <div className="tw-state is-expired" role="status">
            <Clock size={32} aria-hidden="true" />
            <strong>This {payment.account_number ? 'account number' : 'code'} has expired</strong>
            <span>If the customer already paid, tap Check again. Otherwise get a new one.</span>
            <div className="tw-row">
              <button type="button" className="btn-secondary btn-sm" onClick={() => check(true)} disabled={checking}><RefreshCw size={14} /> Check again</button>
              <button type="button" className="btn-primary btn-sm" onClick={onRetry}>New {payment.account_number ? 'account number' : 'code'}</button>
            </div>
          </div>
        ) : payment.account_number ? (
          <div className="tw-account">
            <span className="tw-label">Transfer to</span>
            <button type="button" className="tw-number" onClick={() => copy(payment.account_number!)} aria-label={`Account number ${payment.account_number}, tap to copy`}>
              {payment.account_number.replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3')} <Copy size={16} aria-hidden="true" />
            </button>
            <span className="tw-bank">{payment.bank_name}</span>
            <span className="tw-name">{payment.account_name}</span>
            <p className="tw-note">This account works for this sale only. The customer must send exactly {fmt(Number(payment.amount))}.</p>
          </div>
        ) : (
          <div className="tw-qr">
            {qr ? <img src={qr} alt={`QR code to pay ${fmt(Number(payment.amount))} with ${provider}`} /> : <Loader2 className="spin" size={24} />}
            <p className="tw-note">Customer scans this with their phone camera or bank app and pays with {provider} (transfer, card or USSD).</p>
            {payment.pay_url && <button type="button" className="btn-ghost btn-sm" onClick={() => copy(payment.pay_url!)}><Copy size={13} /> Copy payment link</button>}
          </div>
        )}

        {!paid && !expired && (
          <div className="tw-wait" role="status" aria-live="polite">
            <Loader2 size={16} className="spin" aria-hidden="true" />
            <span>{offline ? 'No connection. Still waiting, will check again…' : `Waiting for ${provider} to confirm the money…`}</span>
            {left !== null && <span className="tw-left">{Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</span>}
          </div>
        )}
        {shortBy > 0 && !paid && (
          <p className="tw-short">The customer sent {fmt(shortBy)} less than the total. That money is recorded for the owner; this sale is not paid yet.</p>
        )}
        <p className="tw-foot">Don't hand over the goods because of a screenshot. The sale completes on its own when the money is confirmed.</p>
      </div>
      {!paid && (
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={cancel}>Cancel</button>
          {!expired && <button type="button" className="btn-primary" onClick={() => check(true)} disabled={checking}>{checking ? 'Checking…' : 'Customer says they paid'}</button>}
        </div>
      )}
    </Modal>
  );
}
