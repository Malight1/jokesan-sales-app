import React, { useState } from 'react';
import { X } from 'lucide-react';
import Modal from './Modal';
import NumberInput from './NumberInput';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// One cart/sale line's price, with the reason a discount is needed for
// (migration 0025 — create_sale itself works out the discount amount from
// listPrice vs. what's actually charged; this just collects the reason).
export default function LinePriceModal({ productName, qty, unit, currentPrice, listPrice, reason, onSave, onClose }: {
  productName: string;
  qty: number;
  unit?: string;
  currentPrice: number;
  listPrice: number;
  reason?: string;
  onSave: (unitPrice: number, reason: string) => void;
  onClose: () => void;
}) {
  const [price, setPrice] = useState(currentPrice);
  const [note, setNote] = useState(reason ?? '');
  const discount = Math.max((listPrice - price) * qty, 0);
  const pct = listPrice > 0 ? (discount / (listPrice * qty)) * 100 : 0;

  return (
    <Modal onClose={onClose} maxWidth={360}>
      <div className="modal-header">
        <h2>{productName}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        <p style={{ fontSize: '0.82rem', color: '#64748b', marginBottom: '1rem' }}>
          List price {fmt(listPrice)}{unit ? ` per ${unit}` : ''} · {qty} {unit ?? 'unit'}{qty !== 1 ? 's' : ''}
        </p>
        <div className="form-group">
          <label>Price to charge (₦)</label>
          <NumberInput value={price} onChange={setPrice} autoFocus />
        </div>
        {discount > 0 && (
          <div className="form-group">
            <label>Reason for the discount</label>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. regular customer, damaged pack" />
          </div>
        )}
        {discount > 0 && (
          <div className="alert alert-info" style={{ fontSize: '0.82rem' }}>
            {fmt(discount)} off ({pct.toFixed(1)}%). Above your own limit, a manager's PIN will be asked for at checkout.
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={price < 0} onClick={() => onSave(price, note.trim())}>
          Save
        </button>
      </div>
    </Modal>
  );
}
