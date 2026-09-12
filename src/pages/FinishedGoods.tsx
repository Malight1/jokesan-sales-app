import React, { useMemo, useState } from 'react';
import { Plus, X, Pencil, Trash2, ScanLine, Wand2, Printer, SlidersHorizontal } from 'lucide-react';
import { finishedGoods as goodsApi, stock, FinishedGood, StockLevel } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { useBranches } from '../lib/useBranches';
import { qtyByProduct } from '../lib/branchStock';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import BarcodeScanner from '../components/BarcodeScanner';
import NumberInput from '../components/NumberInput';
import AdjustStockModal from '../components/AdjustStockModal';
import { printBarcodeLabels, generateBarcode } from '../lib/barcodeLabels';
import { hasFeature, planFor } from '../lib/features';
import Modal from '../components/Modal';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString();
// Opening stock goes through Adjust Stock (migration 0020) so it lands at a
// branch with a cost. Stock typed straight into qty_balance had no FIFO
// batch behind it, and the till refused to sell it ("Stock/batch mismatch").
const emptyForm = {
  name: '', unit: 'pcs', selling_price: 0, min_stock_level: 10, default_markup: 1.5, barcode: '',
  openingQty: 0, openingCost: 0,
  // Batch and expiry (migration 0022)
  track_batches: false, shelf_life_days: 0, pick_rule: 'fifo' as 'fifo' | 'fefo', batch_prefix: '', nafdac_no: '',
};

