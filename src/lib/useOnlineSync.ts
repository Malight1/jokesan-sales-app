import { useEffect, useState } from 'react';
import { flushQueue, subscribeQueue, QueuedItem } from './offlineQueue';
import { useToast } from './ToastContext';

// Watches browser connectivity + the offline queue. Auto-syncs queued
// sales and payments the moment the network returns, and exposes the live
// queue for a pending-sync indicator in the UI.
export function useOnlineSync() {
  const toast = useToast();
  const [online, setOnline] = useState(navigator.onLine);
  const [queue, setQueue] = useState<QueuedItem[]>([]);

  useEffect(() => subscribeQueue(setQueue), []);

  useEffect(() => {
    const goOnline = async () => {
      setOnline(true);
      const pending = queue.filter(q => q.status === 'pending');
      if (pending.length === 0) return;
      const { synced, failed } = await flushQueue();
      if (synced > 0) toast.success(`${synced} offline item${synced !== 1 ? 's' : ''} synced.`);
      if (failed > 0) toast.error(`${failed} queued item${failed !== 1 ? 's' : ''} couldn't sync — review Pending Sync.`);
    };
    const goOffline = () => setOnline(false);

    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queue]);

  return { online, pendingCount: queue.filter(q => q.status === 'pending').length, failedCount: queue.filter(q => q.status === 'failed').length, queue };
}
