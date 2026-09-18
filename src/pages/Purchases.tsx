import React, { useEffect, useState } from 'react';
import { Plus, X, Eye, Wallet, Ban, Undo2, PackagePlus, PackageCheck } from 'lucide-react';
import {
  purchases as purchasesApi, suppliers as suppliersApi, materials as materialsApi, lookups,
  returns as returnsApi, PurchaseOrder, PurchaseOrderLine, Supplier, Material, Lookup,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';
import Modal from '../components/Modal';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
// A supplier return can push balance below zero — that's not a debt anymore,
// it's a credit the supplier owes back (in cash or on the next delivery).
function BalanceFigure({ balance }: { balance: number }) {
  if (balance < 0) return <span style={{ color: '#16a34a', fontWeight: 600 }}>Supplier owes {fmt(-balance)}</span>;
  return <span style={{ color: balance > 0 ? '#dc2626' : 'inherit', fontWeight: balance > 0 ? 600 : 400 }}>{fmt(balance)}</span>;
}

const statusMap: Record<string, { label: string; cls: string }> = {
  full: { label: 'Full Payment', cls: 'badge-success' },
  part: { label: 'Part Payment', cls: 'badge-warning' },
  unpaid: { label: 'Unpaid', cls: 'badge-danger' },
};

// Ordered before received (migration 0029). A purchase with no status
// column yet (pre-migration data) reads as 'received', same as its
// database default — nothing to show differently for it.
const orderStatusMap: Record<string, { label: string; cls: string }> = {
  ordered: { label: 'Ordered', cls: 'badge-primary' },
  partial: { label: 'Partially received', cls: 'badge-warning' },
  received: { label: 'Received', cls: 'badge-success' },
  cancelled: { label: 'Cancelled', cls: 'badge-gray' },
  draft: { label: 'Draft', cls: 'badge-gray' },
};

// Supplier batch and expiry only show for materials that track them (0022).
interface LineItem { material_id: string; qty: number; cost_price: number; supplier_batch_no: string; expiry_date: string; }

export default function Purchases() {
  const toast = useToast();
  // Voiding reverses stock and money. The database enforces admin-only
  // (guard_void, migration 0017) — this just keeps the button off screen
  // rather than letting staff click into a permission error.
  const { profile } = useAuth();
  const isAdmin = profile?.role === 'admin';
  // Recording a purchase is admin+inventory; accounts can still see them
  // and settle supplier payments.
  const canCreatePurchase = isAdmin || profile?.role === 'inventory';
  const canReturn = isAdmin || profile?.role === 'inventory' || profile?.role === 'accounts';
  const { data: rows, loading, error, refetch } = useQuery<PurchaseOrder[]>(() => purchasesApi.list(), []);
  const { data: suppliers } = useQuery<Supplier[]>(() => suppliersApi.list(), []);
  const { data: materials } = useQuery<Material[]>(() => materialsApi.list(), []);
  const { data: payTypes } = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);

  const createMut = useMutation(purchasesApi.create);
  const payMut = useMutation(purchasesApi.addPayment);
  const voidMut = useMutation(purchasesApi.void);

  const [showModal, setShowModal] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [voidFor, setVoidFor] = useState<PurchaseOrder | null>(null);
  const [payFor, setPayFor] = useState<PurchaseOrder | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payType, setPayType] = useState('');
  const [returnFor, setReturnFor] = useState<PurchaseOrder | null>(null);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [receiveFor, setReceiveFor] = useState<PurchaseOrder | null>(null);
  const [cancelFor, setCancelFor] = useState<PurchaseOrder | null>(null);
  const cancelMut = useMutation(purchasesApi.cancelOrder);

  const blankItem = (): LineItem => ({ material_id: '', qty: 1, cost_price: 0, supplier_batch_no: '', expiry_date: '' });
  const tracksBatches = (materialId: string) => !!materials?.find(m => m.id === materialId)?.track_batches;
  const [form, setForm] = useState({
    supplierId: '', date: new Date().toISOString().split('T')[0], paymentTypeId: '', amountPaid: 0,
    items: [blankItem()],
  });

  const supplierName = (id: string | null) => {
    const s = suppliers?.find(x => x.id === id);
    return s ? `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || s.company_store || 'Unknown' : '—';
  };

  const total = form.items.reduce((s, i) => s + i.qty * i.cost_price, 0);

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, blankItem()] }));
  const removeItem = (idx: number) => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  const updateItem = (idx: number, field: keyof LineItem, value: any) =>
    setForm(f => { const items = [...f.items]; (items[idx] as any)[field] = value; return { ...f, items }; });

  const resetForm = () => setForm({
    supplierId: '', date: new Date().toISOString().split('T')[0], paymentTypeId: '', amountPaid: 0, items: [blankItem()],
  });

  const validItems = form.items.filter(i => i.material_id && i.qty > 0 && i.cost_price >= 0);
  const canSubmit = validItems.length > 0 && total > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) { toast.error('Add at least one material with quantity and cost.'); return; }
    const res = await createMut.mutate({
      supplierId: form.supplierId || null,
      date: form.date,
      paymentTypeId: form.paymentTypeId || null,
      amountPaid: Number(form.amountPaid) || 0,
      items: validItems.map(i => ({
        material_id: i.material_id, qty: Number(i.qty), cost_price: Number(i.cost_price),
        ...(i.supplier_batch_no.trim() ? { supplier_batch_no: i.supplier_batch_no.trim() } : {}),
        ...(i.expiry_date ? { expiry_date: i.expiry_date } : {}),
      })),
    });
    if (res) {
      toast.success('Purchase recorded — material stock updated.');
      setShowModal(false);
      resetForm();
      refetch();
    } else if (createMut.error) {
      toast.error(createMut.error);
    }
  };

  const openPay = (po: PurchaseOrder) => {
    setPayFor(po);
    setPayAmount(po.balance);
    setPayType(payTypes?.[0]?.id ?? '');
  };

  const submitPayment = async () => {
    if (!payFor) return;
    if (payAmount <= 0) { toast.error('Enter a payment amount.'); return; }
    const ok = await payMut.mutate(payFor.id, Number(payAmount), payType || null);
    if (ok !== null) {
      toast.success('Payment recorded.');
      setPayFor(null);
      refetch();
    } else if (payMut.error) {
      toast.error(payMut.error);
    }
  };

  const handleVoid = async () => {
    if (!voidFor) return;
    const res = await voidMut.mutate(voidFor.id);
    if (res !== null) {
      toast.success('Purchase voided — material stock reversed.');
      setVoidFor(null);
      refetch();
    } else {
      toast.error(voidMut.error ?? 'Void failed.');
      setVoidFor(null);
    }
  };

  const handleCancelOrder = async () => {
    if (!cancelFor) return;
    const res = await cancelMut.mutate(cancelFor.id, null);
    if (res !== null) {
      toast.success('Order cancelled — whatever already arrived stays in stock.');
      setCancelFor(null);
      refetch();
    } else {
      toast.error(cancelMut.error ?? 'Could not cancel.');
    }
  };

  const columns: Column<PurchaseOrder>[] = [
    { key: 'doc_no', header: 'No.', value: p => p.doc_no ?? '', render: p => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{p.doc_no}</span> },
    { key: 'purchase_date', header: 'Date', value: p => p.purchase_date },
    { key: 'supplier', header: 'Supplier', value: p => supplierName(p.supplier_id) },
    { key: 'order_status', header: 'Order', value: p => p.status ?? 'received',
      render: p => {
        const s = orderStatusMap[p.status ?? 'received'];
        return <span className={s?.cls ?? 'badge-gray'}>{s?.label ?? p.status}</span>;
      } },
    { key: 'total_amount', header: 'Total', align: 'right', value: p => p.total_amount, render: p => fmt(p.total_amount) },
    { key: 'total_paid', header: 'Paid', align: 'right', value: p => p.total_paid, render: p => fmt(p.total_paid) },
    { key: 'balance', header: 'Balance', align: 'right', value: p => p.balance, render: p => <BalanceFigure balance={p.balance} /> },
    { key: 'payment_status', header: 'Payment', value: p => p.voided ? 'Voided' : (statusMap[p.payment_status]?.label ?? p.payment_status),
      render: p => p.voided
        ? <span className="badge-gray" style={{ textDecoration: 'line-through' }}>Voided</span>
        : <span className={statusMap[p.payment_status]?.cls ?? 'badge-gray'}>{statusMap[p.payment_status]?.label ?? p.payment_status}</span> },
  ];

  const rowActions: RowAction<PurchaseOrder>[] = [
    { icon: <PackageCheck size={15} />, label: 'Receive', onClick: setReceiveFor,
      show: p => canCreatePurchase && (p.status === 'ordered' || p.status === 'partial') },
    { icon: <Wallet size={15} />, label: 'Record payment', onClick: openPay, show: p => p.balance > 0 && !p.voided },
    { icon: <Undo2 size={15} />, label: 'Return to supplier', onClick: setReturnFor, show: p => !p.voided && canReturn && p.status !== 'ordered' },
    { icon: <Eye size={15} />, label: 'View', onClick: p => setViewId(p.id) },
    { icon: <Ban size={15} />, label: 'Cancel order', onClick: setCancelFor,
      show: p => canCreatePurchase && (p.status === 'ordered' || p.status === 'partial'), variant: 'danger' },
    { icon: <Ban size={15} />, label: 'Void purchase', onClick: setVoidFor, show: p => !p.voided && isAdmin && (p.status ?? 'received') === 'received', variant: 'danger' },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Purchases</h1>
          <p>{rows ? `${rows.length} purchase orders` : ' '}</p>
        </div>
        {canCreatePurchase && (
          <div style={{ display: 'flex', gap: '0.6rem' }}>
            <button className="btn-secondary" onClick={() => setShowOrderModal(true)}><PackagePlus size={16} /> Order Stock</button>
            <button className="btn-primary" onClick={() => { resetForm(); setShowModal(true); }}><Plus size={16} /> Quick Purchase</button>
          </div>
        )}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={p => p.id}
        searchKeys={[p => supplierName(p.supplier_id), p => p.purchase_date]}
        searchPlaceholder="Search by supplier…"
        exportName="purchases"
        exportTitle="Purchase Orders"
        rowActions={rowActions}
        emptyMessage="No purchases yet. Record your first purchase to add stock."
      />

      {/* New Purchase Modal */}
      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>New Purchase Order</h2>
              <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {createMut.error && <ErrorState message={createMut.error} />}
                <div className="grid-2">
                  <div className="form-group">
                    <label>Supplier</label>
                    <select value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}>
                      <option value="">— select —</option>
                      {suppliers?.map(s => <option key={s.id} value={s.id}>{s.first_name} {s.last_name} — {s.company_store}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Date</label>
                    <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
                  </div>
                </div>

                <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>Items</p>
                {form.items.map((item, idx) => (
                  <div key={idx}>
                    <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.2fr auto', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.5rem' }}>
                      <div className="form-group">
                        <label>Material</label>
                        <select value={item.material_id} onChange={e => updateItem(idx, 'material_id', e.target.value)}>
                          <option value="">— select —</option>
                          {materials?.map(m => <option key={m.id} value={m.id}>{m.name}{m.unit ? ` (${m.unit})` : ''}</option>)}
                        </select>
                      </div>
                      <div className="form-group">
                        <label>Qty</label>
                        <NumberInput value={item.qty} onChange={v => updateItem(idx, 'qty', v)} />
                      </div>
                      <div className="form-group">
                        <label>Unit Cost (₦)</label>
                        <NumberInput value={item.cost_price} onChange={v => updateItem(idx, 'cost_price', v)} />
                      </div>
                      {form.items.length > 1 && (
                        <button type="button" onClick={() => removeItem(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '0.5rem', marginBottom: '1rem' }} title="Remove item" aria-label="Remove this item"><X size={14} /></button>
                      )}
                    </div>
                    {tracksBatches(item.material_id) && (
                      <div className="grid-2" style={{ marginTop: '-0.35rem', marginBottom: '0.5rem' }}>
                        <div className="form-group">
                          <label>Supplier's batch no.</label>
                          <input value={item.supplier_batch_no} maxLength={40} placeholder="As printed on the bag or drum"
                                 onChange={e => updateItem(idx, 'supplier_batch_no', e.target.value)} />
                        </div>
                        <div className="form-group">
                          <label>Expires on</label>
                          <input type="date" value={item.expiry_date} onChange={e => updateItem(idx, 'expiry_date', e.target.value)} />
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                <button type="button" className="btn-ghost btn-sm" onClick={addItem} style={{ marginBottom: '1rem' }}><Plus size={14} /> Add item</button>

                <div style={{ textAlign: 'right', fontWeight: 700, paddingBottom: '1rem', borderBottom: '1px solid #e2e8f0', marginBottom: '1rem' }}>
                  Total: {fmt(total)}
                </div>

                <div className="grid-2">
                  <div className="form-group">
                    <label>Payment Type</label>
                    <select value={form.paymentTypeId} onChange={e => setForm(f => ({ ...f, paymentTypeId: e.target.value }))}>
                      <option value="">— select —</option>
                      {payTypes?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Amount Paid (₦)</label>
                    <NumberInput value={form.amountPaid} onChange={v => setForm(f => ({ ...f, amountPaid: v }))} />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={createMut.pending || !canSubmit}>
                  {createMut.pending ? 'Saving…' : 'Save Purchase'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {/* Record Payment Modal */}
      {payFor && (
        <Modal onClose={() => setPayFor(null)} maxWidth={380}>
            <div className="modal-header">
              <h2>Record Payment</h2>
              <button className="close-btn" onClick={() => setPayFor(null)} aria-label="Close"><X size={18} /></button>
            </div>
            <div className="modal-body">
              {payMut.error && <ErrorState message={payMut.error} />}
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem' }}>
                Outstanding balance: <strong style={{ color: '#dc2626' }}>{fmt(payFor.balance)}</strong>
              </p>
              <div className="form-group">
                <label>Amount (₦)</label>
                <NumberInput value={payAmount} onChange={setPayAmount} />
              </div>
              <div className="form-group">
                <label>Payment Type</label>
                <select value={payType} onChange={e => setPayType(e.target.value)}>
                  <option value="">— select —</option>
                  {payTypes?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setPayFor(null)}>Cancel</button>
              <button type="button" className="btn-primary" disabled={payMut.pending} onClick={submitPayment}>
                {payMut.pending ? 'Saving…' : 'Record Payment'}
              </button>
            </div>
        </Modal>
      )}

      {viewId && (
        <PurchaseDetail
          id={viewId}
          onClose={() => setViewId(null)}
          supplierName={supplierName}
          materialName={(id: string) => materials?.find(m => m.id === id)?.name ?? '—'}
          isAdmin={isAdmin}
        />
      )}

      {voidFor && (
        <ConfirmDialog
          title="Void Purchase"
          message={<>Void this {fmt(voidFor.total_amount)} purchase from <strong>{supplierName(voidFor.supplier_id)}</strong>? The received materials will be removed from stock. This is only possible if none of them have been used in production.</>}
          confirmLabel="Void Purchase"
          pending={voidMut.pending}
          onConfirm={handleVoid}
          onCancel={() => setVoidFor(null)}
        />
      )}

      {returnFor && (
        <SupplierReturnModal
          purchase={returnFor}
          materialName={(id: string) => materials?.find(m => m.id === id)?.name ?? '—'}
          onClose={() => setReturnFor(null)}
          onDone={() => { setReturnFor(null); refetch(); }}
        />
      )}

      {showOrderModal && (
        <OrderMaterialsModal
          suppliers={suppliers ?? []}
          materials={materials ?? []}
          onClose={() => setShowOrderModal(false)}
          onDone={() => { setShowOrderModal(false); refetch(); }}
        />
      )}

      {receiveFor && (
        <ReceivePurchaseModal
          purchase={receiveFor}
          materialName={(id: string) => materials?.find(m => m.id === id)?.name ?? '—'}
          materialTracksBatches={tracksBatches}
          onClose={() => setReceiveFor(null)}
          onDone={() => { setReceiveFor(null); refetch(); }}
        />
      )}

      {cancelFor && (
        <ConfirmDialog
          title="Cancel Order"
          message={<>Cancel order <strong>{cancelFor.doc_no}</strong> from <strong>{supplierName(cancelFor.supplier_id)}</strong>? Anything already received stays in stock — only what hasn't arrived yet is cancelled.</>}
          confirmLabel="Cancel Order"
          pending={cancelMut.pending}
          onConfirm={handleCancelOrder}
          onCancel={() => setCancelFor(null)}
        />
      )}
    </div>
  );
}

// ---- Return goods to the supplier (partial, from one exact batch) ----
interface SupplierReturnLine { purchase_item_id: string; material_id: string; label: string; cost_price: number; max: number; qty: number; }
function SupplierReturnModal({ purchase, materialName, onClose, onDone }: {
  purchase: PurchaseOrder;
  materialName: (id: string) => string;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { data, loading, error } = useQuery<any>(() => purchasesApi.detail(purchase.id), [purchase.id]);
  const createMut = useMutation(returnsApi.purchases.create);
  const [lines, setLines] = useState<SupplierReturnLine[] | null>(null);
  const [reason, setReason] = useState('');

  useEffect(() => {
    if (data && lines === null) {
      setLines((data.purchase_items ?? [])
        .filter((i: any) => Number(i.qty_remaining) > 0)
        .map((i: any) => ({
          purchase_item_id: i.id, material_id: i.material_id, label: materialName(i.material_id),
          cost_price: i.cost_price, max: Number(i.qty_remaining), qty: 0,
        })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const active = (lines ?? []).filter(l => l.qty > 0);
  const total = active.reduce((s, l) => s + l.qty * l.cost_price, 0);
  const newBalance = purchase.balance - total;

  const setLine = (idx: number, qty: number) =>
    setLines(ls => ls ? ls.map((l, i) => i === idx ? { ...l, qty } : l) : ls);

  const submit = async () => {
    if (active.length === 0) { toast.error('Set a quantity to return.'); return; }
    const res = await createMut.mutate({
      purchaseId: purchase.id,
      items: active.map(l => ({ purchaseItemId: l.purchase_item_id, qty: l.qty })),
      reason: reason.trim() || null,
    });
    if (res === null) { toast.error(createMut.error ?? 'Could not record the return.'); return; }
    toast.success('Return to supplier recorded — stock and balance updated.');
    onDone();
  };

  return (
    <Modal onClose={onClose} maxWidth={520}>
      <div className="modal-header">
        <h2>Return to supplier</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {loading && <Loading />}
        {error && <ErrorState message={error} />}
        {createMut.error && <ErrorState message={createMut.error} />}
        {lines && lines.length === 0 && <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Nothing from this purchase is still unused — it's all gone into production or another branch.</p>}
        {lines && lines.length > 0 && (
          <>
            {lines.map((l, idx) => (
              <div key={l.purchase_item_id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.6rem' }}>
                <div className="form-group">
                  <label>{l.label}</label>
                  <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>{l.max.toLocaleString()} unused, at {fmt(l.cost_price)} each</small>
                </div>
                <div className="form-group">
                  <label>Qty to return</label>
                  <NumberInput value={l.qty} onChange={v => setLine(idx, Math.max(0, Math.min(v, l.max)))} />
                </div>
              </div>
            ))}
            <div className="form-group">
              <label>Reason</label>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. wrong grade, damaged in transit" />
            </div>
            {active.length > 0 && (
              <div className="total-row">
                <strong>Return value: {fmt(total)}</strong>
                <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 4 }}>
                  {newBalance >= 0
                    ? <>What you owe drops to {fmt(newBalance)}.</>
                    : <>Once applied, the supplier will owe you {fmt(-newBalance)}.</>}
                </div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={createMut.pending || active.length === 0} onClick={submit}>
          {createMut.pending ? 'Saving…' : 'Record Return'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Order materials, no stock yet (migration 0029) ----
interface OrderLine { material_id: string; qty: number; unit_cost: number; }
function OrderMaterialsModal({ suppliers, materials, onClose, onDone }: {
  suppliers: Supplier[]; materials: Material[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const createMut = useMutation(purchasesApi.createOrder);
  const blankLine = (): OrderLine => ({ material_id: '', qty: 1, unit_cost: 0 });
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [lines, setLines] = useState<OrderLine[]>([blankLine()]);

  const addLine = () => setLines(ls => [...ls, blankLine()]);
  const removeLine = (idx: number) => setLines(ls => ls.filter((_, i) => i !== idx));
  const updateLine = (idx: number, field: keyof OrderLine, value: any) =>
    setLines(ls => ls.map((l, i) => i === idx ? { ...l, [field]: value } : l));

  const validLines = lines.filter(l => l.material_id && l.qty > 0);
  const total = validLines.reduce((s, l) => s + l.qty * l.unit_cost, 0);
  const canSubmit = validLines.length > 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) { toast.error('Add at least one material with a quantity.'); return; }
    const res = await createMut.mutate({
      supplierId: supplierId || null,
      lines: validLines.map(l => ({ material_id: l.material_id, qty: Number(l.qty), unit_cost: Number(l.unit_cost) })),
      expectedDate: expectedDate || null,
    });
    if (res) { toast.success('Order placed — nothing is owed until it\'s received.'); onDone(); }
    else toast.error(createMut.error ?? 'Could not place the order.');
  };

  return (
    <Modal onClose={onClose}>
      <div className="modal-header">
        <h2>Order Materials</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {createMut.error && <ErrorState message={createMut.error} />}
          <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
            No stock moves and nothing is owed yet — that happens when you receive it.
          </p>
          <div className="grid-2">
            <div className="form-group">
              <label>Supplier</label>
              <select value={supplierId} onChange={e => setSupplierId(e.target.value)}>
                <option value="">— select —</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.first_name} {s.last_name} — {s.company_store}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label>Expected date (optional)</label>
              <input type="date" value={expectedDate} onChange={e => setExpectedDate(e.target.value)} />
            </div>
          </div>

          <h3 className="section-title">Materials</h3>
          {lines.map((line, idx) => (
            <div key={idx} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', marginBottom: '0.6rem' }}>
              <div className="form-group" style={{ flex: 2, marginBottom: 0 }}>
                <label>Material</label>
                <select value={line.material_id} onChange={e => updateLine(idx, 'material_id', e.target.value)}>
                  <option value="">— select —</option>
                  {materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select>
              </div>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label>Qty</label>
                <NumberInput value={line.qty} onChange={v => updateLine(idx, 'qty', v)} />
              </div>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label>Unit Cost (₦)</label>
                <NumberInput value={line.unit_cost} onChange={v => updateLine(idx, 'unit_cost', v)} />
              </div>
              <div style={{ minWidth: 90, textAlign: 'right', fontWeight: 600, paddingBottom: 8 }}>{fmt(line.qty * line.unit_cost)}</div>
              {lines.length > 1 && (
                <button type="button" className="remove-item" onClick={() => removeLine(idx)} style={{ marginBottom: 8 }} title="Remove material" aria-label="Remove this material"><X size={14} /></button>
              )}
            </div>
          ))}
          <button type="button" className="btn-ghost btn-sm" onClick={addLine}><Plus size={14} /> Add material</button>

          <div className="total-row" style={{ marginTop: '1rem' }}>
            <strong>Order Value: {fmt(total)}</strong>
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={createMut.pending || !canSubmit}>
            {createMut.pending ? 'Placing…' : 'Place Order'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Receive some or all of an order (migration 0029) ----
interface ReceiveLine { line_id: string; material_id: string; label: string; remaining: number; unit_cost: number; qty: number; supplier_batch_no: string; expiry_date: string; }
function ReceivePurchaseModal({ purchase, materialName, materialTracksBatches, onClose, onDone }: {
  purchase: PurchaseOrder;
  materialName: (id: string) => string;
  materialTracksBatches: (id: string) => boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { data: poLines, loading, error } = useQuery<PurchaseOrderLine[]>(() => purchasesApi.lines(purchase.id), [purchase.id]);
  const receiveMut = useMutation(purchasesApi.receive);
  const [lines, setLines] = useState<ReceiveLine[] | null>(null);

  useEffect(() => {
    if (poLines && lines === null) {
      setLines(poLines
        .filter(l => l.qty_received < l.qty_ordered)
        .map(l => ({
          line_id: l.id, material_id: l.material_id, label: materialName(l.material_id),
          remaining: l.qty_ordered - l.qty_received, unit_cost: l.unit_cost,
          qty: l.qty_ordered - l.qty_received, supplier_batch_no: '', expiry_date: '',
        })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poLines]);

  const setLine = (idx: number, field: keyof ReceiveLine, value: any) =>
    setLines(ls => ls ? ls.map((l, i) => i === idx ? { ...l, [field]: value } : l) : ls);

  const active = (lines ?? []).filter(l => l.qty > 0);
  const total = active.reduce((s, l) => s + l.qty * l.unit_cost, 0);

  const submit = async () => {
    if (active.length === 0) { toast.error('Enter a quantity for at least one line.'); return; }
    const res = await receiveMut.mutate(purchase.id, active.map(l => ({
      line_id: l.line_id, qty: Number(l.qty), unit_cost: Number(l.unit_cost),
      ...(l.supplier_batch_no.trim() ? { supplier_batch_no: l.supplier_batch_no.trim() } : {}),
      ...(l.expiry_date ? { expiry_date: l.expiry_date } : {}),
    })));
    if (res) { toast.success('Receipt recorded — stock updated.'); onDone(); }
    else toast.error(receiveMut.error ?? 'Could not record the receipt.');
  };

  return (
    <Modal onClose={onClose} maxWidth={560}>
      <div className="modal-header">
        <h2>Receive {purchase.doc_no}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {loading && <Loading />}
        {error && <ErrorState message={error} />}
        {receiveMut.error && <ErrorState message={receiveMut.error} />}
        {lines && lines.length === 0 && <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Everything on this order has already been received.</p>}
        {lines && lines.map((l, idx) => (
          <div key={l.line_id} style={{ marginBottom: '0.75rem', paddingBottom: '0.75rem', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end' }}>
              <div className="form-group" style={{ flex: 2, marginBottom: 0 }}>
                <label>{l.label}</label>
                <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>{l.remaining.toLocaleString()} still expected</small>
              </div>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label>Qty received</label>
                <NumberInput value={l.qty} onChange={v => setLine(idx, 'qty', Math.max(0, Math.min(v, l.remaining)))} />
              </div>
              <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                <label>Unit Cost (₦)</label>
                <NumberInput value={l.unit_cost} onChange={v => setLine(idx, 'unit_cost', v)} />
              </div>
            </div>
            {materialTracksBatches(l.material_id) && (
              <div className="grid-2" style={{ marginTop: '0.5rem' }}>
                <input value={l.supplier_batch_no} onChange={e => setLine(idx, 'supplier_batch_no', e.target.value)} placeholder="Supplier batch number" />
                <input type="date" value={l.expiry_date} onChange={e => setLine(idx, 'expiry_date', e.target.value)} placeholder="Expiry date" />
              </div>
            )}
          </div>
        ))}
        {active.length > 0 && (
          <div className="total-row"><strong>Value received now: {fmt(total)}</strong></div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={receiveMut.pending || active.length === 0} onClick={submit}>
          {receiveMut.pending ? 'Saving…' : 'Record Receipt'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Purchase detail (fetches items + payments) ----
function PurchaseDetail({ id, onClose, supplierName, materialName, isAdmin }: {
  id: string; onClose: () => void;
  supplierName: (id: string | null) => string;
  materialName: (id: string) => string;
  isAdmin: boolean;
}) {
  const toast = useToast();
  const { data, loading, error, refetch } = useQuery<any>(() => purchasesApi.detail(id), [id]);
  const { data: returnNotes, refetch: refetchReturns } = useQuery(() => returnsApi.purchases.forPurchase(id), [id]);
  const voidMut = useMutation(returnsApi.purchases.void);
  const [voidTarget, setVoidTarget] = useState<{ id: string; doc_no: string | null } | null>(null);

  const confirmVoid = async () => {
    if (!voidTarget) return;
    const res = await voidMut.mutate(voidTarget.id);
    if (res !== null) {
      toast.success('Return voided — the goods and the balance are restored.');
      setVoidTarget(null);
      refetch();
      refetchReturns();
    } else {
      toast.error(voidMut.error ?? 'Could not void that return.');
    }
  };

  return (
    <>
    <Modal onClose={onClose}>
        <div className="modal-header">
          <h2>Purchase Detail</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          {loading && <Loading />}
          {error && <ErrorState message={error} />}
          {data && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem', fontSize: '0.85rem' }}>
                <div><span style={{ color: '#94a3b8' }}>Date</span><br /><strong>{data.purchase_date}</strong></div>
                <div><span style={{ color: '#94a3b8' }}>Supplier</span><br /><strong>{supplierName(data.supplier_id)}</strong></div>
                <div><span style={{ color: '#94a3b8' }}>Total</span><br /><strong>{fmt(data.total_amount)}</strong></div>
                <div><span style={{ color: '#94a3b8' }}>Balance</span><br /><strong><BalanceFigure balance={data.balance} /></strong></div>
              </div>
              {returnNotes && returnNotes.length > 0 && (
                <>
                  <h3 style={{ fontSize: '0.9rem', margin: '1rem 0 0.5rem' }}>Returned to Supplier</h3>
                  <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                    <thead><tr style={{ textAlign: 'left', color: '#64748b' }}><th>Date</th><th>Note</th><th>Reason</th><th>Total</th><th /></tr></thead>
                    <tbody>
                      {returnNotes.map(r => (
                        <tr key={r.id} style={{ borderTop: '1px solid #f1f5f9', opacity: r.voided ? 0.55 : 1 }}>
                          <td style={{ padding: '0.4rem 0' }}>{r.return_date}</td>
                          <td>{r.doc_no}{r.voided && <span className="badge-gray" style={{ marginLeft: 6 }}>Voided</span>}</td>
                          <td style={r.voided ? { textDecoration: 'line-through' } : undefined}>{r.reason || '—'}</td>
                          <td style={r.voided ? { textDecoration: 'line-through' } : undefined}>{fmt(r.total)}</td>
                          <td>
                            {isAdmin && !r.voided && (
                              <button className="btn-ghost btn-sm" style={{ color: '#dc2626' }}
                                      onClick={() => setVoidTarget({ id: r.id, doc_no: r.doc_no })}>
                                <Undo2 size={13} /> Void
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#64748b' }}><th>Material</th><th>Qty</th><th>Remaining</th><th>Unit Cost</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  {data.purchase_items?.map((i: any) => (
                    <tr key={i.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '0.4rem 0' }}>{materialName(i.material_id)}</td>
                      <td>{Number(i.qty).toLocaleString()}</td>
                      <td>{Number(i.qty_remaining).toLocaleString()}</td>
                      <td>{fmt(i.cost_price)}</td>
                      <td>{fmt(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.purchase_payments?.length > 0 && (
                <>
                  <h3 style={{ fontSize: '0.9rem', margin: '1rem 0 0.5rem' }}>Payments</h3>
                  <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                    <thead><tr style={{ textAlign: 'left', color: '#64748b' }}><th>Date</th><th>Amount</th><th>Ref</th></tr></thead>
                    <tbody>
                      {data.purchase_payments.map((p: any) => (
                        <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '0.4rem 0' }}>{p.payment_date}</td><td>{fmt(p.amount_paid)}</td><td>{p.reference || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </div>
    </Modal>

    {voidTarget && (
      <ConfirmDialog
        title="Void Return"
        message={<>Void return note <strong>{voidTarget.doc_no}</strong>? The goods it sent back are added to stock again, and what you owe the supplier is restored.</>}
        confirmLabel="Void Return"
        pending={voidMut.pending}
        onConfirm={confirmVoid}
        onCancel={() => setVoidTarget(null)}
      />
    )}
    </>
  );
}
