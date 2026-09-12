// Offline write queue for the counter. If a write can't reach the server
// (network down), it's queued locally instead of being lost, the cashier
// keeps working, and it's replayed through the real engine the moment
// connectivity returns.
//
// Trust boundary: nothing here is "the sale". A queued item only becomes
// real once the server engine (FIFO, stock checks, overpayment checks)
// accepts it on sync — so a phone that went offline holding stale numbers
// can never silently oversell; a real conflict just fails loudly for the
// cashier to resolve.
//
// Deliberately NOT queueable: returns, shift open/close, recalls, stock
// receiving. Those need the server's answer before anyone acts on them.
import { sales } from './api';

const QUEUE_KEY = 'sf_offline_queue';

export type QueuedOp =
  | { type: 'sale'; payload: Parameters<typeof sales.create>[0] }
  | { type: 'sale_payment'; payload: { saleId: string; amount: number; paymentTypeId: string | null } };

export type QueuedItem = QueuedOp & {
  id: string;
  createdAt: number;
  status: 'pending' | 'failed';
  failReason?: string;
  label: string; // human-readable summary for the pending-sync UI
};

/** @deprecated kept for older imports; every queued thing is a QueuedItem now. */
export type QueuedSale = QueuedItem;

type QueueListener = (queue: QueuedItem[]) => void;
const listeners = new Set<QueueListener>();

function read(): QueuedItem[] {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]'); }
  catch { return []; }
}

function write(queue: QueuedItem[]) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  listeners.forEach(l => l(queue));
}

export function subscribeQueue(listener: QueueListener): () => void {
  listeners.add(listener);
  listener(read());
  return () => listeners.delete(listener);
}

export function getQueue(): QueuedItem[] {
  return read();
}

export function enqueue(op: QueuedOp, label: string): QueuedItem {
  const item = {
    ...op,
    id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(), status: 'pending', label,
  } as QueuedItem;
  write([...read(), item]);
  return item;
}

export function enqueueSale(payload: Parameters<typeof sales.create>[0], label: string): QueuedItem {
  return enqueue({ type: 'sale', payload }, label);
}

export function enqueuePayment(payload: { saleId: string; amount: number; paymentTypeId: string | null }, label: string): QueuedItem {
  return enqueue({ type: 'sale_payment', payload }, label);
}

export function removeFromQueue(id: string) {
  write(read().filter(q => q.id !== id));
}

export function markFailed(id: string, reason: string) {
  write(read().map(q => q.id === id ? { ...q, status: 'failed', failReason: reason } : q));
}

// One place that knows how to replay each kind of queued write.
async function replay(item: QueuedItem): Promise<void> {
  switch (item.type) {
    case 'sale':
      await sales.create(item.payload);
      return;
    case 'sale_payment':
      await sales.addPayment(item.payload.saleId, item.payload.amount, item.payload.paymentTypeId);
      return;
    default:
      throw new Error('This app version does not know how to sync this item.');
  }
}

let flushing = false;

// Replays every pending item through the real engine, oldest first. Called
// on reconnect (see useOnlineSync) and can also be triggered manually.
export async function flushQueue(): Promise<{ synced: number; failed: number }> {
  if (flushing) return { synced: 0, failed: 0 };
  flushing = true;
  let synced = 0, failed = 0;
  try {
    for (const item of read().filter(q => q.status === 'pending')) {
      try {
        await replay(item);
        removeFromQueue(item.id);
        synced++;
      } catch (e: any) {
        // Server is authoritative — a real conflict fails loudly here
        // instead of silently corrupting stock or balances.
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
