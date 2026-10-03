import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Plus, X, Eye, Wallet, Ban, Undo2, PackagePlus, PackageCheck, Trash2 } from 'lucide-react';
import {
  purchases as purchasesApi, suppliers as suppliersApi, materials as materialsApi, finishedGoods as goodsApi, lookups,
  returns as returnsApi, PurchaseOrder, PurchaseOrderLine, Supplier, Material, FinishedGood, Lookup,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { supplierTitle, supplierOption } from '../lib/supplierName';
import { isRetail, label } from '../retail';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';
import Modal from '../components/Modal';
import './Purchases.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
const qtyFmt = (n: number) => (n || 0).toLocaleString(undefined, { maximumFractionDigits: 3 });

// Today in the shop's own timezone. toISOString() is UTC, which in Lagos
// (UTC+1) dated anything recorded between midnight and 1am as yesterday.
const today = () => {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};
const addDays = (iso: string, days: number) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + days);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};
const fmtDate = (iso: string | null | undefined) =>
  iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

// "Agege Bread (loaf)" already names its unit; don't add "(loaf)" twice.
const withUnit = (name: string, unit: string | null) =>
  unit && !name.toLowerCase().includes(`(${unit.toLowerCase()})`) ? `${name} (${unit})` : name;

// Cash first when there is one: it's how most stock gets paid for.
const defaultPayType = (types: Lookup[] | null | undefined) =>
  (types?.find(t => /cash/i.test(t.name)) ?? types?.[0])?.id ?? '';

// A supplier return can push balance below zero. That's not a debt any
// more, it's a credit the supplier owes back (in cash or on the next delivery).
function BalanceFigure({ balance }: { balance: number }) {
  if (balance < 0) return <span className="pur-credit">Supplier owes {fmt(-balance)}</span>;
  if (balance > 0) return <span className="pur-owed">{fmt(balance)}</span>;
  return <span className="pur-num pur-muted">{fmt(0)}</span>;
}

const statusMap: Record<string, { label: string; cls: string }> = {
  full: { label: 'Paid', cls: 'badge-success' },
  part: { label: 'Part paid', cls: 'badge-warning' },
  unpaid: { label: 'Unpaid', cls: 'badge-danger' },
};

// Ordered before received (migration 0029). A purchase with no status
// column yet (pre-migration data) reads as 'received', same as its
// database default.
const orderStatusMap: Record<string, { label: string; cls: string }> = {
  ordered: { label: 'Ordered', cls: 'badge-primary' },
  partial: { label: 'Partly received', cls: 'badge-warning' },
  received: { label: 'Received', cls: 'badge-success' },
  cancelled: { label: 'Cancelled', cls: 'badge-gray' },
  draft: { label: 'Draft', cls: 'badge-gray' },
};

// What a purchase line can buy: materials for manufacturing, products for
// retail (migration 0045). Never a mix, since a tenant is one
// business_type or the other. Widened to the fields both share.
interface Buyable {
  id: string; name: string; unit: string | null; qty_balance: number;
  track_batches?: boolean; selling_price?: number; shelf_life_days?: number | null;
}

type ItemRef = { material_id?: string | null; finished_good_id?: string | null };

// A finished-goods line keeps purchase_items.qty_remaining at 0; its real
// remaining quantity is on the fg_batches layer (see purchasesApi.detail).
const unusedQty = (i: any) =>
  i.finished_good_id ? Number(i.fg_batch?.qty_remaining ?? 0) : Number(i.qty_remaining ?? 0);

