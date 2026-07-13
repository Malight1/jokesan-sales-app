import React, { useState } from 'react';
import { Plus, X, Sparkles, Pencil, Trash2 } from 'lucide-react';
import { materials as materialsApi, demo, Material } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';

const emptyForm = { name: '', unit: '', type_of_material: 'Raw Material', qty_balance: 0, min_stock_level: 10 };

export default function Inventory() {
  const toast = useToast();
  const { data: rows, loading, error, refetch } = useQuery<Material[]>(() => materialsApi.list(), []);
  const createMut = useMutation(materialsApi.create);
  const updateMut = useMutation((id: string, m: Partial<Material>) => materialsApi.update(id, m));
  const removeMut = useMutation(materialsApi.remove);
  const seedMut = useMutation(demo.seed);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Material | null>(null);
  const [deleteRow, setDeleteRow] = useState<Material | null>(null);
  const [filter, setFilter] = useState('All');
  const [form, setForm] = useState(emptyForm);

  const openCreate = () => { setEditRow(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (m: Material) => {
    setEditRow(m);
    setForm({ name: m.name, unit: m.unit ?? '', type_of_material: m.type_of_material, qty_balance: m.qty_balance, min_stock_level: m.min_stock_level });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // On edit, exclude qty_balance — stock only moves via purchases/production/sales.
    const { qty_balance, ...editable } = form;
    const res = editRow ? await updateMut.mutate(editRow.id, editable) : await createMut.mutate(form);
    if (res) {
      toast.success(editRow ? 'Material updated.' : 'Material added.');
      setShowModal(false);
      setForm(emptyForm);
      setEditRow(null);
      refetch();
    } else {
      toast.error((editRow ? updateMut.error : createMut.error) ?? 'Something went wrong.');
    }
  };

  const handleDelete = async () => {
    if (!deleteRow) return;
    const res = await removeMut.mutate(deleteRow.id);
    if (res !== null) {
      toast.success('Material deleted.');
      setDeleteRow(null);
      refetch();
    } else {
      const msg = removeMut.error ?? '';
      toast.error(msg.includes('foreign key') || msg.includes('violates')
        ? 'Cannot delete — this material is used in purchases, recipes, or production.'
        : msg || 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const loadSample = async () => {
    const res = await seedMut.mutate();
    if (res !== null) { toast.success('Sample data loaded.'); refetch(); }
    else if (seedMut.error) toast.error(seedMut.error);
  };

  const stockClass = (m: Material) => m.qty_balance === 0 ? 'badge-danger' : m.qty_balance <= m.min_stock_level ? 'badge-warning' : 'badge-success';
  const stockLabel = (m: Material) => m.qty_balance === 0 ? 'Out of stock' : m.qty_balance <= m.min_stock_level ? 'Low stock' : 'In stock';

  const filtered = (rows ?? []).filter(m => filter === 'All' || m.type_of_material === filter);

  const columns: Column<Material>[] = [
    { key: 'name', header: 'Material', value: m => m.name, render: m => <strong>{m.name}</strong> },
    { key: 'type_of_material', header: 'Type', value: m => m.type_of_material },
    { key: 'unit', header: 'Unit', value: m => m.unit ?? '—' },
    { key: 'qty_balance', header: 'Qty Balance', align: 'right', value: m => m.qty_balance, render: m => m.qty_balance.toLocaleString() },
    { key: 'min_stock_level', header: 'Min Level', align: 'right', value: m => m.min_stock_level, render: m => m.min_stock_level.toLocaleString() },
    { key: 'status', header: 'Status', value: m => stockLabel(m), render: m => <span className={stockClass(m)}>{stockLabel(m)}</span> },
  ];

  const rowActions: RowAction<Material>[] = [
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Raw Materials</h1><p>{rows ? `${rows.length} items tracked` : ' '}</p></div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Material</button>
      </div>

      {loading && <Loading label="Loading materials…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}

      {!loading && !error && rows && rows.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
          <Sparkles size={28} color="#2563eb" style={{ marginBottom: '0.5rem' }} />
          <h3 style={{ marginBottom: '0.35rem' }}>Start with sample data</h3>
          <p style={{ color: '#64748b', fontSize: '0.875rem', marginBottom: '1rem' }}>
            Load Jokesan starter materials, products, and BOM recipes so you can try the costing engine right away.
          </p>
          {seedMut.error && <ErrorState message={seedMut.error} />}
          <button className="btn-primary" onClick={loadSample} disabled={seedMut.pending}>
            {seedMut.pending ? 'Loading…' : 'Load Sample Data'}
          </button>
        </div>
      )}

      {!loading && !error && rows && rows.length > 0 && (
        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={m => m.id}
          searchKeys={[m => m.name, m => m.type_of_material]}
          searchPlaceholder="Search materials…"
          exportName="raw-materials"
          exportTitle="Raw Materials"
          rowActions={rowActions}
          toolbarExtra={
            <select value={filter} onChange={e => setFilter(e.target.value)}
              style={{ padding: '0.45rem 0.6rem', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: '0.875rem' }}>
              <option value="All">All Types</option>
              <option value="Raw Material">Raw Material</option>
              <option value="Packaging Material">Packaging Material</option>
            </select>
          }
        />
      )}

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Material' : 'Add Material'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <ErrorState message={formError} />}
                <div className="form-group"><label>Material Name</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required /></div>
                <div className="grid-2">
                  <div className="form-group"><label>Unit</label><input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} placeholder="kg, L, pcs…" /></div>
                  <div className="form-group"><label>Type</label>
                    <select value={form.type_of_material} onChange={e => setForm(f => ({ ...f, type_of_material: e.target.value }))}>
                      <option>Raw Material</option><option>Packaging Material</option>
                    </select>
                  </div>
                </div>
                <div className="grid-2">
                  <div className="form-group">
                    <label>{editRow ? 'Qty Balance' : 'Opening Qty'}</label>
                    <NumberInput value={form.qty_balance} onChange={v => setForm(f => ({ ...f, qty_balance: v }))} disabled={!!editRow} />
                    {editRow && <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Stock changes only via purchases, production &amp; sales — keeps the ledger honest.</small>}
                  </div>
                  <div className="form-group"><label>Min Stock Level (alert)</label><NumberInput value={form.min_stock_level} onChange={v => setForm(f => ({ ...f, min_stock_level: v }))} /></div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={pending}>
                  {pending ? 'Saving…' : editRow ? 'Update' : 'Save'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {deleteRow && (
        <ConfirmDialog
          title="Delete Material"
          message={<>Delete <strong>{deleteRow.name}</strong>? This cannot be undone.</>}
          confirmLabel="Delete"
          pending={removeMut.pending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteRow(null)}
        />
      )}
    </div>
  );
}
