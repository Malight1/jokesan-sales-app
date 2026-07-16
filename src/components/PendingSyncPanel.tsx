import React from 'react';
import { X, RefreshCcw, Trash2, CloudOff, CheckCircle2 } from 'lucide-react';
import { QueuedSale, removeFromQueue, flushQueue } from '../lib/offlineQueue';
import { useToast } from '../lib/ToastContext';

export default function PendingSyncPanel({ queue, online, onClose }: { queue: QueuedSale[]; online: boolean; onClose: () => void }) {
  const toast = useToast();
  const [syncing, setSyncing] = React.useState(false);

  const syncNow = async () => {
    if (!online) { toast.error("Still offline — can't sync yet."); return; }
    setSyncing(true);
    const { synced, failed } = await flushQueue();
    setSyncing(false);
    if (synced > 0) toast.success(`${synced} sale${synced !== 1 ? 's' : ''} synced.`);
    if (failed > 0) toast.error(`${failed} sale${failed !== 1 ? 's' : ''} failed — review below.`);
    if (synced === 0 && failed === 0) toast.info('Nothing to sync.');
  };

  const discard = (id: string) => {
    removeFromQueue(id);
    toast.success('Discarded — this sale will not be recorded.');
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 480 }}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <CloudOff size={18} color={online ? '#16a34a' : '#dc2626'} /> Pending Sync
          </h2>
          <button className="close-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          {!online && (
            <div className="alert alert-warning" style={{ fontSize: '0.82rem' }}>
              You're offline. These sales are saved on this device and will sync automatically once you're back online.
            </div>
          )}
          {queue.length === 0 ? (
            <p style={{ color: '#94a3b8', fontSize: '0.85rem', textAlign: 'center', padding: '1.5rem 0' }}>
              <CheckCircle2 size={22} style={{ display: 'block', margin: '0 auto 0.4rem', color: '#16a34a' }} />
              Nothing pending — everything is synced.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
              {queue.map(q => (
                <div key={q.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.65rem 0.75rem', border: '1px solid #e2e8f0', borderRadius: 8, background: q.status === 'failed' ? '#fef2f2' : '#fff' }}>
                  <div>
                    <div style={{ fontSize: '0.85rem', fontWeight: 600 }}>{q.label}</div>
                    <div style={{ fontSize: '0.75rem', color: q.status === 'failed' ? '#dc2626' : '#94a3b8' }}>
                      {q.status === 'failed' ? `Failed: ${q.failReason}` : `Queued ${new Date(q.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`}
                    </div>
                  </div>
                  <button className="btn-ghost btn-sm" onClick={() => discard(q.id)} title="Discard"><Trash2 size={14} /></button>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn-secondary" onClick={onClose}>Close</button>
          <button className="btn-primary" onClick={syncNow} disabled={syncing || !online || queue.filter(q => q.status === 'pending').length === 0}>
            <RefreshCcw size={14} /> {syncing ? 'Syncing…' : 'Sync Now'}
          </button>
        </div>
      </div>
    </div>
  );
}
