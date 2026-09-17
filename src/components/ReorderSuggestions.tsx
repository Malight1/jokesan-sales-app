import React, { useEffect, useMemo, useState } from 'react';
import { PackagePlus, ShoppingBag } from 'lucide-react';
import { reorder as reorderApi, ReorderSuggestion } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useBranches } from '../lib/useBranches';
import { Loading } from './DataStates';

// Real, server-computed reorder math (migration 0034, Phase 7a) — daily
// usage, its variability, the learned supplier lead time, a safety margin
// and a cover-days target, all worked out in plain SQL so the numbers can
// be checked. Materials only; a "produce" suggestion for finished goods
// (checked against the BOM's feasibility) isn't built yet.
export default function ReorderSuggestions() {
  const toast = useToast();
  const { multi, myBranchName } = useBranches();
  const { data, loading, refetch } = useQuery<ReorderSuggestion[]>(
    () => reorderApi.suggestions().catch(() => []), []);
  const createMut = useMutation(reorderApi.createOrders);

  const needed = useMemo(() => (data ?? []).filter(s => s.suggested_qty > 0), [data]);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Everything needed starts checked, once per load of the suggestion list.
  useEffect(() => { setSelected(new Set(needed.map(s => s.product_id))); }, [needed.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const createOrders = async () => {
    const ids = Array.from(selected);
    if (ids.length === 0) { toast.error('Select at least one material to order.'); return; }
    const res = await createMut.mutate(ids);
    if (!res) { toast.error(createMut.error ?? 'Could not create purchase orders.'); return; }
    const orderedCount = res.created.length;
    const skippedCount = res.skipped.length;
    if (orderedCount > 0) {
      toast.success(`${orderedCount} purchase order${orderedCount !== 1 ? 's' : ''} created — check Purchases.`);
    }
    if (skippedCount > 0) {
      toast.error(`${skippedCount} material${skippedCount !== 1 ? 's' : ''} skipped — no supplier on record yet: ${res.skipped.map(s => s.name).join(', ')}.`);
    }
    refetch();
  };

  if (loading) return <Loading label="Working out what to reorder…" />;
  if (needed.length === 0) return null;

  return (
    <div className="card" style={{ marginTop: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <PackagePlus size={18} color="#2563eb" />
          Reorder Suggestions{multi ? ` — ${myBranchName}` : ''}
        </h3>
        <button className="btn-primary btn-sm" disabled={selected.size === 0 || createMut.pending} onClick={createOrders}>
          <ShoppingBag size={14} /> {createMut.pending ? 'Creating…' : `Create Purchase Order${selected.size !== 1 ? 's' : ''}`}
        </button>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {needed.map(s => (
          <label key={s.product_id}
                 style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-start', padding: '0.6rem 0.75rem', border: '1px solid #e2e8f0', borderRadius: 8, cursor: 'pointer' }}>
            <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={selected.has(s.product_id)} onChange={() => toggle(s.product_id)} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.5rem' }}>
                <strong>{s.name}</strong>
                <span style={{ color: '#2563eb', fontWeight: 600 }}>
                  Order {s.suggested_qty.toLocaleString()} {s.unit ?? 'units'}
                </span>
              </div>
              <p style={{ color: '#64748b', fontSize: '0.82rem', margin: '0.25rem 0 0' }}>{s.reason}</p>
              {!s.supplier_id && (
                <p style={{ color: '#dc2626', fontSize: '0.78rem', margin: '0.25rem 0 0' }}>
                  No supplier on record for this material yet — it will be skipped when creating orders.
                </p>
              )}
            </div>
          </label>
        ))}
      </div>
    </div>
  );
}
