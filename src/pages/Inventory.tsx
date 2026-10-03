import React, { useMemo, useState } from 'react';
import { Plus, X, Package, Pencil, Trash2, ScanLine, Wand2, Printer, SlidersHorizontal } from 'lucide-react';
import { materials as materialsApi, stock, customFieldDefs, Material, StockLevel, CustomFieldDef } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { useBranches } from '../lib/useBranches';
import { qtyByProduct, valueAtCostByProduct } from '../lib/branchStock';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import BarcodeScanner from '../components/BarcodeScanner';
import NumberInput from '../components/NumberInput';
import AdjustStockModal from '../components/AdjustStockModal';
import ProductUnitsSection from '../components/ProductUnitsSection';
import CustomFieldsSection from '../components/CustomFieldsSection';
import { printBarcodeLabels, generateBarcode } from '../lib/barcodeLabels';
import { hasFeature, planFor } from '../lib/features';
import Modal from '../components/Modal';

// Opening stock is no longer typed into the item itself. It goes through
// Adjust Stock (migration 0020) so it lands at a branch with a cost — stock
// typed straight into qty_balance had no FIFO layer behind it and could
// never be used in production.
const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const emptyForm = {
  name: '', unit: '', type_of_material: 'Raw Material', min_stock_level: 10, barcode: '',
  openingQty: 0, openingCost: 0,
  // Batch and expiry (migration 0022): records the supplier's batch and
  // expiry on each purchase, and picks earliest-expiry-first in production.
  track_batches: false,
  custom_fields: {} as Record<string, any>,
};

