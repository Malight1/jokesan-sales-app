import React, { useEffect, useState } from 'react';
import { Wallet } from 'lucide-react';
import { registers as registersApi, shifts as shiftsApi, Register } from '../lib/api';
import { useQuery } from '../lib/hooks';
import { useBranches } from '../lib/useBranches';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from './DataStates';
import NumberInput from './NumberInput';
import './TillPanels.scss';

// Shown instead of the product grid once an admin has required a till for
// selling and the signed-in person doesn't have one open yet.
export default function OpenTillScreen({ onOpened }: { onOpened: () => void }) {
  const toast = useToast();
  const { myBranchId, myBranchName, multi } = useBranches();
  const regQ = useQuery<Register[]>(() => registersApi.list(), []);
  const [registerId, setRegisterId] = useState('');
  const [float, setFloat] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mine = (regQ.data ?? []).filter(r => r.is_active && r.branch_id === myBranchId);

  useEffect(() => {
    if (!registerId && mine.length > 0) setRegisterId(mine[0].id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mine.length]);

  if (regQ.loading) return <Loading label="Loading registers…" />;
  if (regQ.error) return <ErrorState message={regQ.error} onRetry={regQ.refetch} />;

  const open = async () => {
    if (!registerId) { toast.error('Pick a register.'); return; }
    setPending(true);
    setError(null);
    try {
      await shiftsApi.open(registerId, float);
      toast.success('Till opened.');
      onOpened();
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="till-gate">
      <Wallet size={48} color="#2563eb" />
      <h1>Open your till</h1>
      <p>This business requires an open till before you can sell{multi ? ` at ${myBranchName}` : ''}.</p>
      {error && <ErrorState message={error} />}
      {mine.length === 0 ? (
        <p className="till-gate-empty">No register is set up at your branch yet — ask an admin to add one under Settings.</p>
      ) : (
        <div className="till-gate-form">
          <div className="form-group">
            <label>Register</label>
            <select value={registerId} onChange={e => setRegisterId(e.target.value)}>
              {mine.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label>Opening float (cash in the drawer right now)</label>
            <NumberInput value={float} onChange={setFloat} />
          </div>
          <button className="btn-primary big" disabled={pending} onClick={open}>
            {pending ? 'Opening…' : 'Open till'}
          </button>
        </div>
      )}
    </div>
  );
}
