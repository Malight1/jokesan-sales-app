// Offline write queue for the counter (POS). If a sale can't reach the
// server (network down), it's queued locally instead of being lost, the
// cashier keeps working, and it's replayed through the real create_sale
// engine the moment connectivity returns.
//
// Trust boundary: nothing here is "the sale". A queued item only becomes
// real once the server engine (FIFO, stock checks) accepts it on sync —
// so a phone that went offline holding stale stock numbers can never
// silently oversell; a real conflict just fails loudly for the cashier
// to resolve.
import { sales } from './api';

const QUEUE_KEY = 'sf_offline_queue';

export interface QueuedSale {
  id: string;
  type: 'sale';
  createdAt: number;
  payload: Parameters<typeof sales.create>[0];
  status: 'pending' | 'failed';
  failReason?: string;
  label: string; // human-readable summary for the pending-sync UI
}

type QueueListener = (queue: QueuedSale[]) => void;
const listeners = new Set<QueueListener>();

function read(): QueuedSale[] {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]'); }
  catch { return []; }
}

function write(queue: QueuedSale[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  listeners.forEach(l => l(queue));
}

export function subscribeQueue(listener: QueueListener): () => void {
  listeners.add(listener);
  listener(read());
  return () => listeners.delete(listener);
}

export function getQueue(): QueuedSale[] {
  return read();
}

export function enqueueSale(payload: Parameters<typeof sales.create>[0], label: string): QueuedSale {
  const item: QueuedSale = {
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    type: 'sale', createdAt: Date.now(), payload, status: 'pending', label,
  };
  write([...read(), item]);
  return item;
}

export function removeFromQueue(id: string) {
  write(read().filter(q => q.id !== id));
}

export function markFailed(id: string, reason: string) {
  write(read().map(q => q.id === id ? { ...q, status: 'failed', failReason: reason } : q));
}

let flushing = false;

// Replays every pending item through the real engine. Called on
// reconnect (see useOnlineSync) and can also be triggered manually.
export async function flushQueue(): Promise<{ synced: number; failed: number }> {
  if (flushing) return { synced: 0, failed: 0 };
  flushing = true;
  let synced = 0, failed = 0;
  try {
    for (const item of read().filter(q => q.status === 'pending')) {
      try {
        await sales.create(item.payload);
        removeFromQueue(item.id);
        synced++;
      } catch (e: any) {
        // Server is authoritative — a real stock conflict fails loudly here
        // instead of silently corrupting inventory.
        markFailed(item.id, e.message ?? 'Sync failed');
        failed++;
      }
    }
  } finally {
    flushing = false;
  }
  return { synced, failed };
}

export function clearQueue() {
  write([]);
}
