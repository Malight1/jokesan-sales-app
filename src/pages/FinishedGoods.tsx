import React, { useState } from 'react';
import { Plus, X, Pencil, Trash2, ScanLine, Wand2, Printer } from 'lucide-react';
import { finishedGoods as goodsApi, FinishedGood } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import BarcodeScanner from '../components/BarcodeScanner';
import NumberInput from '../components/NumberInput';
import { printBarcodeLabels, generateBarcode } from '../lib/barcodeLabels';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString();
const emptyForm = { name: '', unit: 'pcs', selling_price: 0, qty_balance: 0, min_stock_level: 10, default_markup: 1.5, barcode: '' };

export default function FinishedGoods() {
  const toast = useToast();
  const { data: rows, loading, error, refetch } = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const createMut = useMutation(goodsApi.create);
  const updateMut = useMutation((id: string, g: Partial<FinishedGood>) => goodsApi.update(id, g));
  const removeMut = useMutation(goodsApi.remove);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<FinishedGood | null>(null);
  const [deleteRow, setDeleteRow] = useState<FinishedGood | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showScanner, setShowScanner] = useState(false);

  const openCreate = () => { setEditRow(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (g: FinishedGood) => {
    setEditRow(g);
    setForm({ name: g.name, unit: g.unit ?? 'pcs', selling_price: g.selling_price, qty_balance: g.qty_balance, min_stock_level: g.min_stock_level, default_markup: g.default_markup, barcode: g.barcode ?? '' });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // On edit, exclude qty_balance — stock only moves via production & sales.
    const { qty_balance, barcode, ...editable } = form;
    const payload = { ...editable, barcode: barcode.trim() || null };
    const res = editRow ? await updateMut.mutate(editRow.id, payload) : await createMut.mutate({ ...payload, qty_balance });
    if (res) {
      toast.success(editRow ? 'Product updated.' : 'Product added.');
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
      toast.success('Product deleted.');
      setDeleteRow(null);
      refetch();
    } else {
      const msg = removeMut.error ?? '';
      toast.error(msg.includes('foreign key') || msg.includes('violates')
        ? 'Cannot delete — this product has sales, production runs, or a recipe linked.'
        : msg || 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const stockClass = (g: FinishedGood) => g.qty_balance === 0 ? 'badge-danger' : g.qty_balance <= g.min_stock_level ? 'badge-warning' : 'badge-success';
  const stockLabel = (g: FinishedGood) => g.qty_balance === 0 ? 'Out of stock' : g.qty_balance <= g.min_stock_level ? 'Low stock' : 'In stock';

  const columns: Column<FinishedGood>[] = [
    { key: 'name', header: 'Product', value: g => g.name, render: g => <strong>{g.name}</strong> },
    { key: 'unit', header: 'Unit', value: g => g.unit ?? '' },
    { key: 'selling_price', header: 'Selling Price', align: 'right', value: g => g.selling_price, render: g => fmt(g.selling_price) },
    { key: 'qty_balance', header: 'Stock Qty', align: 'right', value: g => g.qty_balance, render: g => g.qty_balance.toLocaleString() },
    { key: 'value', header: 'Stock Value', align: 'right', value: g => g.selling_price * g.qty_balance, render: g => fmt(g.selling_price * g.qty_balance) },
    { key: 'status', header: 'Status', value: g => stockLabel(g), render: g => <span className={stockClass(g)}>{stockLabel(g)}</span> },
  ];

  const rowActions: RowAction<FinishedGood>[] = [
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;

  const printLabels = () => {
    const withCodes = (rows ?? []).filter(g => g.barcode);
    if (withCodes.length === 0) { toast.error('No products have a barcode yet. Add one via Edit first.'); return; }
    printBarcodeLabels(withCodes.map(g => ({ name: g.name, barcode: g.barcode!, priceLabel: fmt(g.selling_price) })), 'Finished Goods Labels');
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Finished Goods</h1><p>{rows ? `${rows.length} products` : ' '}</p></div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Product</button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={g => g.id}
        searchKeys={[g => g.name]}
        searchPlaceholder="Search products…"
        exportName="finished-goods"
        exportTitle="Finished Goods"
        rowActions={rowActions}
        toolbarExtra={<button className="btn-secondary btn-sm" onClick={printLabels}><Printer size={14} /> Print Labels</button>}
        emptyMessage="No products yet. Add one, or load sample data from Raw Materials."
      />

      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Product' : 'Add Finished Good'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <ErrorState message={formError} />}
                <div className="form-group"><label>Product Name</label><input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required /></div>
                <div className="grid-2">
                  <div className="form-group"><label>Unit</label><input value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} /></div>
                  <div className="form-group"><label>Selling Price (₦)</label><NumberInput value={form.selling_price} onChange={v => setForm(f => ({ ...f, selling_price: v }))} /></div>
                </div>
                <div className="grid-2">
                  <div className="form-group">
                    <label>{editRow ? 'Stock Qty' : 'Opening Stock Qty'}</label>
                    <NumberInput value={form.qty_balance} onChange={v => setForm(f => ({ ...f, qty_balance: v }))} disabled={!!editRow} />
                    {editRow && <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Stock changes only via production &amp; sales.</small>}
                  </div>
                  <div className="form-group"><label>Min Stock Level (alert)</label><NumberInput value={form.min_stock_level} onChange={v => setForm(f => ({ ...f, min_stock_level: v }))} /></div>
                </div>
                <div className="form-group"><label>Default Markup (× unit cost → auto price)</label><NumberInput value={form.default_markup} onChange={v => setForm(f => ({ ...f, default_markup: v }))} /></div>
                <div className="form-group">
                  <label>Barcode</label>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <input value={form.barcode} onChange={e => setForm(f => ({ ...f, barcode: e.target.value }))} placeholder="Scan, type, or generate…" style={{ flex: 1 }} />
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setShowScanner(true)} title="Scan with camera"><ScanLine size={14} /></button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setForm(f => ({ ...f, barcode: generateBarcode() }))} title="Generate a code"><Wand2 size={14} /></button>
                  </div>
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
          title="Delete Product"
          message={<>Delete <strong>{deleteRow.name}</strong>? This cannot be undone.</>}
          confirmLabel="Delete"
          pending={removeMut.pending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteRow(null)}
        />
      )}

      {showScanner && (
        <BarcodeScanner
          onScan={code => setForm(f => ({ ...f, barcode: code }))}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}