export default function FinishedGoods() {
  const toast = useToast();
  // A cashier can see products (the till needs them) but not change them —
  // materials/finished_goods writes are admin+inventory in the database
  // (migration 0017). Hide the controls rather than fail on save.
  const { profile, tenant } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const canEditStock = isAdmin || profile?.role === 'inventory';
  const tracking = hasFeature(tenant?.plan, 'batch_tracking');
  const { multi, myBranchId, myBranchName } = useBranches();
  const { data: rows, loading, error, refetch } = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const levelsQ = useQuery<StockLevel[]>(() => stock.levels(null), []);
  const createMut = useMutation(goodsApi.create);
  const updateMut = useMutation((id: string, g: Partial<FinishedGood>) => goodsApi.update(id, g));
  const removeMut = useMutation(goodsApi.remove);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<FinishedGood | null>(null);
  const [deleteRow, setDeleteRow] = useState<FinishedGood | null>(null);
  const [adjustRow, setAdjustRow] = useState<FinishedGood | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showScanner, setShowScanner] = useState(false);

  const fgLevels = useMemo(
    () => (levelsQ.data ?? []).filter(l => l.product_kind === 'finished_good'), [levelsQ.data]);
  const here = useMemo(() => qtyByProduct(fgLevels, myBranchId), [fgLevels, myBranchId]);
  const qtyHere = (g: FinishedGood) => (multi && levelsQ.data ? here.get(g.id) ?? 0 : g.qty_balance);
  const qtyAt = (id: string) => (branchId: string) =>
    levelsQ.data ? qtyByProduct(fgLevels, branchId).get(id) ?? 0 : 0;

  const openCreate = () => { setEditRow(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (g: FinishedGood) => {
    setEditRow(g);
    setForm({
      name: g.name, unit: g.unit ?? 'pcs', selling_price: g.selling_price, min_stock_level: g.min_stock_level,
      default_markup: g.default_markup, barcode: g.barcode ?? '', openingQty: 0, openingCost: 0,
      track_batches: !!g.track_batches, shelf_life_days: g.shelf_life_days ?? 0, pick_rule: g.pick_rule ?? 'fifo',
      batch_prefix: g.batch_prefix ?? '', nafdac_no: g.nafdac_no ?? '',
    });
    setShowModal(true);
  };

  const reload = () => { refetch(); levelsQ.refetch(); };

  // Batch columns exist once migration 0022 has run; until then, don't send
  // them (Postgres would reject the whole save).
  const schemaHasBatches = (rows ?? []).some(r => 'track_batches' in r);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const { openingQty, openingCost, barcode, track_batches, shelf_life_days, pick_rule, batch_prefix, nafdac_no, ...editable } = form;
    const batchFields = {
      track_batches, pick_rule,
      shelf_life_days: shelf_life_days > 0 ? Math.round(shelf_life_days) : null,
      batch_prefix: batch_prefix.trim() || null,
      nafdac_no: nafdac_no.trim() || null,
    };
    const touchedBatch = track_batches || pick_rule !== 'fifo' || shelf_life_days > 0 || !!batch_prefix.trim() || !!nafdac_no.trim();
    const payload = {
      ...editable, barcode: barcode.trim() || null,
      ...(schemaHasBatches || touchedBatch ? batchFields : {}),
    };
    const res = editRow ? await updateMut.mutate(editRow.id, payload) : await createMut.mutate(payload);
    if (!res) {
      toast.error((editRow ? updateMut.error : createMut.error) ?? 'Something went wrong.');
      return;
    }
    if (!editRow && openingQty > 0) {
      try {
        await stock.adjust({
          branchId: myBranchId, kind: 'finished_good', productId: (res as FinishedGood).id,
          qtyDelta: openingQty, unitCost: openingCost || null, reason: 'Opening balance',
        });
      } catch (err: any) {
        toast.error(`${form.name} was added, but its opening stock wasn't: ${err?.message ?? 'unknown error'}. Use Adjust stock to add it.`);
      }
    }
    toast.success(editRow ? 'Product updated.' : 'Product added.');
    setShowModal(false);
    setForm(emptyForm);
    setEditRow(null);
    reload();
  };

  const handleDelete = async () => {
    if (!deleteRow) return;
    const res = await removeMut.mutate(deleteRow.id);
    if (res !== null) {
      toast.success('Product deleted.');
      setDeleteRow(null);
      reload();
    } else {
      const msg = removeMut.error ?? '';
      toast.error(msg.includes('foreign key') || msg.includes('violates')
        ? 'Cannot delete — this product has sales, production runs, or a recipe linked.'
        : msg || 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const stockClass = (g: FinishedGood) => qtyHere(g) <= 0 ? 'badge-danger' : qtyHere(g) <= g.min_stock_level ? 'badge-warning' : 'badge-success';
  const stockLabel = (g: FinishedGood) => qtyHere(g) <= 0 ? 'Out of stock' : qtyHere(g) <= g.min_stock_level ? 'Low stock' : 'In stock';

  const qtyColumns: Column<FinishedGood>[] = multi
    ? [
        { key: 'here', header: `At ${myBranchName}`, align: 'right', value: g => qtyHere(g), render: g => <strong>{qtyHere(g).toLocaleString()}</strong> },
        { key: 'qty_balance', header: 'All branches', align: 'right', value: g => g.qty_balance, render: g => g.qty_balance.toLocaleString() },
      ]
    : [
        { key: 'qty_balance', header: 'Stock Qty', align: 'right', value: g => g.qty_balance, render: g => g.qty_balance.toLocaleString() },
      ];

  const columns: Column<FinishedGood>[] = [
    { key: 'name', header: 'Product', value: g => g.name, render: g => <strong>{g.name}</strong> },
    { key: 'unit', header: 'Unit', value: g => g.unit ?? '' },
    { key: 'selling_price', header: 'Selling Price', align: 'right', value: g => g.selling_price, render: g => fmt(g.selling_price) },
    ...qtyColumns,
    { key: 'value', header: multi ? 'Stock Value (all)' : 'Stock Value', align: 'right', value: g => g.selling_price * g.qty_balance, render: g => fmt(g.selling_price * g.qty_balance) },
    { key: 'status', header: 'Status', value: g => stockLabel(g), render: g => <span className={stockClass(g)}>{stockLabel(g)}</span> },
  ];

  const rowActions: RowAction<FinishedGood>[] = [
    { icon: <SlidersHorizontal size={15} />, label: 'Adjust stock', onClick: setAdjustRow },
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;

  const printLabels = async () => {
    const withCodes = (rows ?? []).filter(g => g.barcode);
    if (withCodes.length === 0) { toast.error('No products have a barcode yet. Add one via Edit first.'); return; }
    try {
      await printBarcodeLabels(withCodes.map(g => ({ name: g.name, barcode: g.barcode!, priceLabel: fmt(g.selling_price) })), 'Finished Goods Labels');
    } catch {
      toast.error('Could not build the label sheet. Please try again.');
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Finished Goods</h1>
          <p>{rows ? `${rows.length} products${multi ? ` · showing ${myBranchName}` : ''}` : ' '}</p>
        </div>
        {canEditStock && <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Product</button>}
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
        rowActions={canEditStock ? rowActions : undefined}
        toolbarExtra={<button className="btn-secondary btn-sm" onClick={printLabels}><Printer size={14} /> Print Labels</button>}
        emptyMessage="No products yet — add your first one, or bring them in from a spreadsheet on Import Data."
      />

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
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
                  {editRow ? (
                    <div className="form-group">
                      <label>In stock{multi ? ` at ${myBranchName}` : ''}</label>
                      <input value={`${qtyHere(editRow).toLocaleString()} ${editRow.unit ?? ''}`} disabled />
                      <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                        To change stock, use <strong>Adjust stock</strong> on the list — it records why and what it cost.
                      </small>
                    </div>
                  ) : (
                    <div className="form-group">
                      <label>Opening stock{multi ? ` at ${myBranchName}` : ''} (optional)</label>
                      <NumberInput value={form.openingQty} onChange={v => setForm(f => ({ ...f, openingQty: v }))} />
                    </div>
                  )}
                  <div className="form-group"><label>Min Stock Level (alert)</label><NumberInput value={form.min_stock_level} onChange={v => setForm(f => ({ ...f, min_stock_level: v }))} /></div>
                </div>
                {!editRow && form.openingQty > 0 && (
                  <div className="form-group">
                    <label>Cost per unit of that opening stock (₦)</label>
                    <NumberInput value={form.openingCost} onChange={v => setForm(f => ({ ...f, openingCost: v }))} />
                    <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                      What each unit cost you to make or buy. Leave at 0 to estimate it from the selling price ÷ markup — profit on these units is worked out from this.
                    </small>
                  </div>
                )}
                <div className="form-group"><label>Default Markup (× unit cost → auto price)</label><NumberInput value={form.default_markup} onChange={v => setForm(f => ({ ...f, default_markup: v }))} /></div>
                <div className="form-group">
                  <label>Barcode</label>
                  <div style={{ display: 'flex', gap: '0.4rem' }}>
                    <input value={form.barcode} onChange={e => setForm(f => ({ ...f, barcode: e.target.value }))} placeholder="Scan, type, or generate…" style={{ flex: 1 }} />
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setShowScanner(true)} title="Scan with camera"><ScanLine size={14} /></button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setForm(f => ({ ...f, barcode: generateBarcode() }))} title="Generate a code"><Wand2 size={14} /></button>
                  </div>
                </div>

                <hr className="divider" />
                <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>Batches and expiry</p>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.85rem', cursor: tracking || form.track_batches ? 'pointer' : 'not-allowed', marginBottom: '0.75rem' }}>
                  <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={form.track_batches}
                         disabled={!tracking && !form.track_batches}
                         onChange={e => setForm(f => ({ ...f, track_batches: e.target.checked }))} />
                  <span>
                    Track expiry dates for this product
                    <small style={{ display: 'block', color: '#94a3b8', fontSize: '0.72rem' }}>
                      {tracking
                        ? 'Every production run then needs an expiry date, and expired stock can’t be sold.'
                        : `Expiry tracking is on the ${planFor('batch_tracking')} plan and above.`}
                    </small>
                  </span>
                </label>
                {form.track_batches && (
                  <div className="grid-2">
                    <div className="form-group">
                      <label>Shelf life (days)</label>
                      <NumberInput value={form.shelf_life_days} onChange={v => setForm(f => ({ ...f, shelf_life_days: v }))} />
                      <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Fills in the expiry date for each batch. 0 to type it each time.</small>
                    </div>
                    <div className="form-group">
                      <label>Which stock sells first</label>
                      <select value={form.pick_rule} disabled={!tracking && form.pick_rule !== 'fefo'}
                              onChange={e => setForm(f => ({ ...f, pick_rule: e.target.value as 'fifo' | 'fefo' }))}>
                        <option value="fifo">Oldest made first</option>
                        <option value="fefo">Earliest expiry first</option>
                      </select>
                    </div>
                  </div>
                )}
                <div className="grid-2">
                  <div className="form-group">
                    <label>Batch number prefix</label>
                    <input value={form.batch_prefix} maxLength={10} placeholder="e.g. LSOAP"
                           onChange={e => setForm(f => ({ ...f, batch_prefix: e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() }))} />
                    <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                      Batches are numbered {(form.batch_prefix || form.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'PREFIX')}-YYMMDD-01
                    </small>
                  </div>
                  <div className="form-group">
                    <label>NAFDAC Reg. No.</label>
                    <input value={form.nafdac_no} maxLength={30} placeholder="e.g. A1-1234" onChange={e => setForm(f => ({ ...f, nafdac_no: e.target.value }))} />
                    <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Printed on batch labels.</small>
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
        </Modal>
      )}

      {adjustRow && (
        <AdjustStockModal
          kind="finished_good"
          productId={adjustRow.id}
          productName={adjustRow.name}
          unit={adjustRow.unit}
          qtyAt={multi ? qtyAt(adjustRow.id) : () => adjustRow.qty_balance}
          canChooseBranch={isAdmin}
          tracksBatches={!!adjustRow.track_batches}
          shelfLifeDays={adjustRow.shelf_life_days}
          onClose={() => setAdjustRow(null)}
          onDone={() => { setAdjustRow(null); reload(); }}
        />
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
