import React, { useMemo, useState } from 'react';
import { X, Plus, Minus } from 'lucide-react';
import Modal from './Modal';
import NumberInput from './NumberInput';
import { stock } from '../lib/api';
import { useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useBranches } from '../lib/useBranches';

interface Props {
  kind: 'material' | 'finished_good';
  productId: string;
  productName: string;
  unit?: string | null;
  /** Current quantity per branch id, so the dialog can preview the result. */
  qtyAt: (branchId: string) => number;
  /** Admins in a multi-branch company may adjust any branch. */
  canChooseBranch?: boolean;
  onClose: () => void;
  onDone: () => void;
}

const ADD_REASONS = ['Opening balance', 'Found in stock count', 'Returned by customer', 'Other'];
const REMOVE_REASONS = ['Damaged', 'Expired', 'Missing in stock count', 'Used internally', 'Other'];

// Stock only moves through the engine now (migration 0020), so this is the
// one door for everything that isn't a purchase, production run, sale or
// transfer: opening balances, and whatever a physical count turns up.
export default function AdjustStockModal({
  kind, productId, productName, unit, qtyAt, canChooseBranch, onClose, onDone,
}: Props) {
  const toast = useToast();
  const { multi, active, myBranchId, nameOf } = useBranches();
  const adjustMut = useMutation(stock.adjust);

  const [branchId, setBranchId] = useState<string>(myBranchId ?? '');
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [qty, setQty] = useState(0);
  const [unitCost, setUnitCost] = useState<number | ''>('');
  const [reason, setReason] = useState(ADD_REASONS[0]);
  const [note, setNote] = useState('');

  const effectiveBranch = branchId || myBranchId || '';
  const now = effectiveBranch ? qtyAt(effectiveBranch) : 0;
  const after = direction === 'add' ? now + qty : now - qty;
  const reasons = direction === 'add' ? ADD_REASONS : REMOVE_REASONS;
  const u = unit ? ` ${unit}` : '';

  const problem = useMemo(() => {
    if (!qty || qty <= 0) return 'Enter a quantity above zero.';
    if (direction === 'remove' && qty > now) return `Only ${now.toLocaleString()}${u} here to remove.`;
    if (reason === 'Other' && !note.trim()) return 'Say briefly what happened.';
    return null;
  }, [qty, direction, now, u, reason, note]);

  const switchDirection = (d: 'add' | 'remove') => {
    setDirection(d);
    setReason((d === 'add' ? ADD_REASONS : REMOVE_REASONS)[0]);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) { toast.error(problem); return; }
    const res = await adjustMut.mutate({
      branchId: effectiveBranch,
      kind,
      productId,
      qtyDelta: direction === 'add' ? qty : -qty,
      unitCost: direction === 'add' && unitCost !== '' ? Number(unitCost) : null,
      reason: note.trim() ? `${reason} — ${note.trim()}` : reason,
    });
    if (res !== null) {
      toast.success(`${productName}: ${direction === 'add' ? 'added' : 'removed'} ${qty.toLocaleString()}${u}${multi ? ` at ${nameOf(effectiveBranch)}` : ''}.`);
      onDone();
    } else {
      toast.error(adjustMut.error ?? 'Could not adjust stock.');
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={440}>
      <div className="modal-header">
        <h2>Adjust stock — {productName}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {multi && canChooseBranch && (
            <div className="form-group">
              <label>Branch</label>
              <select value={effectiveBranch} onChange={e => setBranchId(e.target.value)}>
                {active.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </div>
          )}

          <div className="form-group">
            <label>What happened?</label>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button type="button" className={direction === 'add' ? 'btn-primary' : 'btn-secondary'}
                      onClick={() => switchDirection('add')} aria-pressed={direction === 'add'}>
                <Plus size={15} /> Add stock
              </button>
              <button type="button" className={direction === 'remove' ? 'btn-danger' : 'btn-secondary'}
                      onClick={() => switchDirection('remove')} aria-pressed={direction === 'remove'}>
                <Minus size={15} /> Remove stock
              </button>
            </div>
          </div>

          <div className="grid-2">
            <div className="form-group">
              <label>Quantity{u ? ` (${unit})` : ''}</label>
              <NumberInput value={qty} onChange={setQty} />
            </div>
            <div className="form-group">
              <label>Reason</label>
              <select value={reason} onChange={e => setReason(e.target.value)}>
                {reasons.map(r => <option key={r}>{r}</option>)}
              </select>
            </div>
          </div>

          {direction === 'add' && (
            <div className="form-group">
              <label>Cost per unit (₦)</label>
              <NumberInput value={unitCost === '' ? 0 : unitCost} onChange={v => setUnitCost(v)} />
              <small style={{ color: '#94a3b8', fontSize: '0.75rem' }}>
                What each unit cost you. Leave at 0 to use the last known cost — this is what the
                profit on these units will be worked out from.
              </small>
            </div>
          )}

          <div className="form-group">
            <label>Note {reason === 'Other' ? '' : '(optional)'}</label>
            <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. counted on Friday" />
          </div>

          <div className="alert alert-info" style={{ fontSize: '0.85rem' }}>
            {multi ? <>At <strong>{nameOf(effectiveBranch)}</strong>: </> : null}
            <strong>{now.toLocaleString()}{u}</strong> now → <strong>{Math.max(after, 0).toLocaleString()}{u}</strong> after this.
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className={direction === 'remove' ? 'btn-danger' : 'btn-primary'}
                  disabled={adjustMut.pending || !!problem}>
            {adjustMut.pending ? 'Saving…' : direction === 'add' ? 'Add stock' : 'Remove stock'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
