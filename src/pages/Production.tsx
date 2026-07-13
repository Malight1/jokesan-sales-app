import React, { useState } from 'react';
import { Plus, X, Wand2, Eye, Ban } from 'lucide-react';
import { production as productionApi, finishedGoods as goodsApi, materials as materialsApi, boms, ProductionRun, FinishedGood, Material } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

interface Consumption { material_id: string; qty: number; }

export default function Production() {
  const toast = useToast();
  const { data: rows, loading, error, refetch } = useQuery<ProductionRun[]>(() => productionApi.list(), []);
  const { data: goods } = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const { data: materials } = useQuery<Material[]>(() => materialsApi.list(), []);
  const recordMut = useMutation(productionApi.record);
  const voidMut = useMutation(productionApi.void);

  const [showModal, setShowModal] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [voidFor, setVoidFor] = useState<ProductionRun | null>(null);
  const [loadingBom, setLoadingBom] = useState(false);
  const [form, setForm] = useState({
    date: new Date().toISOString().split('T')[0],
    finishedGoodId: '',
    qty: 50,
    expenses: 0,
    consumptions: [] as Consumption[],
  });

  const productName = (id: string) => goods?.find(g => g.id === id)?.name ?? '—';

  // Pull the product's BOM and scale it to the batch size (Access auto-fill behaviour).
  const autofillFromBom = async (finishedGoodId: string, qty: number) => {
    if (!finishedGoodId) return;
    setLoadingBom(true);
    try {
      const bom = await boms.forProduct(finishedGoodId);
      if (bom && bom.bom_items?.length) {
        const factor = qty / (bom.yield_qty || 1);
        const cons: Consumption[] = bom.bom_items.map((it: any) => ({
          material_id: it.material_id,
          qty: Number((it.quantity * factor).toFixed(3)),
        }));
        setForm(f => ({ ...f, consumptions: cons }));
        toast.info(`Loaded ${cons.length} materials from the recipe.`);
      } else {
        setForm(f => ({ ...f, consumptions: [{ material_id: '', qty: 0 }] }));
        toast.info('No saved recipe for this product — add materials manually.');
      }
    } catch (e: any) {
      toast.error(e.message ?? 'Could not load recipe.');
    } finally {
      setLoadingBom(false);
    }
  };

  const onSelectProduct = (id: string) => {
    setForm(f => ({ ...f, finishedGoodId: id }));
    autofillFromBom(id, form.qty);
  };

  const addConsumption = () => setForm(f => ({ ...f, consumptions: [...f.consumptions, { material_id: '', qty: 0 }] }));
  const removeConsumption = (idx: number) => setForm(f => ({ ...f, consumptions: f.consumptions.filter((_, i) => i !== idx) }));
  const updateConsumption = (idx: number, field: keyof Consumption, value: any) =>
    setForm(f => { const c = [...f.consumptions]; (c[idx] as any)[field] = value; return { ...f, consumptions: c }; });

  const resetForm = () => setForm({ date: new Date().toISOString().split('T')[0], finishedGoodId: '', qty: 50, expenses: 0, consumptions: [] });

  const validCons = form.consumptions.filter(c => c.material_id && c.qty > 0);
  const canSubmit = !!form.finishedGoodId && form.qty > 0 && validCons.length > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) { toast.error('Pick a product, quantity, and at least one material.'); return; }
    const res = await recordMut.mutate({
      finishedGoodId: form.finishedGoodId,
      date: form.date,
      expenses: Number(form.expenses) || 0,
      qty: Number(form.qty),
      materials: validCons.map(c => ({ material_id: c.material_id, qty: Number(c.qty) })),
    });
    if (res) {
      toast.success('Production recorded — materials consumed, finished goods added.');
      setShowModal(false);
      resetForm();
      refetch();
    } else if (recordMut.error) {
      toast.error(recordMut.error);
    }
  };

  const handleVoid = async () => {
    if (!voidFor) return;
    const res = await voidMut.mutate(voidFor.id);
    if (res !== null) {
      toast.success('Production voided — materials returned to stock.');
      setVoidFor(null);
      refetch();
    } else {
      toast.error(voidMut.error ?? 'Void failed.');
      setVoidFor(null);
    }
  };

  const columns: Column<ProductionRun>[] = [
    { key: 'production_date', header: 'Date', value: p => p.production_date },
    { key: 'product', header: 'Product', value: p => productName(p.finished_good_id),
      render: p => <strong style={p.voided ? { textDecoration: 'line-through', color: '#94a3b8' } : undefined}>{productName(p.finished_good_id)}{p.voided ? ' (voided)' : ''}</strong> },
    { key: 'qty_produced', header: 'Qty Produced', align: 'right', value: p => p.qty_produced, render: p => p.qty_produced.toLocaleString() },
    { key: 'material_cost', header: 'Material Cost', align: 'right', value: p => p.material_cost, render: p => fmt(p.material_cost) },
    { key: 'expenses', header: 'Expenses', align: 'right', value: p => p.expenses, render: p => fmt(p.expenses) },
    { key: 'unit_cost', header: 'Unit Cost', align: 'right', value: p => p.unit_cost, render: p => <strong>{fmt(p.unit_cost)}</strong> },
    { key: 'total_cost', header: 'Total Cost', align: 'right', value: p => p.total_cost, render: p => fmt(p.total_cost) },
  ];

  const rowActions: RowAction<ProductionRun>[] = [
    { icon: <Eye size={15} />, label: 'View consumption', onClick: p => setViewId(p.id) },
    { icon: <Ban size={15} />, label: 'Void production', onClick: setVoidFor, show: p => !p.voided, variant: 'danger' },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Production</h1>
          <p>{rows ? `${rows.length} production runs` : ' '}</p>
        </div>
        <button className="btn-primary" onClick={() => { resetForm(); setShowModal(true); }}><Plus size={16} /> New Production Run</button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={p => p.id}
        searchKeys={[p => productName(p.finished_good_id), p => p.production_date]}
        searchPlaceholder="Search by product…"
        exportName="production-runs"
        exportTitle="Production Runs"
        rowActions={rowActions}
        emptyMessage="No production runs yet. Record one to turn materials into finished goods."
      />

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>New Production Run</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {recordMut.error && <ErrorState message={recordMut.error} />}
                <div className="grid-2">
                  <div className="form-group">
                    <label>Date</label>
                    <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
                  </div>
                  <div className="form-group">
                    <label>Product</label>
                    <select value={form.finishedGoodId} onChange={e => onSelectProduct(e.target.value)}>
                      <option value="">— select —</option>
                      {goods?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid-2">
                  <div className="form-group">
                    <label>Qty to Produce</label>
                    <NumberInput value={form.qty} onChange={v => setForm(f => ({ ...f, qty: v }))} />
                  </div>
                  <div className="form-group">
                    <label>Additional Expenses (₦)</label>
                    <NumberInput value={form.expenses} onChange={v => setForm(f => ({ ...f, expenses: v }))} />
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '0.5rem 0' }}>
                  <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569' }}>Material Consumption</p>
                  {form.finishedGoodId && (
                    <button type="button" className="btn-ghost btn-sm" disabled={loadingBom} onClick={() => autofillFromBom(form.finishedGoodId, form.qty)}>
                      <Wand2 size={13} /> {loadingBom ? 'Loading…' : 'Reload from recipe'}
                    </button>
                  )}
                </div>

                {form.consumptions.length === 0 && (
                  <p style={{ fontSize: '0.8rem', color: '#94a3b8', marginBottom: '0.5rem' }}>
                    Select a product to auto-load its recipe, or add materials manually.
                  </p>
                )}

                {form.consumptions.map((c, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.5rem' }}>
                    <div className="form-group">
                      <label>Material</label>
                      <select value={c.material_id} onChange={e => updateConsumption(idx, 'material_id', e.target.value)}>
                        <option value="">— select —</option>
                        {materials?.map(m => <option key={m.id} value={m.id}>{m.name}{m.unit ? ` (${m.unit})` : ''}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Qty Used</label>
                      <NumberInput value={c.qty} onChange={v => updateConsumption(idx, 'qty', v)} />
                    </div>
                    <button type="button" onClick={() => removeConsumption(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '0.5rem', marginBottom: '1rem' }}><X size={14} /></button>
                  </div>
                ))}
                <button type="button" className="btn-ghost btn-sm" onClick={addConsumption} style={{ marginBottom: '1rem' }}><Plus size={14} /> Add material</button>

                <div className="alert alert-info" style={{ fontSize: '0.8rem' }}>
                  Unit cost is calculated automatically from the actual FIFO cost of the materials consumed, plus expenses ÷ quantity. Selling price auto-sets from your markup.
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={recordMut.pending || !canSubmit}>
                  {recordMut.pending ? 'Processing…' : 'Save Production'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {viewId && (
        <ProductionDetail
          id={viewId}
          onClose={() => setViewId(null)}
          productName={productName}
          materialName={(id: string) => materials?.find(m => m.id === id)?.name ?? '—'}
        />
      )}

      {voidFor && (
        <ConfirmDialog
          title="Void Production Run"
          message={<>Void this run of <strong>{productName(voidFor.finished_good_id)}</strong> ({voidFor.qty_produced.toLocaleString()} units)? Consumed materials will be returned to stock and the produced goods removed. Only possible if none of this batch has been sold.</>}
          confirmLabel="Void Production"
          pending={voidMut.pending}
          onConfirm={handleVoid}
          onCancel={() => setVoidFor(null)}
        />
      )}
    </div>
  );
}

// ---- Production detail (FIFO consumption trace) ----
function ProductionDetail({ id, onClose, productName, materialName }: {
  id: string; onClose: () => void;
  productName: (id: string) => string;
  materialName: (id: string) => string;
}) {
  const { data, loading, error } = useQuery<any>(() => productionApi.detail(id), [id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Production Detail</h2>
          <button className="close-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          {loading && <Loading />}
          {error && <ErrorState message={error} />}
          {data && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem', fontSize: '0.85rem' }}>
                <div><span style={{ color: '#94a3b8' }}>Date</span><br /><strong>{data.production_date}</strong></div>
                <div><span style={{ color: '#94a3b8' }}>Product</span><br /><strong>{productName(data.finished_good_id)}</strong></div>
                <div><span style={{ color: '#94a3b8' }}>Qty Produced</span><br /><strong>{Number(data.qty_produced).toLocaleString()}</strong></div>
                <div><span style={{ color: '#94a3b8' }}>Unit Cost</span><br /><strong>{fmt(data.unit_cost)}</strong></div>
              </div>
              <h3 style={{ fontSize: '0.9rem', marginBottom: '0.5rem' }}>Materials Consumed (FIFO)</h3>
              <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#64748b' }}><th>Material</th><th>Qty</th><th>Batch Cost</th><th>Line Cost</th></tr>
                </thead>
                <tbody>
                  {data.production_consumption?.map((c: any) => (
                    <tr key={c.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '0.4rem 0' }}>{materialName(c.material_id)}</td>
                      <td>{Number(c.qty).toLocaleString()}</td>
                      <td>{fmt(c.cost_price)}</td>
                      <td>{fmt(c.qty * c.cost_price)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div style={{ textAlign: 'right', marginTop: '0.75rem', fontSize: '0.85rem' }}>
                Materials: <strong>{fmt(data.material_cost)}</strong> · Expenses: <strong>{fmt(data.expenses)}</strong> · Total: <strong>{fmt(data.total_cost)}</strong>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
