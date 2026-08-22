import React from 'react';
import { AlertTriangle, X } from 'lucide-react';
import Modal from './Modal';

interface Props {
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  pending?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmDialog({
  title, message, confirmLabel = 'Confirm', danger = true, pending = false, onConfirm, onCancel,
}: Props) {
  return (
    <Modal onClose={onCancel} maxWidth={400}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {danger && <AlertTriangle size={18} color="#dc2626" />}
            {title}
          </h2>
          <button className="close-btn" onClick={onCancel}><X size={18} /></button>
        </div>
        <div className="modal-body">
          <div style={{ fontSize: '0.9rem', color: '#475569', lineHeight: 1.5 }}>{message}</div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onCancel} disabled={pending}>Cancel</button>
          <button type="button" className={danger ? 'btn-danger' : 'btn-primary'} onClick={onConfirm} disabled={pending}>
            {pending ? 'Working…' : confirmLabel}
          </button>
        </div>
    </Modal>
  );
}
