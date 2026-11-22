import React from 'react';
import { useSearchParams } from 'react-router-dom';
import { CheckCircle2, Clock } from 'lucide-react';
import BrandMark from '../components/BrandMark';
import './Login.scss';

// Where a customer lands after paying an invoice on a provider's checkout
// page (Monnify redirects here). The business's records update from the
// provider's own confirmation, never from this page, so it only reassures.
export default function PaymentDone() {
  const [params] = useSearchParams();
  const status = (params.get('paymentStatus') ?? '').toUpperCase();
  const paid = status === 'PAID' || status === 'OVERPAID';
  return (
    <div className="auth-screen">
      <div className="auth-card" style={{ textAlign: 'center' }}>
        <div className="auth-brand">
          <BrandMark size={44} className="auth-mark" />
        </div>
        <div style={{ color: paid ? '#16a34a' : '#d97706', marginBottom: '0.75rem' }}>
          {paid ? <CheckCircle2 size={40} aria-hidden="true" /> : <Clock size={40} aria-hidden="true" />}
        </div>
        <div className="auth-intro">
          <h2>{paid ? 'Payment received' : 'Payment is being confirmed'}</h2>
          <p>
            {paid
              ? 'Thank you. The business has been notified and your invoice will show as paid. You can close this page.'
              : 'If you completed the payment, it can take a few minutes to confirm. You can close this page; there is no need to pay again.'}
          </p>
        </div>
      </div>
    </div>
  );
}
