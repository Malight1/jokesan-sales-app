import { useAuth } from './AuthContext';
import { useQuery } from './hooks';
import { shifts, ShiftReport } from './api';

// Whether this tenant currently requires an open till before selling, and
// whether the signed-in person has one open right now. Opening and closing
// a till need a connection (like receiving stock), so a network error here
// fails OPEN rather than blocking a cashier who is genuinely offline — the
// sale itself still queues as normal and the server is the one that will
// actually refuse it on sync if a till really was required.
export function useTillGate() {
  const { tenant } = useAuth();
  const required = !!tenant?.shift_rules?.required_for?.includes('sales');

  const q = useQuery<ShiftReport | null>(async () => {
    const id = await shifts.myOpenShiftId();
    return id ? shifts.xReport(id) : null;
  }, []);

  const blocked = required && !q.loading && !q.error && !q.data;

  return { required, blocked, shift: q.data, loading: q.loading, error: q.error, refetch: q.refetch };
}
