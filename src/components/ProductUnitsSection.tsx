import React, { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { productUnits as unitsApi, ProductUnit } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import NumberInput from './NumberInput';

// Named units for one product ("Carton" = 12, "Bag" = 25kg) — a unit only
// ever changes how a QUANTITY is entered; price stays per base unit
// everywhere in the app (migration 0030, Phase 6c). Only shown once the
// product itself has been saved, since a unit needs a real product_id.
export default function ProductUnitsSection({ productKind, productId, baseUnitLabel }: {
  productKind: 'material' | 'finished_good';
  productId: string;
  baseUnitLabel: string;
}) {
  const toast = useToast();
  const { data: units, loading, refetch } = useQuery<ProductUnit[]>(() => unitsApi.forProduct(productKind, productId), [productKind, productId]);
  const createMut = useMutation(unitsApi.create);
  const removeMut = useMutation(unitsApi.remove);

  const [name, setName] = useState('');
  const [factor, setFactor] = useState(0);
  const [barcode, setBarcode] = useState('');

  const addUnit = async () => {
    if (!name.trim() || factor <= 0) { toast.error('Enter a name and how many base units it holds.'); return; }
    const res = await createMut.mutate({ product_kind: productKind, product_id: productId, name: name.trim(), factor, barcode: barcode.trim() || null });
    if (res) {
      setName(''); setFactor(0); setBarcode('');
      refetch();
    } else {
      toast.error(createMut.error ?? 'Could not add that unit.');
    }
  };

  const remove = async (u: ProductUnit) => {
    const res = await removeMut.mutate(u.id);
    if (res !== null) { toast.success(`${u.name} removed.`); refetch(); }
    else toast.error(removeMut.error ?? 'Could not remove it — it may already be used on a sale or purchase.');
  };

  return (
    <div>
      <hr className="divider" />
      <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>Units</p>
      <p style={{ fontSize: '0.78rem', color: '#94a3b8', marginBottom: '0.6rem' }}>
        Sell or buy this in bigger units — e.g. a "Carton" of 12 {baseUnitLabel || 'units'}. Price always stays per {baseUnitLabel || 'base unit'}.
      </p>
      {!loading && (units ?? []).length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', marginBottom: '0.6rem' }}>
          {units!.map(u => (
            <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', fontSize: '0.85rem' }}>
              <span style={{ flex: 1 }}>
                <strong>{u.name}</strong> = {u.factor} {baseUnitLabel || 'units'}
                {u.barcode && <span style={{ color: '#94a3b8' }}> · barcode {u.barcode}</span>}
              </span>
              <button type="button" className="btn-ghost btn-sm" onClick={() => remove(u)} title="Remove"><Trash2 size={13} /></button>
            </div>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-end' }}>
        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
          <label>Name</label>
          <input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Carton" />
        </div>
        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
          <label>{baseUnitLabel || 'Base units'} inside</label>
          <NumberInput value={factor} onChange={setFactor} />
        </div>
        <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
          <label>Barcode (optional)</label>
          <input value={barcode} onChange={e => setBarcode(e.target.value)} placeholder="Scan or type" />
        </div>
        <button type="button" className="btn-secondary btn-sm" onClick={addUnit} disabled={createMut.pending} style={{ marginBottom: 1 }}>
          <Plus size={14} /> Add
        </button>
      </div>
    </div>
  );
}