export default function Purchases() {
  const toast = useToast();
  // Voiding reverses stock and money. The database enforces admin-only
  // (guard_void, migration 0017); this just keeps the button off screen
  // rather than letting staff click into a permission error.
  const { profile, tenant } = useAuth();
  const retail = isRetail(tenant);
  const isAdmin = profile?.role === 'admin';
  // Recording a purchase is admin+inventory; accounts can still see them
  // and settle supplier payments.
  const canCreatePurchase = isAdmin || profile?.role === 'inventory';
  const canReturn = isAdmin || profile?.role === 'inventory' || profile?.role === 'accounts';
  const { data: rows, loading, error, refetch } = useQuery<PurchaseOrder[]>(() => purchasesApi.list(), []);
  const suppliersQ = useQuery<Supplier[]>(() => suppliersApi.list(), []);
  const suppliers = suppliersQ.data;
  const materialsQ = useQuery<Material[]>(() => materialsApi.list(), []);
  const goodsQ = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const materials = materialsQ.data;
  const goods = goodsQ.data;
  const products: Buyable[] = (retail ? goods : materials) ?? [];
  // "Credit" as a way of paying reads as "paid" while nothing was: owing
  // the supplier is what Not paid yet / Part paid record, so it's left out.
  const payTypesQ = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);
  const payTypes = useMemo(() => payTypesQ.data?.filter(t => !/credit/i.test(t.name)), [payTypesQ.data]);
  const productName = (i: ItemRef) =>
    (i.material_id ? materials?.find(m => m.id === i.material_id)?.name
      : i.finished_good_id ? goods?.find(g => g.id === i.finished_good_id)?.name
      : null) ?? 'Unknown item';

  const voidMut = useMutation(purchasesApi.void);
  const cancelMut = useMutation(purchasesApi.cancelOrder);

  const [buying, setBuying] = useState<{ productId: string | null } | null>(null);
  const [viewId, setViewId] = useState<string | null>(null);
  const [voidFor, setVoidFor] = useState<PurchaseOrder | null>(null);
  const [payFor, setPayFor] = useState<PurchaseOrder | null>(null);
  const [returnFor, setReturnFor] = useState<PurchaseOrder | null>(null);
  const [showOrderModal, setShowOrderModal] = useState(false);
  const [receiveFor, setReceiveFor] = useState<PurchaseOrder | null>(null);
  const [cancelFor, setCancelFor] = useState<PurchaseOrder | null>(null);

  // "Restock" on the Products page lands here as ?restock=<product id>
  // and opens Quick Purchase with that product already on the first line.
  const [params, setParams] = useSearchParams();
  const restockId = params.get('restock');
  useEffect(() => {
    if (!restockId) return;
    if (canCreatePurchase) setBuying({ productId: restockId });
    setParams(p => { p.delete('restock'); return p; }, { replace: true });
  }, [restockId, canCreatePurchase, setParams]);

  const supplierName = (id: string | null) => (id ? supplierTitle(suppliers?.find(x => x.id === id)) : 'No supplier');
  const reloadAll = () => { refetch(); materialsQ.refetch(); goodsQ.refetch(); };

  const handleVoid = async () => {
    if (!voidFor) return;
    const res = await voidMut.mutate(voidFor.id);
    if (res !== null) {
      toast.success(label(retail, 'Purchase voided. The materials came back off stock.', 'Purchase voided. The products came back off stock.'));
      setVoidFor(null);
      reloadAll();
    } else {
      toast.error(voidMut.error ?? 'Void failed.');
      setVoidFor(null);
    }
  };

  const handleCancelOrder = async () => {
    if (!cancelFor) return;
    const res = await cancelMut.mutate(cancelFor.id, null);
    if (res !== null) {
      toast.success('Order cancelled. Whatever already arrived stays in stock.');
      setCancelFor(null);
      refetch();
    } else {
      toast.error(cancelMut.error ?? 'Could not cancel.');
    }
  };

  // ---- summary strip ----
  const stats = useMemo(() => {
    const live = (rows ?? []).filter(p => !p.voided);
    const owed = live.filter(p => p.balance > 0);
    const month = today().slice(0, 7);
    const bought = live.filter(p => p.purchase_date?.startsWith(month)
      && p.status !== 'ordered' && p.status !== 'cancelled' && p.status !== 'draft');
    return {
      owedTotal: owed.reduce((s, p) => s + p.balance, 0),
      owedCount: owed.length,
      owedSuppliers: new Set(owed.map(p => p.supplier_id ?? 'none')).size,
      monthTotal: bought.reduce((s, p) => s + p.total_amount, 0),
      monthCount: bought.length,
      awaiting: live.filter(p => p.status === 'ordered' || p.status === 'partial').length,
    };
  }, [rows]);

  const columns: Column<PurchaseOrder>[] = [
    { key: 'doc_no', header: 'No.', value: p => p.doc_no ?? '', render: p => <span className="pur-num">{p.doc_no}</span> },
    { key: 'purchase_date', header: 'Date', value: p => p.purchase_date, render: p => fmtDate(p.purchase_date) },
    { key: 'supplier', header: 'Supplier', value: p => supplierName(p.supplier_id),
      render: p => p.supplier_id ? supplierName(p.supplier_id) : <span className="pur-muted">No supplier</span> },
    // Retail only ever buys through Quick Purchase, so every row would
    // just say "Received".
    ...(retail ? [] : [{ key: 'order_status', header: 'Order', value: (p: PurchaseOrder) => p.status ?? 'received',
      render: (p: PurchaseOrder) => {
        const s = orderStatusMap[p.status ?? 'received'];
        return <span className={s?.cls ?? 'badge-gray'}>{s?.label ?? p.status}</span>;
      } } as Column<PurchaseOrder>]),
    { key: 'total_amount', header: 'Total', align: 'right', value: p => p.total_amount, render: p => <span className="pur-num">{fmt(p.total_amount)}</span> },
    { key: 'total_paid', header: 'Paid', align: 'right', value: p => p.total_paid, render: p => <span className="pur-num">{fmt(p.total_paid)}</span> },
    { key: 'balance', header: 'You owe', align: 'right', value: p => p.balance, render: p => p.voided ? <span className="pur-muted">{fmt(0)}</span> : <BalanceFigure balance={p.balance} /> },
    { key: 'payment_status', header: 'Payment', value: p => p.voided ? 'Voided' : (statusMap[p.payment_status]?.label ?? p.payment_status),
      render: p => p.voided
        ? <span className="badge-gray" style={{ textDecoration: 'line-through' }}>Voided</span>
        : <span className={statusMap[p.payment_status]?.cls ?? 'badge-gray'}>{statusMap[p.payment_status]?.label ?? p.payment_status}</span> },
  ];

  const rowActions: RowAction<PurchaseOrder>[] = [
    { icon: <Eye size={15} />, label: 'View', onClick: p => setViewId(p.id) },
    { icon: <PackageCheck size={15} />, label: 'Receive', onClick: setReceiveFor,
      show: p => canCreatePurchase && (p.status === 'ordered' || p.status === 'partial') },
    { icon: <Wallet size={15} />, label: 'Pay supplier', onClick: setPayFor, show: p => p.balance > 0 && !p.voided },
    { icon: <Undo2 size={15} />, label: 'Return to supplier', onClick: setReturnFor, show: p => !p.voided && canReturn && p.status !== 'ordered' && p.status !== 'cancelled' },
    { icon: <Ban size={15} />, label: 'Cancel order', onClick: setCancelFor,
      show: p => canCreatePurchase && (p.status === 'ordered' || p.status === 'partial'), variant: 'danger' },
    { icon: <Ban size={15} />, label: 'Void purchase', onClick: setVoidFor, show: p => !p.voided && isAdmin && (p.status ?? 'received') === 'received', variant: 'danger' },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Purchases</h1>
          <p>{rows ? `${rows.length} ${rows.length === 1 ? 'purchase' : 'purchases'}` : ' '}</p>
        </div>
        {canCreatePurchase && (
          <div style={{ display: 'flex', gap: '0.6rem', flexWrap: 'wrap' }}>
            {/* Order-then-receive is deliberately materials-only (plan §3.1):
               purchase_order_lines.material_id stays not null, and a retail
               tenant has no materials to order. Retail always buys through
               Quick Purchase, which does support products. */}
            {!retail && <button className="btn-secondary" onClick={() => setShowOrderModal(true)}><PackagePlus size={16} /> Order Stock</button>}
            <button className="btn-primary" onClick={() => setBuying({ productId: null })}>
              <Plus size={16} /> {label(retail, 'Quick Purchase', 'Buy Stock')}
            </button>
          </div>
        )}
      </div>

      {rows && rows.length > 0 && (
        <div className="pur-stats">
          <div className={`pur-stat ${stats.owedTotal > 0 ? 'is-owed' : 'is-clear'}`}>
            <span className="pur-stat-label">You owe suppliers</span>
            <span className="pur-stat-value">{fmt(stats.owedTotal)}</span>
            <span className="pur-stat-sub">
              {stats.owedCount === 0
                ? 'Every purchase is paid for'
                : `${stats.owedCount} unpaid ${stats.owedCount === 1 ? 'purchase' : 'purchases'} · ${stats.owedSuppliers} ${stats.owedSuppliers === 1 ? 'supplier' : 'suppliers'}`}
            </span>
          </div>
          <div className="pur-stat">
            <span className="pur-stat-label">Bought this month</span>
            <span className="pur-stat-value">{fmt(stats.monthTotal)}</span>
            <span className="pur-stat-sub">{stats.monthCount} {stats.monthCount === 1 ? 'purchase' : 'purchases'}</span>
          </div>
          {!retail && (
            <div className="pur-stat">
              <span className="pur-stat-label">Awaiting delivery</span>
              <span className="pur-stat-value">{stats.awaiting}</span>
              <span className="pur-stat-sub">{stats.awaiting === 1 ? 'order' : 'orders'} not fully received</span>
            </div>
          )}
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={p => p.id}
        searchKeys={[p => p.doc_no ?? '', p => supplierName(p.supplier_id), p => p.purchase_date, p => fmtDate(p.purchase_date)]}
        searchPlaceholder="Search by number or supplier…"
        exportName="purchases"
        exportTitle="Purchases"
        rowActions={rowActions}
        emptyMessage={label(retail,
          'No purchases yet. Record what you buy from suppliers here and your material stock goes up with it.',
          'No purchases yet. Tap Buy Stock when goods arrive and your shelf stock goes up with it.')}
      />

      {buying && (
        <QuickPurchaseModal
          retail={retail}
          suppliers={suppliers ?? []}
          products={products}
          productsLoading={!(retail ? goods : materials)}
          payTypes={payTypes ?? []}
          initialProductId={buying.productId}
          onSupplierAdded={() => suppliersQ.refetch()}
          onClose={() => setBuying(null)}
          onDone={() => { setBuying(null); reloadAll(); }}
        />
      )}

      {payFor && (
        <PayModal
          purchase={payFor}
          supplierName={supplierName(payFor.supplier_id)}
          payTypes={payTypes ?? []}
          onClose={() => setPayFor(null)}
          onDone={() => { setPayFor(null); refetch(); }}
        />
      )}

      {viewId && (
        <PurchaseDetail
          id={viewId}
          retail={retail}
          onClose={() => setViewId(null)}
          supplierName={supplierName}
          productName={productName}
          payTypes={payTypes ?? []}
          isAdmin={isAdmin}
          onPay={po => { setViewId(null); setPayFor(po); }}
          onReturn={canReturn ? po => { setViewId(null); setReturnFor(po); } : undefined}
        />
      )}

      {voidFor && (
        <ConfirmDialog
          title="Void Purchase"
          message={<>Void this {fmt(voidFor.total_amount)} purchase from <strong>{supplierName(voidFor.supplier_id)}</strong>? The stock it added is taken back off. {label(retail, 'This is only possible if none of it has been used in production.', 'This is only possible if none of it has been sold yet.')}</>}
          confirmLabel="Void Purchase"
          pending={voidMut.pending}
          onConfirm={handleVoid}
          onCancel={() => setVoidFor(null)}
        />
      )}

      {returnFor && (
        <SupplierReturnModal
          purchase={returnFor}
          supplierName={supplierName(returnFor.supplier_id)}
          productName={productName}
          onClose={() => setReturnFor(null)}
          onDone={() => { setReturnFor(null); reloadAll(); }}
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
          materialName={(id: string) => materials?.find(m => m.id === id)?.name ?? 'Unknown item'}
          material={(id: string) => materials?.find(m => m.id === id)}
          onClose={() => setReceiveFor(null)}
          onDone={() => { setReceiveFor(null); reloadAll(); }}
        />
      )}

      {cancelFor && (
        <ConfirmDialog
          title="Cancel Order"
          message={<>Cancel order <strong>{cancelFor.doc_no}</strong> from <strong>{supplierName(cancelFor.supplier_id)}</strong>? Anything already received stays in stock. Only what hasn't arrived yet is cancelled.</>}
          confirmLabel="Cancel Order"
          pending={cancelMut.pending}
          onConfirm={handleCancelOrder}
          onCancel={() => setCancelFor(null)}
        />
      )}
    </div>
  );
}

// ---- Quick Purchase: goods are here, stock goes up now ----
interface Line { key: number; product_id: string; qty: number; cost_price: number; supplier_batch_no: string; expiry_date: string; }
type PayMode = 'full' | 'part' | 'credit';
let lineSeq = 0;
const newLine = (product_id = ''): Line => ({ key: ++lineSeq, product_id, qty: 1, cost_price: 0, supplier_batch_no: '', expiry_date: '' });

function QuickPurchaseModal({ retail, suppliers, products, productsLoading, payTypes, initialProductId, onSupplierAdded, onClose, onDone }: {
  retail: boolean;
  suppliers: Supplier[];
  products: Buyable[];
  productsLoading: boolean;
  payTypes: Lookup[];
  initialProductId: string | null;
  onSupplierAdded: () => void;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const createMut = useMutation(purchasesApi.create);
  const costsQ = useQuery<any[]>(() => purchasesApi.recentCosts().catch(() => []), []);
  const noun = label(retail, 'material', 'product');
  const Noun = label(retail, 'Material', 'Product');

  const [supplierId, setSupplierId] = useState('');
  const [added, setAdded] = useState<Supplier[]>([]);
  const [showNewSupplier, setShowNewSupplier] = useState(false);
  const [date, setDate] = useState(today());
  const [lines, setLines] = useState<Line[]>(() => [newLine(initialProductId ?? '')]);
  const [payMode, setPayMode] = useState<PayMode>('full');
  const [partAmount, setPartAmount] = useState(0);
  const [payTypeId, setPayTypeId] = useState(() => defaultPayType(payTypes));

  // Payment types can arrive after the modal opens.
  useEffect(() => { if (!payTypeId && payTypes.length) setPayTypeId(defaultPayType(payTypes)); }, [payTypes, payTypeId]);

  // Newest price paid per product, for prefilling the unit cost.
  const lastCost = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of costsQ.data ?? []) {
      const id = retail ? r.finished_good_id : r.material_id;
      if (id && !m.has(id)) m.set(id, Number(r.cost_price));
    }
    return m;
  }, [costsQ.data, retail]);

  // Costs load after the modal opens: fill any line still waiting on one.
  useEffect(() => {
    if (lastCost.size === 0) return;
    setLines(ls => ls.map(l => l.product_id && l.cost_price === 0 && lastCost.has(l.product_id)
      ? { ...l, cost_price: lastCost.get(l.product_id)! } : l));
  }, [lastCost]);

  const supplierList = useMemo(
    () => [...suppliers, ...added.filter(a => !suppliers.some(s => s.id === a.id))], [suppliers, added]);
  const supplier = supplierList.find(s => s.id === supplierId);
  const productById = useMemo(() => new Map(products.map(p => [p.id, p])), [products]);

  const setLine = (key: number, patch: Partial<Line>) =>
    setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));

  const pickProduct = (key: number, productId: string) => {
    const p = productById.get(productId);
    setLines(ls => ls.map(l => {
      if (l.key !== key) return l;
      return {
        ...l,
        product_id: productId,
        cost_price: productId && lastCost.has(productId) ? lastCost.get(productId)! : l.cost_price,
        // A shelf life on the product gives a sensible expiry to start from.
        expiry_date: p?.track_batches && p.shelf_life_days && !l.expiry_date ? addDays(date, p.shelf_life_days) : l.expiry_date,
      };
    }));
  };

  // Removing the only line clears it instead, so there's always a row to type in.
  const removeLine = (key: number) =>
    setLines(ls => ls.length === 1 ? [newLine()] : ls.filter(l => l.key !== key));

  const picked = lines.filter(l => l.product_id);
  const total = picked.reduce((s, l) => s + l.qty * l.cost_price, 0);
  const units = picked.reduce((s, l) => s + l.qty, 0);
  const paying = payMode === 'full' ? total : payMode === 'part' ? Math.min(partAmount, total) : 0;
  const owed = total - paying;

  const blocker =
    picked.length === 0 ? `Pick a ${noun}`
    : picked.some(l => !(l.qty > 0)) ? 'Enter a quantity'
    : picked.some(l => !(l.cost_price > 0)) ? 'Enter the unit cost'
    : payMode === 'part' && !(partAmount > 0) ? 'Enter the amount paid'
    : payMode === 'part' && partAmount >= total ? 'That is the full amount'
    : owed > 0 && !supplierId ? 'Choose who you owe'
    : null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blocker) { toast.error(blocker + '.'); return; }
    const res = await createMut.mutate({
      supplierId: supplierId || null,
      date,
      paymentTypeId: paying > 0 ? (payTypeId || null) : null,
      amountPaid: paying,
      items: picked.map(l => ({
        ...(retail ? { finished_good_id: l.product_id } : { material_id: l.product_id }),
        qty: Number(l.qty), cost_price: Number(l.cost_price),
        ...(l.supplier_batch_no.trim() ? { supplier_batch_no: l.supplier_batch_no.trim() } : {}),
        ...(l.expiry_date ? { expiry_date: l.expiry_date } : {}),
      })),
    });
    if (res) {
      const what = `${picked.length} ${picked.length === 1 ? noun : noun + 's'}`;
      toast.success(owed > 0
        ? `Purchase saved and ${what} added to stock. You owe ${supplierTitle(supplier)} ${fmt(owed)}.`
        : `Purchase saved and ${what} added to stock.`);
      onDone();
    } else {
      toast.error(createMut.error ?? 'Could not save the purchase.');
    }
  };

  const chosen = new Set(picked.map(l => l.product_id));

  return (
    <>
      <Modal onClose={onClose} maxWidth={760}>
        <div className="modal-header">
          <h2>{label(retail, 'New Purchase', 'Buy Stock')}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit}>
          <div className="modal-body">
            <p className="pur-intro">
              {label(retail,
                'For goods that have arrived. Stock goes up the moment you save. To order ahead and receive later, use Order Stock.',
                'For goods that have arrived. They go on your shelf, ready to sell at the till, the moment you save.')}
            </p>
            {createMut.error && <ErrorState message={createMut.error} />}

            <div className="grid-2">
              <div className="form-group">
                <label htmlFor="pur-supplier">Supplier</label>
                <div className="pur-with-action">
                  <select id="pur-supplier" value={supplierId} onChange={e => setSupplierId(e.target.value)}>
                    <option value="">No supplier (cash buy)</option>
                    {supplierList.map(s => <option key={s.id} value={s.id}>{supplierOption(s)}</option>)}
                  </select>
                  <button type="button" className="btn-secondary btn-sm" onClick={() => setShowNewSupplier(true)}>
                    <Plus size={14} /> New
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label htmlFor="pur-date">Date received</label>
                <input id="pur-date" type="date" value={date} max={today()} onChange={e => setDate(e.target.value || today())} required />
              </div>
            </div>

            <div className="pur-section-title">
              <span>What you bought</span>
              {picked.length > 0 && <small>{picked.length} {picked.length === 1 ? 'line' : 'lines'} · {qtyFmt(units)} units</small>}
            </div>

            {productsLoading ? <Loading /> : products.length === 0 ? (
              <p className="pur-note is-warn">
                {label(retail,
                  'You have no materials yet. Add them on the Raw Materials page first, then come back to record what you bought.',
                  'You have no products yet. Add them on the Products page first, then come back to record what you bought.')}
              </p>
            ) : (
              <div className="pur-lines">
                <div className="pur-lines-head" aria-hidden="true">
                  <span>{Noun}</span><span>Qty</span><span>Unit cost (₦)</span><span className="is-right">Amount</span><span />
                </div>
                {lines.map(l => {
                  const p = productById.get(l.product_id);
                  const amount = l.qty * l.cost_price;
                  const last = p ? lastCost.get(p.id) : undefined;
                  const price = retail ? Number(p?.selling_price ?? 0) : 0;
                  const margin = price > 0 && l.cost_price > 0 ? (price - l.cost_price) / price : null;
                  return (
                    <div className="pur-line" key={l.key}>
                      <div className="pur-line-row">
                        <div>
                          <span className="pur-cell-label">{Noun}</span>
                          <select aria-label={Noun} value={l.product_id} onChange={e => pickProduct(l.key, e.target.value)}>
                            <option value="">Choose {noun}…</option>
                            {products.map(o => (
                              <option key={o.id} value={o.id} disabled={o.id !== l.product_id && chosen.has(o.id)}>
                                {withUnit(o.name, o.unit)}
                              </option>
                            ))}
                          </select>
                        </div>
                        <div>
                          <span className="pur-cell-label">Qty</span>
                          <NumberInput aria-label="Quantity" value={l.qty} onChange={v => setLine(l.key, { qty: v })} />
                        </div>
                        <div>
                          <span className="pur-cell-label">Unit cost (₦)</span>
                          <NumberInput aria-label="Unit cost" placeholder="0" value={l.cost_price} onChange={v => setLine(l.key, { cost_price: v })} />
                        </div>
                        <div className={`pur-line-amount${amount > 0 ? '' : ' is-empty'}`}>{fmt(amount)}</div>
                        <button type="button" className="pur-remove" onClick={() => removeLine(l.key)}
                                disabled={lines.length === 1 && !l.product_id} aria-label="Remove this line" title="Remove">
                          <Trash2 size={15} />
                        </button>
                      </div>

                      {p && (
                        <div className="pur-line-meta">
                          <span>In stock <strong>{qtyFmt(p.qty_balance)}{p.unit ? ` ${p.unit}` : ''}</strong></span>
                          {last !== undefined && (
                            <span>
                              Last paid <strong>{fmt(last)}</strong>
                              {last !== l.cost_price && <> · <button type="button" onClick={() => setLine(l.key, { cost_price: last })}>Use</button></>}
                            </span>
                          )}
                          {retail && (price > 0 ? (
                            <>
                              <span>Sells at <strong>{fmt(price)}</strong></span>
                              {margin !== null && (margin <= 0
                                ? <span className="is-loss">Costs more than its selling price</span>
                                : <span className={margin < 0.1 ? 'is-thin' : 'is-good'}>Margin <strong>{Math.round(margin * 100)}%</strong> ({fmt(price - l.cost_price)} each)</span>)}
                            </>
                          ) : <span className="is-loss">No selling price set yet</span>)}
                        </div>
                      )}

                      {p?.track_batches && (
                        <div className="pur-line-batch">
                          <label>
                            Supplier's batch no. (optional)
                            <input value={l.supplier_batch_no} maxLength={40} placeholder="As printed on the pack"
                                   onChange={e => setLine(l.key, { supplier_batch_no: e.target.value })} />
                          </label>
                          <label>
                            Expires on
                            <input type="date" value={l.expiry_date} min={date}
                                   onChange={e => setLine(l.key, { expiry_date: e.target.value })} />
                          </label>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {!productsLoading && products.length > 0 && (
              <button type="button" className="pur-add-line" onClick={() => setLines(ls => [...ls, newLine()])}>
                <Plus size={15} /> Add another {noun}
              </button>
            )}

            <div className="pur-pay">
              <div className="pur-section-title"><span>Payment</span></div>
              <div className="pur-chips" role="radiogroup" aria-label="Payment">
                {([['full', 'Paid in full'], ['part', 'Part paid'], ['credit', 'Not paid yet']] as [PayMode, string][]).map(([mode, text]) => (
                  <button key={mode} type="button" role="radio" aria-checked={payMode === mode}
                          className={`${payMode === mode ? 'is-on' : ''}${mode === 'credit' ? ' is-credit' : ''}`}
                          onClick={() => setPayMode(mode)}>
                    {text}
                  </button>
                ))}
              </div>

              {payMode !== 'credit' && (
                <div className="grid-2">
                  {payMode === 'part' && (
                    <div className="form-group">
                      <label htmlFor="pur-part">Amount paid now (₦)</label>
                      <NumberInput id="pur-part" value={partAmount} max={total || undefined} onChange={setPartAmount} />
                    </div>
                  )}
                  <div className="form-group">
                    <label htmlFor="pur-paytype">Paid by</label>
                    <select id="pur-paytype" value={payTypeId} onChange={e => setPayTypeId(e.target.value)}>
                      <option value="">Not stated</option>
                      {payTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                </div>
              )}

              <div className="pur-summary" aria-live="polite">
                <div className="pur-sum-row"><span>Paying now</span><strong>{fmt(paying)}</strong></div>
                {owed > 0 && (
                  <div className="pur-sum-row is-owed">
                    <span>You'll owe {supplier ? supplierTitle(supplier) : 'the supplier'}</span><strong>{fmt(owed)}</strong>
                  </div>
                )}
                <div className="pur-sum-total"><span>Total</span><span>{fmt(total)}</span></div>
              </div>
              {owed > 0 && !supplierId && (
                <p className="pur-note is-warn">Choose the supplier above so this debt is recorded against them.</p>
              )}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn-primary pur-save" disabled={createMut.pending || !!blocker}>
              {createMut.pending ? 'Saving…' : blocker ?? `Save purchase · ${fmt(total)}`}
            </button>
          </div>
        </form>
      </Modal>

      {showNewSupplier && (
        <NewSupplierModal
          onClose={() => setShowNewSupplier(false)}
          onCreated={s => {
            setAdded(a => [...a, s]);
            setSupplierId(s.id);
            setShowNewSupplier(false);
            onSupplierAdded();
          }}
        />
      )}
    </>
  );
}

// ---- Add a supplier without leaving the purchase ----
function NewSupplierModal({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Supplier) => void }) {
  const toast = useToast();
  const createMut = useMutation(suppliersApi.create);
  const [company, setCompany] = useState('');
  const [person, setPerson] = useState('');
  const [phone, setPhone] = useState('');
  const ok = !!(company.trim() || person.trim());

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    e.stopPropagation(); // this form sits inside the purchase form's modal tree
    if (!ok) return;
    const [first, ...rest] = person.trim().split(/\s+/);
    const res = await createMut.mutate({
      company_store: company.trim() || null,
      first_name: first || null,
      last_name: rest.join(' ') || null,
      phone: phone.trim() || null,
    });
    if (res) { toast.success(`${supplierTitle(res)} added.`); onCreated(res); }
    else toast.error(createMut.error ?? 'Could not add the supplier.');
  };

  return (
    <Modal onClose={onClose} maxWidth={420}>
      <div className="modal-header">
        <h2>New Supplier</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          <div className="form-group">
            <label htmlFor="ns-company">Business name</label>
            <input id="ns-company" value={company} onChange={e => setCompany(e.target.value)} placeholder="e.g. Alaba Wholesale Depot" />
          </div>
          <div className="form-group">
            <label htmlFor="ns-person">Contact person</label>
            <input id="ns-person" value={person} onChange={e => setPerson(e.target.value)} placeholder="e.g. Musa Bello" />
          </div>
          <div className="form-group">
            <label htmlFor="ns-phone">Phone</label>
            <input id="ns-phone" type="tel" inputMode="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="e.g. 0803 000 0000" />
          </div>
          <p className="pur-field-hint">A business name or a contact person is enough. Add the rest later on the Suppliers page.</p>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={createMut.pending || !ok}>
            {createMut.pending ? 'Saving…' : 'Add Supplier'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Pay some or all of what's owed on one purchase ----
function PayModal({ purchase, supplierName, payTypes, onClose, onDone }: {
  purchase: PurchaseOrder; supplierName: string; payTypes: Lookup[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const payMut = useMutation(purchasesApi.addPayment);
  const [amount, setAmount] = useState(purchase.balance);
  const [payType, setPayType] = useState(() => defaultPayType(payTypes));
  const [reference, setReference] = useState('');
  const half = Math.round(purchase.balance / 2);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(amount > 0)) { toast.error('Enter a payment amount.'); return; }
    // record_purchase_payment doesn't cap at the balance, and an overpayment
    // would silently flip it into "supplier owes you".
    const pay = Math.min(amount, purchase.balance);
    const ok = await payMut.mutate(purchase.id, pay, payType || null, reference.trim() || undefined);
    if (ok !== null) {
      const left = purchase.balance - pay;
      toast.success(left > 0 ? `${fmt(pay)} paid. ${fmt(left)} still owed to ${supplierName}.` : `${supplierName} is fully paid for ${purchase.doc_no ?? 'this purchase'}.`);
      onDone();
    } else {
      toast.error(payMut.error ?? 'Could not record the payment.');
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={420}>
      <div className="modal-header">
        <h2>Pay Supplier</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {payMut.error && <ErrorState message={payMut.error} />}
          <div className="pur-pay-head">
            <span>You owe {supplierName}{purchase.doc_no ? ` on ${purchase.doc_no}` : ''}</span>
            <strong>{fmt(purchase.balance)}</strong>
          </div>
          <div className="form-group">
            <label htmlFor="pay-amount">Amount paying now (₦)</label>
            <NumberInput id="pay-amount" value={amount} max={purchase.balance} onChange={setAmount} />
            <div className="pur-quick-amounts">
              <button type="button" className={amount === purchase.balance ? 'is-on' : ''} onClick={() => setAmount(purchase.balance)}>Full balance</button>
              {half > 0 && half < purchase.balance && (
                <button type="button" className={amount === half ? 'is-on' : ''} onClick={() => setAmount(half)}>Half ({fmt(half)})</button>
              )}
            </div>
          </div>
          <div className="grid-2">
            <div className="form-group">
              <label htmlFor="pay-type">Paid by</label>
              <select id="pay-type" value={payType} onChange={e => setPayType(e.target.value)}>
                <option value="">Not stated</option>
                {payTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="pay-ref">Reference (optional)</label>
              <input id="pay-ref" value={reference} onChange={e => setReference(e.target.value)} placeholder="Transfer ref, receipt no." />
            </div>
          </div>
          {amount > 0 && amount < purchase.balance && (
            <p className="pur-note">{fmt(purchase.balance - amount)} will still be owed after this.</p>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-primary" disabled={payMut.pending || !(amount > 0)}>
            {payMut.pending ? 'Saving…' : amount > 0 ? `Pay ${fmt(Math.min(amount, purchase.balance))}` : 'Enter an amount'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---- Return goods to the supplier (partial, from one exact batch) ----
interface SupplierReturnLine { purchase_item_id: string; label: string; cost_price: number; max: number; qty: number; }
function SupplierReturnModal({ purchase, supplierName, productName, onClose, onDone }: {
  purchase: PurchaseOrder;
  supplierName: string;
  productName: (i: ItemRef) => string;
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
      // unusedQty, not qty_remaining: a retail line's qty_remaining is
      // always 0 (0045), which used to hide every product from this list.
      setLines((data.purchase_items ?? [])
        .filter((i: any) => unusedQty(i) > 0)
        .map((i: any) => ({
          purchase_item_id: i.id, label: productName(i),
          cost_price: Number(i.cost_price), max: unusedQty(i), qty: 0,
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
    toast.success('Return recorded. Stock and what you owe are both updated.');
    onDone();
  };

  return (
    <Modal onClose={onClose} maxWidth={540}>
      <div className="modal-header">
        <h2>Return to {supplierName}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {loading && <Loading />}
        {error && <ErrorState message={error} />}
        {createMut.error && <ErrorState message={createMut.error} />}
        {lines && lines.length === 0 && (
          <p className="pur-note">Nothing from {purchase.doc_no ?? 'this purchase'} is left to return. It has all been sold, used, moved to another branch, or already returned.</p>
        )}
        {lines && lines.length > 0 && (
          <>
            <p className="pur-intro">From {purchase.doc_no ?? 'this purchase'}. Only what's still unsold or unused can go back.</p>
            {lines.map((l, idx) => (
              <div key={l.purchase_item_id} className="pur-return-line">
                <div>
                  <div className="pur-return-name">{l.label}</div>
                  <div className="pur-return-meta">
                    {qtyFmt(l.max)} left, at {fmt(l.cost_price)} each
                    {l.qty !== l.max && <button type="button" onClick={() => setLine(idx, l.max)}>Return all</button>}
                  </div>
                </div>
                <NumberInput aria-label={`Quantity of ${l.label} to return`} placeholder="0" value={l.qty} max={l.max}
                             onChange={v => setLine(idx, Math.max(0, Math.min(v, l.max)))} />
              </div>
            ))}
            <div className="form-group" style={{ marginTop: '1rem' }}>
              <label htmlFor="ret-reason">Reason</label>
              <input id="ret-reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. damaged in transit, wrong size" />
            </div>
            {active.length > 0 && (
              <div className="pur-summary">
                <div className="pur-sum-row"><span>Going back</span><strong>{fmt(total)}</strong></div>
                {newBalance >= 0
                  ? <div className="pur-sum-row"><span>What you owe drops to</span><strong>{fmt(newBalance)}</strong></div>
                  : <div className="pur-sum-row is-credit"><span>{supplierName} will owe you</span><strong>{fmt(-newBalance)}</strong></div>}
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={createMut.pending || active.length === 0} onClick={submit}>
          {createMut.pending ? 'Saving…' : active.length ? `Return ${fmt(total)}` : 'Set a quantity'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Order materials, no stock yet (migration 0029) ----
interface OrderLine { key: number; material_id: string; qty: number; unit_cost: number; }
function OrderMaterialsModal({ suppliers, materials, onClose, onDone }: {
  suppliers: Supplier[]; materials: Material[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const createMut = useMutation(purchasesApi.createOrder);
  const blankLine = (): OrderLine => ({ key: ++lineSeq, material_id: '', qty: 1, unit_cost: 0 });
  const [supplierId, setSupplierId] = useState('');
  const [expectedDate, setExpectedDate] = useState('');
  const [lines, setLines] = useState<OrderLine[]>(() => [blankLine()]);

  const addLine = () => setLines(ls => [...ls, blankLine()]);
  const removeLine = (key: number) => setLines(ls => ls.length === 1 ? [blankLine()] : ls.filter(l => l.key !== key));
  const updateLine = (key: number, patch: Partial<OrderLine>) =>
    setLines(ls => ls.map(l => l.key === key ? { ...l, ...patch } : l));

  const validLines = lines.filter(l => l.material_id && l.qty > 0);
  const total = validLines.reduce((s, l) => s + l.qty * l.unit_cost, 0);
  const canSubmit = validLines.length > 0;
  const chosen = new Set(lines.map(l => l.material_id).filter(Boolean));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) { toast.error('Add at least one material with a quantity.'); return; }
    const res = await createMut.mutate({
      supplierId: supplierId || null,
      lines: validLines.map(l => ({ material_id: l.material_id, qty: Number(l.qty), unit_cost: Number(l.unit_cost) })),
      expectedDate: expectedDate || null,
    });
    if (res) { toast.success('Order placed. Nothing is owed until it\'s received.'); onDone(); }
    else toast.error(createMut.error ?? 'Could not place the order.');
  };

  return (
    <Modal onClose={onClose} maxWidth={720}>
      <div className="modal-header">
        <h2>Order Materials</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {createMut.error && <ErrorState message={createMut.error} />}
          <p className="pur-intro">No stock moves and nothing is owed yet. That happens when you receive it.</p>
          <div className="grid-2">
            <div className="form-group">
              <label htmlFor="ord-supplier">Supplier</label>
              <select id="ord-supplier" value={supplierId} onChange={e => setSupplierId(e.target.value)}>
                <option value="">Choose supplier…</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{supplierOption(s)}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="ord-date">Expected on (optional)</label>
              <input id="ord-date" type="date" min={today()} value={expectedDate} onChange={e => setExpectedDate(e.target.value)} />
            </div>
          </div>

          <div className="pur-section-title"><span>Materials</span></div>
          <div className="pur-lines">
            <div className="pur-lines-head" aria-hidden="true">
              <span>Material</span><span>Qty</span><span>Unit cost (₦)</span><span className="is-right">Amount</span><span />
            </div>
            {lines.map(line => (
              <div className="pur-line" key={line.key}>
                <div className="pur-line-row">
                  <div>
                    <span className="pur-cell-label">Material</span>
                    <select aria-label="Material" value={line.material_id} onChange={e => updateLine(line.key, { material_id: e.target.value })}>
                      <option value="">Choose material…</option>
                      {materials.map(m => <option key={m.id} value={m.id} disabled={m.id !== line.material_id && chosen.has(m.id)}>{withUnit(m.name, m.unit)}</option>)}
                    </select>
                  </div>
                  <div>
                    <span className="pur-cell-label">Qty</span>
                    <NumberInput aria-label="Quantity" value={line.qty} onChange={v => updateLine(line.key, { qty: v })} />
                  </div>
                  <div>
                    <span className="pur-cell-label">Unit cost (₦)</span>
                    <NumberInput aria-label="Unit cost" placeholder="0" value={line.unit_cost} onChange={v => updateLine(line.key, { unit_cost: v })} />
                  </div>
                  <div className={`pur-line-amount${line.qty * line.unit_cost > 0 ? '' : ' is-empty'}`}>{fmt(line.qty * line.unit_cost)}</div>
                  <button type="button" className="pur-remove" onClick={() => removeLine(line.key)}
                          disabled={lines.length === 1 && !line.material_id} aria-label="Remove this material" title="Remove">
                    <Trash2 size={15} />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <button type="button" className="pur-add-line" onClick={addLine}><Plus size={15} /> Add another material</button>

          <div className="pur-total"><strong>Order value: {fmt(total)}</strong></div>
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
function ReceivePurchaseModal({ purchase, materialName, material, onClose, onDone }: {
  purchase: PurchaseOrder;
  materialName: (id: string) => string;
  material: (id: string) => Material | undefined;
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
    if (res) { toast.success('Delivery recorded. Stock updated.'); onDone(); }
    else toast.error(receiveMut.error ?? 'Could not record the delivery.');
  };

  return (
    <Modal onClose={onClose} maxWidth={600}>
      <div className="modal-header">
        <h2>Receive {purchase.doc_no}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {loading && <Loading />}
        {error && <ErrorState message={error} />}
        {receiveMut.error && <ErrorState message={receiveMut.error} />}
        {lines && lines.length === 0 && <p className="pur-note">Everything on this order has already been received.</p>}
        {lines && lines.length > 0 && <p className="pur-intro">Quantities start at what's still expected. Change any line that arrived short.</p>}
        {lines && lines.map((l, idx) => (
          <div key={l.line_id} className="pur-receive-line">
            <div className="pur-receive-row">
              <div className="form-group">
                <label>{l.label}</label>
                <small>{qtyFmt(l.remaining)} still expected</small>
              </div>
              <div className="form-group">
                <label>Qty arrived</label>
                <NumberInput value={l.qty} max={l.remaining} onChange={v => setLine(idx, 'qty', Math.max(0, Math.min(v, l.remaining)))} />
              </div>
              <div className="form-group">
                <label>Unit cost (₦)</label>
                <NumberInput value={l.unit_cost} onChange={v => setLine(idx, 'unit_cost', v)} />
              </div>
            </div>
            {material(l.material_id)?.track_batches && (
              <div className="pur-line-batch">
                <label>
                  Supplier's batch no.
                  <input value={l.supplier_batch_no} onChange={e => setLine(idx, 'supplier_batch_no', e.target.value)} placeholder="As printed on the bag or drum" />
                </label>
                <label>
                  Expires on
                  <input type="date" value={l.expiry_date} onChange={e => setLine(idx, 'expiry_date', e.target.value)} />
                </label>
              </div>
            )}
          </div>
        ))}
        {active.length > 0 && (
          <div className="pur-total"><strong>Value received now: {fmt(total)}</strong><small>This is added to what you owe the supplier.</small></div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={receiveMut.pending || active.length === 0} onClick={submit}>
          {receiveMut.pending ? 'Saving…' : 'Record Delivery'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Purchase detail (fetches items + payments) ----
function PurchaseDetail({ id, retail, onClose, supplierName, productName, payTypes, isAdmin, onPay, onReturn }: {
  id: string; retail: boolean; onClose: () => void;
  supplierName: (id: string | null) => string;
  productName: (i: ItemRef) => string;
  payTypes: Lookup[];
  isAdmin: boolean;
  onPay: (po: PurchaseOrder) => void;
  onReturn?: (po: PurchaseOrder) => void;
}) {
  const toast = useToast();
  const { data, loading, error, refetch } = useQuery<any>(() => purchasesApi.detail(id), [id]);
  const { data: returnNotes, refetch: refetchReturns } = useQuery(() => returnsApi.purchases.forPurchase(id), [id]);
  const voidMut = useMutation(returnsApi.purchases.void);
  const [voidTarget, setVoidTarget] = useState<{ id: string; doc_no: string | null } | null>(null);
  const payTypeName = (pid: string | null) => payTypes.find(p => p.id === pid)?.name ?? '';

  const confirmVoid = async () => {
    if (!voidTarget) return;
    const res = await voidMut.mutate(voidTarget.id);
    if (res !== null) {
      toast.success('Return voided. The goods and the balance are restored.');
      setVoidTarget(null);
      refetch();
      refetchReturns();
    } else {
      toast.error(voidMut.error ?? 'Could not void that return.');
    }
  };

  const po = data as (PurchaseOrder & { purchase_items?: any[]; purchase_payments?: any[] }) | null;
  const items = po?.purchase_items ?? [];
  const payments = po?.purchase_payments ?? [];
  const status = po ? (po.voided ? { label: 'Voided', cls: 'badge-gray' } : statusMap[po.payment_status]) : null;
  const canReturnHere = !!(po && onReturn && !po.voided && po.status !== 'ordered' && po.status !== 'cancelled' && items.some(i => unusedQty(i) > 0));

  return (
    <>
    <Modal onClose={onClose} maxWidth={680}>
        <div className="modal-header">
          <h2>{po?.doc_no ? `Purchase ${po.doc_no}` : 'Purchase'} {status && <span className={status.cls} style={{ marginLeft: 8, verticalAlign: 'middle' }}>{status.label}</span>}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          {loading && <Loading />}
          {error && <ErrorState message={error} />}
          {po && (
            <>
              <div className="pur-detail-head">
                <div><span>Date</span><strong>{fmtDate(po.purchase_date)}</strong></div>
                <div><span>Supplier</span><strong>{supplierName(po.supplier_id)}</strong></div>
                <div><span>Total</span><strong>{fmt(po.total_amount)}</strong></div>
                <div><span>You owe</span><strong>{po.voided ? fmt(0) : <BalanceFigure balance={po.balance} />}</strong></div>
              </div>

              <table className="pur-table">
                <thead>
                  <tr>
                    <th>Item</th><th className="is-right">Qty</th>
                    <th className="is-right">{label(retail, 'Unused', 'Unsold')}</th>
                    <th className="is-right">Unit cost</th><th className="is-right">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((i: any) => (
                    <tr key={i.id}>
                      <td>
                        {productName(i)}
                        {(i.supplier_batch_no || i.expiry_date) && (
                          <div className="pur-muted" style={{ fontSize: '0.75rem' }}>
                            {[i.supplier_batch_no && `Batch ${i.supplier_batch_no}`, i.expiry_date && `Expires ${fmtDate(i.expiry_date)}`].filter(Boolean).join(' · ')}
                          </div>
                        )}
                      </td>
                      <td className="is-right">{qtyFmt(Number(i.qty))}</td>
                      <td className="is-right">{po.voided ? <span className="pur-muted">0</span> : qtyFmt(unusedQty(i))}</td>
                      <td className="is-right">{fmt(i.cost_price)}</td>
                      <td className="is-right">{fmt(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={4} className="is-right">Total</td><td className="is-right">{fmt(po.total_amount)}</td></tr>
                </tfoot>
              </table>

              {payments.length > 0 && (
                <>
                  <h3 className="pur-sub-title">Payments</h3>
                  <table className="pur-table">
                    <thead><tr><th>Date</th><th>Paid by</th><th>Reference</th><th className="is-right">Amount</th></tr></thead>
                    <tbody>
                      {payments.map((p: any) => (
                        <tr key={p.id}>
                          <td>{fmtDate(p.payment_date)}</td>
                          <td>{payTypeName(p.payment_type_id) || <span className="pur-muted">Not stated</span>}</td>
                          <td>{p.reference || <span className="pur-muted">None</span>}</td>
                          <td className="is-right">{fmt(p.amount_paid)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}

              {returnNotes && returnNotes.length > 0 && (
                <>
                  <h3 className="pur-sub-title">Returned to supplier</h3>
                  <table className="pur-table">
                    <thead><tr><th>Date</th><th>Note</th><th>Reason</th><th className="is-right">Value</th><th /></tr></thead>
                    <tbody>
                      {returnNotes.map(r => (
                        <tr key={r.id} className={r.voided ? 'is-voided' : undefined}>
                          <td>{fmtDate(r.return_date)}</td>
                          <td>{r.doc_no}{r.voided && <span className="badge-gray" style={{ marginLeft: 6 }}>Voided</span>}</td>
                          <td className={r.voided ? 'strike' : undefined}>{r.reason || <span className="pur-muted">None given</span>}</td>
                          <td className={`is-right${r.voided ? ' strike' : ''}`}>{fmt(r.total)}</td>
                          <td className="is-right">
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
            </>
          )}
        </div>
        <div className="modal-footer">
          {canReturnHere && (
            <button type="button" className="btn-secondary" onClick={() => onReturn!(po!)}><Undo2 size={15} /> Return items</button>
          )}
          {po && !po.voided && po.balance > 0 ? (
            <button type="button" className="btn-primary" onClick={() => onPay(po)}><Wallet size={15} /> Pay {fmt(po.balance)}</button>
          ) : (
            <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
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
