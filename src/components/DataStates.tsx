import React from 'react';
import { Loader2, AlertCircle, Inbox } from 'lucide-react';

export function Loading({ label = 'Loading…' }: { label?: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, padding: '3rem', color: '#64748b' }}>
      <Loader2 className="spin" size={20} /> {label}
    </div>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="alert alert-danger" style={{ alignItems: 'center' }}>
      <AlertCircle size={18} />
      <div style={{ flex: 1 }}>{message}</div>
      {onRetry && <button className="btn-sm btn-secondary" onClick={onRetry}>Retry</button>}
    </div>
  );
}

export function Empty({ message = 'Nothing here yet.' }: { message?: string }) {
  return (
    <div className="empty-state">
      <Inbox size={28} />
      <p>{message}</p>
    </div>
  );
}