export default function Inventory() {
  const toast = useToast();
  const { profile, tenant } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const tracking = hasFeature(tenant?.plan, 'batch_tracking');
  const { multi, active: activeBranches, myBranchId, myBranchName } = useBranches();
  // A multi-branch company that has only opened its first branch would
  // otherwise get two identical quantity columns.
  const manyBranches = multi && activeBranches.length > 1;
  const { data: rows, loading, error, refetch } = useQuery<Material[]>(() => materialsApi.list(), []);
  const levelsQ = useQuery<StockLevel[]>(() => stock.levels(null), []);
  const { data: customFieldDefsData } = useQuery<CustomFieldDef[]>(() => customFieldDefs.forEntity('material').catch(() => []), []);
  const createMut = useMutation(materialsApi.create);
  const updateMut = useMutation((id: string, m: Partial<Material>) => materialsApi.update(id, m));
  const removeMut = useMutation(materialsApi.remove);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Material | null>(null);
  const [deleteRow, setDeleteRow] = useState<Material | null>(null);
  const [adjustRow, setAdjustRow] = useState<Material | null>(null);
  const [filter, setFilter] = useState('All');
  const [form, setForm] = useState(emptyForm);
  const [showScanner, setShowScanner] = useState(false);

  const matLevels = useMemo(
    () => (levelsQ.data ?? []).filter(l => l.product_kind === 'material'), [levelsQ.data]);
  const here = useMemo(() => qtyByProduct(matLevels, myBranchId), [matLevels, myBranchId]);
  // What's on THIS branch's shelf. For a single-location company that's the
  // same as the company total.
  const qtyHere = (m: Material) => (multi && levelsQ.data ? here.get(m.id) ?? 0 : m.qty_balance);
  // Cash tied up at cost (migration 0048) — real money for accounts/admin
  // only; everyone else's rows come back with value_at_cost null, so
  // costAt.has() is false and the column is left out rather than shown as ₦0.
  const costAt = useMemo(() => valueAtCostByProduct(matLevels), [matLevels]);
  const showCost = matLevels.length > 0 && costAt.has(matLevels[0].product_id);
  const qtyAt = (id: string) => (branchId: string) =>
    levelsQ.data ? qtyByProduct(matLevels, branchId).get(id) ?? 0 : 0;

  const openCreate = () => { setEditRow(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (m: Material) => {
    setEditRow(m);
    setForm({
      name: m.name, unit: m.unit ?? '', type_of_material: m.type_of_material,
      min_stock_level: m.min_stock_level, barcode: m.barcode ?? '', openingQty: 0, openingCost: 0,
      track_batches: !!m.track_batches, custom_fields: m.custom_fields ?? {},
    });
    setShowModal(true);
  };

  const reload = () => { refetch(); levelsQ.refetch(); };

  // The track_batches/custom_fields columns exist once their migrations
  // have run; until then, don't send them (Postgres would reject the save).
  const schemaHasBatches = (rows ?? []).some(r => 'track_batches' in r);
  const schemaHasCustomFields = (rows ?? []).some(r => 'custom_fields' in r);

  // A USB barcode scanner types the code then presses Enter, which would
  // otherwise submit this form halfway through filling it in. Move on instead.
  const barcodeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const fields = Array.from(e.currentTarget.form?.querySelectorAll<HTMLElement>('input:not([disabled]), select:not([disabled])') ?? []);
    fields[fields.indexOf(e.currentTarget) + 1]?.focus();
  };

  const friendlySaveError = (msg: string | null) =>
    msg && /duplicate|unique/i.test(msg) && /barcode/i.test(msg)
      ? `Another material already uses barcode ${form.barcode.trim()}. Scan or type a different one, or leave it blank.`
      : msg;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error('Enter a material name.'); return; }
    const { openingQty, openingCost, barcode, track_batches, custom_fields, name, ...rest } = form;
    const editable = { ...rest, name: name.trim() };
    const payload = {
      ...editable, barcode: barcode.trim() || null,
      ...(schemaHasBatches || track_batches ? { track_batches } : {}),
      ...(schemaHasCustomFields || Object.keys(custom_fields).length > 0 ? { custom_fields } : {}),
    };
    const res = editRow ? await updateMut.mutate(editRow.id, payload) : await createMut.mutate(payload);
    if (!res) {
      toast.error(friendlySaveError(editRow ? updateMut.error : createMut.error) ?? 'Something went wrong.');
      return;
    }
    if (!editRow && openingQty > 0) {
      try {
        await stock.adjust({
          branchId: myBranchId, kind: 'material', productId: (res as Material).id,
          qtyDelta: openingQty, unitCost: openingCost || null, reason: 'Opening balance',
        });
      } catch (err: any) {
        toast.error(`${form.name} was added, but its opening stock wasn't: ${err?.message ?? 'unknown error'}. Use Adjust stock to add it.`);
      }
    }
    toast.success(editRow ? 'Material updated.' : `${editable.name} added.`);
    setShowModal(false);
    setForm(emptyForm);
    setEditRow(null);
    reload();
  };

  const handleDelete = async () => {
    if (!deleteRow) return;
    const res = await removeMut.mutate(deleteRow.id);
    if (res !== null) {
      toast.success('Material deleted.');
      setDeleteRow(null);
      reload();
    } else {
      const msg = removeMut.error ?? '';
      toast.error(msg.includes('foreign key') || msg.includes('violates')
        ? `${deleteRow.name} can't be deleted because it's used in purchases, recipes, or production.`
        : msg || 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const stockClass = (m: Material) => qtyHere(m) <= 0 ? 'badge-danger' : qtyHere(m) <= m.min_stock_level ? 'badge-warning' : 'badge-success';
  const stockLabel = (m: Material) => qtyHere(m) <= 0 ? 'Out of stock' : qtyHere(m) <= m.min_stock_level ? 'Low stock' : 'In stock';

  const filtered = (rows ?? []).filter(m => filter === 'All' || m.type_of_material === filter);

  const printLabels = async () => {
    const withCodes = filtered.filter(m => m.barcode);
    if (withCodes.length === 0) { toast.error('No materials have a barcode yet. Add one via Edit first.'); return; }
    try {
      await printBarcodeLabels(withCodes.map(m => ({ name: m.name, barcode: m.barcode! })), 'Raw Material Labels');
    } catch {
      toast.error('Could not build the label sheet. Please try again.');
    }
  };

  const qtyColumns: Column<Material>[] = manyBranches
    ? [
        { key: 'here', header: `At ${myBranchName}`, align: 'right', value: m => qtyHere(m), render: m => <strong>{qtyHere(m).toLocaleString()}</strong> },
        { key: 'qty_balance', header: 'All branches', align: 'right', value: m => m.qty_balance, render: m => m.qty_balance.toLocaleString() },
      ]
    : [
        { key: 'here', header: 'Qty Balance', align: 'right', value: m => qtyHere(m), render: m => <strong>{qtyHere(m).toLocaleString()}</strong> },
      ];

  const columns: Column<Material>[] = [
    { key: 'name', header: 'Material', value: m => m.name,
      render: m => <><strong>{m.name}</strong>{m.barcode && <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>{m.barcode}</div>}</> },
    { key: 'type_of_material', header: 'Type', value: m => m.type_of_material },
    { key: 'unit', header: 'Unit', value: m => m.unit ?? '—' },
    ...qtyColumns,
    { key: 'min_stock_level', header: 'Min Level', align: 'right', value: m => m.min_stock_level, render: m => m.min_stock_level.toLocaleString() },
    // Real money for accounts/admin only (migration 0048) — sales can't
    // reach this page, but inventory can, and isn't accounts.
    ...(showCost ? [{ key: 'cost_value', header: 'Value at Cost', align: 'right' as const,
        value: (m: Material) => costAt.get(m.id), render: (m: Material) => fmt(costAt.get(m.id)) }] : []),
    { key: 'status', header: 'Status', value: m => stockLabel(m), render: m => <span className={stockClass(m)}>{stockLabel(m)}</span> },
  ];

  const rowActions: RowAction<Material>[] = [
    { icon: <SlidersHorizontal size={15} />, label: 'Adjust stock', onClick: setAdjustRow },
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Raw Materials</h1>
          <p>{rows ? `${rows.length} items tracked${manyBranches ? ` · showing ${myBranchName}` : ''}` : ' '}</p>
        </div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Material</button>
      </div>

      {loading && <Loading label="Loading materials…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}

      {!loading && !error && rows && rows.length === 0 && (
        <div className="card" style={{ textAlign: 'center', padding: '2.5rem 1rem' }}>
          <Package size={28} color="#2563eb" style={{ marginBottom: '0.5rem' }} />
          <h3 style={{ marginBottom: '0.35rem' }}>No raw materials yet</h3>
          <p style={{ color: '#64748b', fontSize: '0.875rem', marginBottom: '1rem' }}>
            Add the materials you buy and use in production. You can also bring them in from a
            spreadsheet on the Import Data page.
          </p>
          <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Material</button>
        </div>
      )}

      {!loading && !error && rows && rows.length > 0 && (
        <DataTable
          columns={columns}
          rows={filtered}
          getRowKey={m => m.id}
          searchKeys={[m => m.name, m => m.type_of_material, m => m.barcode ?? '']}
          searchPlaceholder="Search by name or scan a barcode…"
          exportName="raw-materials"
          exportTitle="Raw Materials"
          rowActions={rowActions}
          toolbarExtra={
            <>
              <select value={filter} onChange={e => setFilter(e.target.value)}
                style={{ padding: '0.45rem 0.6rem', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: '0.875rem' }}>
                <option value="All">All Types</option>
                <option value="Raw Material">Raw Material</option>
                <option value="Packaging Material">Packaging Material</option>
              </select>
              <button className="btn-secondary btn-sm" onClick={printLabels}><Printer size={14} /> Print Labels</button>
            </>
          }
        />
      )}

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Material' : 'Add Material'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <ErrorState message={formError} />}
                <div className="form-group">
                  <label htmlFor="mat-name">Material name</label>
                  <input id="mat-name" value={form.name} placeholder="e.g. Palm Oil"
                         onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label htmlFor="mat-barcode">Barcode (optional)</label>
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <input id="mat-barcode" value={form.barcode} onChange={e => setForm(f => ({ ...f, barcode: e.target.value }))} onKeyDown={barcodeKeyDown}
                           placeholder="Scan the pack, type it, or generate one" style={{ flex: '1 1 12rem', minWidth: 0 }} />
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setShowScanner(true)} title="Scan with camera"><ScanLine size={14} /> Scan</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setForm(f => ({ ...f, barcode: generateBarcode() }))} title="Generate a code"><Wand2 size={14} /> Generate</button>
                  </div>
                </div>
                <div className="grid-2">
                  <div className="form-group">
                    <label htmlFor="mat-unit">Unit</label>
                    <input id="mat-unit" value={form.unit} list="mat-unit-options" placeholder="kg, L, pcs…" onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} />
                    <datalist id="mat-unit-options">
                      {['kg', 'g', 'litre', 'ml', 'pcs', 'bag', 'roll', 'carton', 'sheet'].map(u => <option key={u} value={u} />)}
                    </datalist>
                  </div>
                  <div className="form-group">
                    <label htmlFor="mat-type">Type</label>
                    <select id="mat-type" value={form.type_of_material} onChange={e => setForm(f => ({ ...f, type_of_material: e.target.value }))}>
                      <option>Raw Material</option><option>Packaging Material</option>
                    </select>
                  </div>
                </div>
                <div className="grid-2">
                  {editRow ? (
                    <div className="form-group">
                      <label>In stock{manyBranches ? ` at ${myBranchName}` : ''}</label>
                      <input value={`${qtyHere(editRow).toLocaleString()} ${editRow.unit ?? ''}`} disabled />
                      <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                        To change stock, use <strong>Adjust stock</strong> on the list. It records why and what it cost.
                      </small>
                    </div>
                  ) : (
                    <div className="form-group">
                      <label htmlFor="mat-open">Opening stock{manyBranches ? ` at ${myBranchName}` : ''} (optional)</label>
                      <NumberInput id="mat-open" value={form.openingQty} placeholder="0" onChange={v => setForm(f => ({ ...f, openingQty: v }))} />
                    </div>
                  )}
                  <div className="form-group"><label htmlFor="mat-min">Min Stock Level (alert)</label><NumberInput id="mat-min" value={form.min_stock_level} onChange={v => setForm(f => ({ ...f, min_stock_level: v }))} /></div>
                </div>
                {!editRow && form.openingQty > 0 && (
                  <div className="form-group">
                    <label htmlFor="mat-cost">Cost per unit of that opening stock (₦)</label>
                    <NumberInput id="mat-cost" value={form.openingCost} placeholder="0" onChange={v => setForm(f => ({ ...f, openingCost: v }))} />
                    <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                      What you paid for each unit. Production costs are worked out from this.
                    </small>
                  </div>
                )}

                <hr className="divider" />
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.85rem', cursor: tracking || form.track_batches ? 'pointer' : 'not-allowed' }}>
                  <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={form.track_batches}
                         disabled={!tracking && !form.track_batches}
                         onChange={e => setForm(f => ({ ...f, track_batches: e.target.checked }))} />
                  <span>
                    Track supplier batch numbers and expiry
                    <small style={{ display: 'block', color: '#94a3b8', fontSize: '0.72rem' }}>
                      {tracking
                        ? 'Purchases of this material ask for a batch number and expiry date, and production uses the earliest-expiry batch first.'
                        : `Batch and expiry tracking is on the ${planFor('batch_tracking')} plan and above.`}
                    </small>
                  </span>
                </label>

                {editRow && <ProductUnitsSection productKind="material" productId={editRow.id} baseUnitLabel={form.unit} />}
                <CustomFieldsSection defs={customFieldDefsData} values={form.custom_fields}
                  onChange={cf => setForm(f => ({ ...f, custom_fields: cf }))} />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={pending || !form.name.trim()}>
                  {pending ? 'Saving…' : editRow ? 'Save Changes' : 'Add Material'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {adjustRow && (
        <AdjustStockModal
          kind="material"
          productId={adjustRow.id}
          productName={adjustRow.name}
          unit={adjustRow.unit}
          qtyAt={manyBranches ? qtyAt(adjustRow.id) : () => adjustRow.qty_balance}
          canChooseBranch={isAdmin}
          tracksBatches={!!adjustRow.track_batches}
          onClose={() => setAdjustRow(null)}
          onDone={() => { setAdjustRow(null); reload(); }}
        />
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

      {showScanner && (
        <BarcodeScanner
          onScan={code => setForm(f => ({ ...f, barcode: code }))}
          onClose={() => setShowScanner(false)}
        />
      )}
    </div>
  );
}
