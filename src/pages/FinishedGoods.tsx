import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, X, Pencil, Trash2, ScanLine, Wand2, Printer, SlidersHorizontal, PackagePlus } from 'lucide-react';
import { finishedGoods as goodsApi, stock, customFieldDefs, FinishedGood, StockLevel, CustomFieldDef } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { useBranches } from '../lib/useBranches';
import { qtyByProduct, valueAtCostByProduct } from '../lib/branchStock';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import BarcodeScanner from '../components/BarcodeScanner';
import NumberInput from '../components/NumberInput';
import AdjustStockModal from '../components/AdjustStockModal';
import ProductUnitsSection from '../components/ProductUnitsSection';
import CustomFieldsSection from '../components/CustomFieldsSection';
import { printBarcodeLabels, generateBarcode } from '../lib/barcodeLabels';
import { hasFeature, planFor } from '../lib/features';
import { isRetail, label } from '../retail';
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
  // E-invoicing (NRS) readiness (migration 0035, Phase 7c)
  tax_category: '', classification_code: '',
  custom_fields: {} as Record<string, any>,
};

export default function FinishedGoods() {
  const toast = useToast();
  // A cashier can see products (the till needs them) but not change them —
  // materials/finished_goods writes are admin+inventory in the database
  // (migration 0017). Hide the controls rather than fail on save.
  const { profile, tenant } = useAuth();
  const retail = isRetail(tenant);
  const isAdmin = profile?.role === 'admin';
  const canEditStock = isAdmin || profile?.role === 'inventory';
  const tracking = hasFeature(tenant?.plan, 'batch_tracking');
  const { multi, active: activeBranches, myBranchId, myBranchName } = useBranches();
  // A multi-branch company that has only opened its first branch would
  // otherwise get two identical quantity columns.
  const manyBranches = multi && activeBranches.length > 1;
  const navigate = useNavigate();
  const { data: rows, loading, error, refetch } = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const levelsQ = useQuery<StockLevel[]>(() => stock.levels(null), []);
  const { data: customFieldDefsData } = useQuery<CustomFieldDef[]>(() => customFieldDefs.forEntity('finished_good').catch(() => []), []);
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
  // Cash tied up at cost (migration 0048) — only real money for accounts/
  // admin; everyone else's rows come back with value_at_cost null, so
  // costAt.has() is false and the column is left out rather than shown as ₦0.
  const costAt = useMemo(() => valueAtCostByProduct(fgLevels), [fgLevels]);
  const showCost = fgLevels.length > 0 && costAt.has(fgLevels[0].product_id);
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
      tax_category: g.tax_category ?? '', classification_code: g.classification_code ?? '',
      custom_fields: g.custom_fields ?? {},
    });
    setShowModal(true);
  };

  const reload = () => { refetch(); levelsQ.refetch(); };

  // Batch/custom-field/e-invoicing columns exist once their migrations
  // have run; until then, don't send them (Postgres would reject the save).
  const schemaHasBatches = (rows ?? []).some(r => 'track_batches' in r);
  const schemaHasCustomFields = (rows ?? []).some(r => 'custom_fields' in r);
  const schemaHasEinvoiceFields = (rows ?? []).some(r => 'tax_category' in r);

  // A shop's product needs a price before the till can sell it, and its
  // opening stock needs a real cost or every sale of it reports a made-up
  // profit. Manufacturing can leave both: production runs price and cost it.
  const formBlocker =
    !form.name.trim() ? 'Enter a product name'
    : retail && !(form.selling_price > 0) ? 'Enter the selling price'
    : retail && !editRow && form.openingQty > 0 && !(form.openingCost > 0) ? 'Enter what each one cost you'
    : null;
  const margin = form.selling_price > 0 && form.openingCost > 0
    ? (form.selling_price - form.openingCost) / form.selling_price : null;

  // A USB barcode scanner types the code then presses Enter, which would
  // submit this form halfway through filling it in. Move on instead.
  const barcodeKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const fields = Array.from(e.currentTarget.form?.querySelectorAll<HTMLElement>('input:not([disabled]), select:not([disabled])') ?? []);
    fields[fields.indexOf(e.currentTarget) + 1]?.focus();
  };

  const friendlySaveError = (msg: string | null) =>
    msg && /duplicate|unique/i.test(msg) && /barcode/i.test(msg)
      ? `Another product already uses barcode ${form.barcode.trim()}. Scan or type a different one, or leave it blank.`
      : msg;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (formBlocker) { toast.error(formBlocker + '.'); return; }
    const { openingQty, openingCost, barcode, track_batches, shelf_life_days, pick_rule, batch_prefix, nafdac_no,
            tax_category, classification_code, custom_fields, name, ...rest } = form;
    const editable = { ...rest, name: name.trim() };
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
      ...(schemaHasEinvoiceFields ? { tax_category: tax_category.trim() || null, classification_code: classification_code.trim() || null } : {}),
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
          branchId: myBranchId, kind: 'finished_good', productId: (res as FinishedGood).id,
          qtyDelta: openingQty, unitCost: openingCost || null, reason: 'Opening balance',
        });
      } catch (err: any) {
        toast.error(`${form.name} was added, but its opening stock wasn't: ${err?.message ?? 'unknown error'}. Use Adjust stock to add it.`);
      }
    }
    toast.success(editRow ? 'Product updated.'
      : retail && openingQty <= 0 ? `${editable.name} added. Use Restock on it when your first delivery arrives.`
      : 'Product added.');
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
        ? label(retail,
            `${deleteRow.name} can't be deleted because it has sales, production runs, or a recipe linked to it.`,
            `${deleteRow.name} can't be deleted because it has sales or purchases recorded against it.`)
        : msg || 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const stockClass = (g: FinishedGood) => qtyHere(g) <= 0 ? 'badge-danger' : qtyHere(g) <= g.min_stock_level ? 'badge-warning' : 'badge-success';
  const stockLabel = (g: FinishedGood) => qtyHere(g) <= 0 ? 'Out of stock' : qtyHere(g) <= g.min_stock_level ? 'Low stock' : 'In stock';

  const qtyColumns: Column<FinishedGood>[] = manyBranches
    ? [
        { key: 'here', header: `At ${myBranchName}`, align: 'right', value: g => qtyHere(g), render: g => <strong>{qtyHere(g).toLocaleString()}</strong> },
        { key: 'qty_balance', header: 'All branches', align: 'right', value: g => g.qty_balance, render: g => g.qty_balance.toLocaleString() },
      ]
    : [
        { key: 'here', header: 'In Stock', align: 'right', value: g => qtyHere(g), render: g => <strong>{qtyHere(g).toLocaleString()}</strong> },
      ];

  // "Value at Price" is priced at what it sells for, not what it cost —
  // named that way rather than a bare "Stock Value" so it isn't mistaken
  // for money tied up. "Value at Cost" (0048) is that actual figure, shown
  // beside it when the signed-in role can see cost at all (accounts/admin;
  // sales and inventory can't, same gate as everywhere else money is).
  const columns: Column<FinishedGood>[] = [
    { key: 'name', header: 'Product', value: g => g.name,
      render: g => <><strong>{g.name}</strong>{g.barcode && <div style={{ fontSize: '0.72rem', color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>{g.barcode}</div>}</> },
    { key: 'unit', header: 'Unit', value: g => g.unit ?? '' },
    { key: 'selling_price', header: 'Selling Price', align: 'right', value: g => g.selling_price,
      render: g => g.selling_price > 0 ? fmt(g.selling_price) : <span className="badge-warning">No price</span> },
    ...qtyColumns,
    { key: 'value', header: manyBranches ? 'Value at Price (all)' : 'Value at Price', align: 'right', value: g => g.selling_price * g.qty_balance, render: g => fmt(g.selling_price * g.qty_balance) },
    ...(showCost ? [{ key: 'cost_value', header: 'Value at Cost', align: 'right' as const,
        value: (g: FinishedGood) => costAt.get(g.id), render: (g: FinishedGood) => fmt(costAt.get(g.id)) }] : []),
    { key: 'status', header: 'Status', value: g => stockLabel(g), render: g => <span className={stockClass(g)}>{stockLabel(g)}</span> },
  ];

  const rowActions: RowAction<FinishedGood>[] = [
    // A shop restocks by buying; a factory's products come from production.
    ...(retail ? [{ icon: <PackagePlus size={15} />, label: 'Restock', onClick: (g: FinishedGood) => navigate(`/purchases?restock=${g.id}`) }] : []),
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
      await printBarcodeLabels(withCodes.map(g => ({ name: g.name, barcode: g.barcode!, priceLabel: fmt(g.selling_price) })), label(retail, 'Finished Goods Labels', 'Product Labels'));
    } catch {
      toast.error('Could not build the label sheet. Please try again.');
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>{label(retail, 'Finished Goods', 'Products')}</h1>
          <p>{rows ? `${rows.length} products${manyBranches ? ` · showing ${myBranchName}` : ''}` : ' '}</p>
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
        searchKeys={[g => g.name, g => g.barcode ?? '']}
        searchPlaceholder="Search by name or scan a barcode…"
        exportName="finished-goods"
        exportTitle={label(retail, 'Finished Goods', 'Products')}
        rowActions={canEditStock ? rowActions : undefined}
        toolbarExtra={<button className="btn-secondary btn-sm" onClick={printLabels}><Printer size={14} /> Print Labels</button>}
        emptyMessage="No products yet. Add your first one, or bring them all in from a spreadsheet on Import Data."
      />

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Product' : label(retail, 'Add Finished Good', 'Add Product')}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <ErrorState message={formError} />}
                <div className="form-group">
                  <label htmlFor="fg-name">Product name</label>
                  <input id="fg-name" value={form.name} placeholder={label(retail, 'e.g. Liquid Soap 1L', 'e.g. Coca-Cola 50cl')}
                         onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
                </div>
                <div className="form-group">
                  <label htmlFor="fg-barcode">Barcode (optional)</label>
                  <div style={{ display: 'flex', gap: '0.4rem', flexWrap: 'wrap' }}>
                    <input id="fg-barcode" value={form.barcode} onChange={e => setForm(f => ({ ...f, barcode: e.target.value }))} onKeyDown={barcodeKeyDown}
                           placeholder="Scan the pack, type it, or generate one" style={{ flex: '1 1 12rem', minWidth: 0 }} />
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setShowScanner(true)} title="Scan with camera"><ScanLine size={14} /> Scan</button>
                    <button type="button" className="btn-secondary btn-sm" onClick={() => setForm(f => ({ ...f, barcode: generateBarcode() }))} title="Make up a code for items with no barcode, then print labels for them"><Wand2 size={14} /> Generate</button>
                  </div>
                  {retail && <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>With a barcode, the till finds this product the moment you scan it.</small>}
                </div>
                <div className="grid-2">
                  <div className="form-group">
                    <label htmlFor="fg-unit">Sold per</label>
                    <input id="fg-unit" value={form.unit} list="fg-unit-options" placeholder="pcs" onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} />
                    <datalist id="fg-unit-options">
                      {['pcs', 'bottle', 'pack', 'carton', 'crate', 'sachet', 'bag', 'kg', 'litre', 'dozen'].map(u => <option key={u} value={u} />)}
                    </datalist>
                  </div>
                  <div className="form-group">
                    <label htmlFor="fg-price">Selling price (₦){retail ? '' : ' (optional)'}</label>
                    <NumberInput id="fg-price" value={form.selling_price} placeholder="0" onChange={v => setForm(f => ({ ...f, selling_price: v }))} />
                    {!retail && <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>Left at 0, production sets it from cost × markup.</small>}
                  </div>
                </div>

                <hr className="divider" />
                <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>Stock</p>
                {editRow ? (
                  <div className="grid-2">
                    <div className="form-group">
                      <label>In stock{manyBranches ? ` at ${myBranchName}` : ''}</label>
                      <input value={`${qtyHere(editRow).toLocaleString()} ${editRow.unit ?? ''}`} disabled />
                      <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                        {label(retail,
                          'To change it, use Adjust stock on the list. It records why and what it cost.',
                          'To add stock, use Restock on the list. To correct a count, use Adjust stock.')}
                      </small>
                    </div>
                    <div className="form-group"><label htmlFor="fg-min">Warn me when stock is at or below</label><NumberInput id="fg-min" value={form.min_stock_level} onChange={v => setForm(f => ({ ...f, min_stock_level: v }))} /></div>
                  </div>
                ) : (
                  <>
                    <div className="grid-2">
                      <div className="form-group">
                        <label htmlFor="fg-open">{retail ? 'How many you have now' : 'Opening stock'}{manyBranches ? ` at ${myBranchName}` : ''}</label>
                        <NumberInput id="fg-open" value={form.openingQty} placeholder="0" onChange={v => setForm(f => ({ ...f, openingQty: v }))} />
                      </div>
                      {(retail || form.openingQty > 0) ? (
                        <div className="form-group">
                          <label htmlFor="fg-cost">{retail ? 'What each one cost you (₦)' : 'Cost per unit of that stock (₦)'}</label>
                          <NumberInput id="fg-cost" value={form.openingCost} placeholder="0" onChange={v => setForm(f => ({ ...f, openingCost: v }))} />
                        </div>
                      ) : <div />}
                    </div>
                    {margin !== null ? (
                      <p style={{ margin: '-0.4rem 0 1rem', fontSize: '0.78rem', fontWeight: 600, color: margin <= 0 ? '#dc2626' : margin < 0.1 ? '#b45309' : '#16a34a' }}>
                        {margin <= 0
                          ? 'This costs you more than it sells for. Check the price.'
                          : `You make ${fmt(Math.round((form.selling_price - form.openingCost) * 100) / 100)} on each one (${Math.round(margin * 100)}% margin).`}
                      </p>
                    ) : (
                      <p style={{ margin: '-0.4rem 0 1rem', fontSize: '0.72rem', color: '#94a3b8' }}>
                        {retail
                          ? 'Leave both at 0 if the shelf is empty. Stock you buy later goes in through Purchases.'
                          : 'Optional. Leave the cost at 0 to estimate it from the selling price ÷ markup.'}
                      </p>
                    )}
                    <div className="grid-2">
                      <div className="form-group"><label htmlFor="fg-min">Warn me when stock is at or below</label><NumberInput id="fg-min" value={form.min_stock_level} onChange={v => setForm(f => ({ ...f, min_stock_level: v }))} /></div>
                      <div />
                    </div>
                  </>
                )}
                {!retail && (
                  <div className="form-group">
                    <label htmlFor="fg-markup">Default markup (× unit cost gives the price)</label>
                    <NumberInput id="fg-markup" value={form.default_markup} onChange={v => setForm(f => ({ ...f, default_markup: v }))} />
                  </div>
                )}

                <hr className="divider" />
                <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>Batches and expiry</p>
                <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, fontSize: '0.85rem', cursor: tracking || form.track_batches ? 'pointer' : 'not-allowed', marginBottom: '0.75rem' }}>
                  <input type="checkbox" style={{ width: 'auto', marginTop: 3 }} checked={form.track_batches}
                         disabled={!tracking && !form.track_batches}
                         onChange={e => setForm(f => ({ ...f, track_batches: e.target.checked }))} />
                  <span>
                    Track expiry dates for this product
                    <small style={{ display: 'block', color: '#94a3b8', fontSize: '0.72rem' }}>
                      {!tracking
                        ? `Expiry tracking is on the ${planFor('batch_tracking')} plan and above.`
                        : retail
                        ? 'Each delivery then records its expiry date, the till sells the earliest-expiring first, and expired stock can\u2019t be sold.'
                        : 'Every production run then needs an expiry date, and expired stock can\u2019t be sold.'}
                    </small>
                  </span>
                </label>
                {form.track_batches && (
                  <div className="grid-2">
                    <div className="form-group">
                      <label htmlFor="fg-shelf">Shelf life (days)</label>
                      <NumberInput id="fg-shelf" value={form.shelf_life_days} placeholder="0" onChange={v => setForm(f => ({ ...f, shelf_life_days: v }))} />
                      <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                        {retail ? 'Suggests an expiry date when you record a delivery. Leave at 0 to type it each time.' : 'Fills in the expiry date for each batch. 0 to type it each time.'}
                      </small>
                    </div>
                    <div className="form-group">
                      <label htmlFor="fg-pick">Which stock sells first</label>
                      <select id="fg-pick" value={form.pick_rule} disabled={!tracking && form.pick_rule !== 'fefo'}
                              onChange={e => setForm(f => ({ ...f, pick_rule: e.target.value as 'fifo' | 'fefo' }))}>
                        <option value="fifo">{retail ? 'Oldest delivery first' : 'Oldest made first'}</option>
                        <option value="fefo">Earliest expiry first</option>
                      </select>
                    </div>
                  </div>
                )}
                <div className="grid-2">
                  {/* Retail stock arrives with the supplier's own batch number
                     (0045); only production numbers batches from this prefix. */}
                  {!retail && <div className="form-group">
                    <label>Batch number prefix</label>
                    <input value={form.batch_prefix} maxLength={10} placeholder="e.g. LSOAP"
                           onChange={e => setForm(f => ({ ...f, batch_prefix: e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase() }))} />
                    <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>
                      Batches are numbered {(form.batch_prefix || form.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 4).toUpperCase() || 'PREFIX')}-YYMMDD-01
                    </small>
                  </div>}
                  <div className="form-group">
                    <label htmlFor="fg-nafdac">NAFDAC Reg. No. (optional)</label>
                    <input id="fg-nafdac" value={form.nafdac_no} maxLength={30} placeholder="e.g. A1-1234" onChange={e => setForm(f => ({ ...f, nafdac_no: e.target.value }))} />
                    <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>{retail ? 'For food, drinks, drugs and cosmetics.' : 'Printed on batch labels.'}</small>
                  </div>
                </div>

                {schemaHasEinvoiceFields && (
                  <>
                    <hr className="divider" />
                    <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>E-invoicing (NRS)</p>
                    <div className="grid-2">
                      <div className="form-group">
                        <label>Tax category</label>
                        <input value={form.tax_category} onChange={e => setForm(f => ({ ...f, tax_category: e.target.value }))} placeholder="e.g. Standard-rated" />
                      </div>
                      <div className="form-group">
                        <label>Classification code</label>
                        <input value={form.classification_code} onChange={e => setForm(f => ({ ...f, classification_code: e.target.value }))} placeholder="Product/service code" />
                      </div>
                    </div>
                  </>
                )}

                {editRow && <ProductUnitsSection productKind="finished_good" productId={editRow.id} baseUnitLabel={form.unit} />}
                <CustomFieldsSection defs={customFieldDefsData} values={form.custom_fields}
                  onChange={cf => setForm(f => ({ ...f, custom_fields: cf }))} />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={pending || !!formBlocker}>
                  {pending ? 'Saving…' : formBlocker ?? (editRow ? 'Save Changes' : 'Add Product')}
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
