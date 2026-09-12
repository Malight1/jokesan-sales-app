import React, { useEffect, useState } from 'react';
import { Plus, X, Eye, Wallet, Ban, FileText, MessageCircle, Undo2, Gift } from 'lucide-react';
import {
  sales as salesApi, customers as customersApi, finishedGoods as goodsApi, lookups, branding,
  returns as returnsApi, storeCredit,
  SalesOrder, Customer, FinishedGood, Lookup, ReturnCondition,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { generateInvoicePdf, generateCreditNotePdf } from '../lib/invoice';
import { whatsappLink } from '../lib/whatsapp';
import { enqueuePayment } from '../lib/offlineQueue';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import OfflineBanner from '../components/OfflineBanner';
import NumberInput from '../components/NumberInput';
import './Sales.scss';
import Modal from '../components/Modal';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const CONDITIONS: { id: ReturnCondition; label: string; hint: string }[] = [
  { id: 'resellable', label: 'Resellable', hint: 'Goes back on the shelf' },
  { id: 'damaged', label: 'Damaged', hint: 'Written off — cost stays a loss' },
  { id: 'expired', label: 'Expired', hint: 'Written off — cost stays a loss' },
];

const statusMap: Record<string, { label: string; cls: string }> = {
  full: { label: 'Full Payment', cls: 'badge-success' },
  part: { label: 'Part Payment', cls: 'badge-warning' },
  unpaid: { label: 'Unpaid', cls: 'badge-danger' },
};

interface LineItem { finished_good_id: string; quantity: number; unit_price: number; }

export default function Sales() {
  const toast = useToast();
  // Voiding reverses stock and money. The database enforces admin-only
  // (guard_void, migration 0017) — this just keeps the button off screen
  // rather than letting staff click into a permission error.
  const { profile, tenant } = useAuth();
  const isAdmin = profile?.role === 'admin';
  const { data: rows, loading, error, refetch, isOffline } = useQuery<SalesOrder[]>(() => salesApi.list(), [], { cacheKey: 'sales-list' });
  const { data: customers } = useQuery<Customer[]>(() => customersApi.list(), [], { cacheKey: 'sales-customers' });
  const { data: goods, refetch: refetchGoods } = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const { data: payTypes } = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);

  const createMut = useMutation(salesApi.create);
  const payMut = useMutation(salesApi.addPayment);
  const voidMut = useMutation(salesApi.void);

  const [showModal, setShowModal] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [voidFor, setVoidFor] = useState<SalesOrder | null>(null);
  const [payFor, setPayFor] = useState<SalesOrder | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payType, setPayType] = useState('');
  const [returnFor, setReturnFor] = useState<SalesOrder | null>(null);
  const spendCreditMut = useMutation(storeCredit.spend);

  const blankItem = (): LineItem => ({ finished_good_id: '', quantity: 1, unit_price: 0 });
  const [form, setForm] = useState({
    date: new Date().toISOString().split('T')[0], customerId: '', paymentTypeId: '', amountPaid: 0,
    items: [blankItem()],
  });

  const customerName = (id: string | null) => {
    const c = customers?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Walk-in' : '—';
  };
  const productName = (id: string) => goods?.find(g => g.id === id)?.name ?? '—';
  const productStock = (id: string) => goods?.find(g => g.id === id)?.qty_balance ?? 0;
  const productPrice = (id: string) => goods?.find(g => g.id === id)?.selling_price ?? 0;

  const total = form.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, blankItem()] }));
  const removeItem = (idx: number) => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  const updateItem = (idx: number, field: keyof LineItem, value: any) =>
    setForm(f => {
      const items = [...f.items];
      (items[idx] as any)[field] = value;
      if (field === 'finished_good_id') items[idx].unit_price = productPrice(String(value));
      return { ...f, items };
    });

  const resetForm = () => setForm({ date: new Date().toISOString().split('T')[0], customerId: '', paymentTypeId: '', amountPaid: 0, items: [blankItem()] });

  const stockError = form.items.some(i => {
    if (!i.finished_good_id) return false;
    return i.quantity <= 0 || i.quantity > productStock(i.finished_good_id);
  });
  const validItems = form.items.filter(i => i.finished_good_id && i.quantity > 0);
  const vatRate = tenant?.vat_enabled ? tenant.vat_rate : 0;
  const vatAmt = total * vatRate / 100;
  const grandTotal = total + vatAmt;
  const canSubmit = validItems.length > 0 && total > 0 && !stockError;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) { toast.error('Check items — product, quantity, and available stock.'); return; }
    const res = await createMut.mutate({
      customerId: form.customerId || null,
      date: form.date,
      paymentTypeId: form.paymentTypeId || null,
      amountPaid: Number(form.amountPaid) || 0,
      items: validItems.map(i => ({ finished_good_id: i.finished_good_id, quantity: Number(i.quantity), unit_price: Number(i.unit_price) })),
      vatRate,
    });
    if (res) {
      toast.success('Sale recorded — stock deducted, COGS calculated.');
      setShowModal(false);
      resetForm();
      refetch();
      refetchGoods();
    } else if (createMut.error) {
      toast.error(createMut.error);
    }
  };

  const openPay = (so: SalesOrder) => {
    setPayFor(so);
    setPayAmount(so.balance);
    setPayType(payTypes?.[0]?.id ?? '');
  };

  const submitPayment = async () => {
    if (!payFor) return;
    if (payAmount <= 0) { toast.error('Enter a payment amount.'); return; }
    // No network: keep the payment on this device and replay it through
    // the server's checks (no overpaying, no voided sales) on reconnect.
    const queueIt = () => {
      enqueuePayment(
        { saleId: payFor.id, amount: Number(payAmount), paymentTypeId: payType || null },
        `Payment ${fmt(Number(payAmount))} — ${customerName(payFor.customer_id)} (${invoiceNo(payFor)})`,
      );
      toast.info('Offline — payment saved on this device and will sync automatically.');
      setPayFor(null);
    };
    if (!navigator.onLine) { queueIt(); return; }
    const ok = await payMut.mutate(payFor.id, Number(payAmount), payType || null);
    if (ok !== null) {
      toast.success('Payment recorded.');
      setPayFor(null);
      refetch();
    } else if (!navigator.onLine) {
      queueIt();
    } else if (payMut.error) {
      toast.error(payMut.error);
    }
  };

  // Server-issued since migration 0021; the fallback covers a database that
  // hasn't run it yet.
  const invoiceNo = (s: SalesOrder) => s.doc_no || 'INV-' + s.id.slice(0, 8).toUpperCase();

  const downloadInvoice = async (s: SalesOrder) => {
    try {
      const detail = await salesApi.detail(s.id);
      const cust = customers?.find(c => c.id === s.customer_id);
      let logo: string | null = null;
      if (tenant?.logo_url) { try { logo = await branding.toDataUrl(tenant.logo_url); } catch { /* skip logo */ } }
      await generateInvoicePdf({
        companyName: tenant?.name ?? 'My Business',
        invoiceNo: invoiceNo(s),
        date: s.transaction_date,
        customerName: customerName(s.customer_id),
        customerPhone: cust?.phone,
        customerAddress: cust?.address,
        items: (detail.sale_items ?? []).map((i: any) => ({
          name: productName(i.finished_good_id), qty: i.quantity, unitPrice: i.unit_price, amount: i.amount,
        })),
        total: s.total_amount, paid: s.amount_paid, balance: s.balance,
        subtotal: s.subtotal, vatAmount: s.vat_amount, vatRate: s.vat_rate,
        tin: tenant?.tin, logoDataUrl: logo,
      });
      toast.success('Invoice downloaded.');
    } catch (e: any) {
      toast.error(e.message ?? 'Could not generate invoice.');
    }
  };

  const sendWhatsAppReceipt = (s: SalesOrder) => {
    const cust = customers?.find(c => c.id === s.customer_id);
    const lines = [
      `Hello ${customerName(s.customer_id)}! 🧾`,
      ``,
      `*${tenant?.name ?? 'Receipt'}* — ${invoiceNo(s)}`,
      `Date: ${s.transaction_date}`,
      `Total: ₦${s.total_amount.toLocaleString()}`,
      `Paid: ₦${s.amount_paid.toLocaleString()}`,
      s.balance > 0 ? `Balance due: ₦${s.balance.toLocaleString()}` : `Status: PAID ✅`,
      ``,
      `Thank you for your patronage!`,
    ];
    window.open(whatsappLink(cust?.phone, lines.join('\n')), '_blank');
  };

  const handleVoid = async () => {
    if (!voidFor) return;
    const res = await voidMut.mutate(voidFor.id);
    if (res !== null) {
      toast.success('Sale voided — stock restored.');
      setVoidFor(null);
      refetch();
      refetchGoods();
    } else {
      toast.error(voidMut.error ?? 'Void failed.');
      setVoidFor(null);
    }
  };

  const columns: Column<SalesOrder>[] = [
    { key: 'doc_no', header: 'Invoice', value: s => invoiceNo(s),
      render: s => <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{invoiceNo(s)}</span> },
    { key: 'transaction_date', header: 'Date', value: s => s.transaction_date },
    { key: 'customer', header: 'Customer', value: s => customerName(s.customer_id) },
    { key: 'total_amount', header: 'Total', align: 'right', value: s => s.total_amount, render: s => fmt(s.total_amount) },
    { key: 'amount_paid', header: 'Paid', align: 'right', value: s => s.amount_paid, render: s => fmt(s.amount_paid) },
    { key: 'balance', header: 'Balance', align: 'right', value: s => s.balance, render: s => <span className={s.balance > 0 ? 'text-danger' : ''}>{fmt(s.balance)}</span> },
    { key: 'gross_profit', header: 'Profit', align: 'right', value: s => s.gross_profit, render: s => <span style={{ color: '#16a34a', fontWeight: 600 }}>{fmt(s.gross_profit)}</span> },
    { key: 'payment_status', header: 'Status', value: s => s.voided ? 'Voided' : (statusMap[s.payment_status]?.label ?? s.payment_status),
      render: s => s.voided
        ? <span className="badge-gray" style={{ textDecoration: 'line-through' }}>Voided</span>
        : <span className={statusMap[s.payment_status]?.cls ?? 'badge-gray'}>{statusMap[s.payment_status]?.label ?? s.payment_status}</span> },
  ];

  const rowActions: RowAction<SalesOrder>[] = [
    { icon: <Wallet size={15} />, label: 'Record payment', onClick: openPay, show: s => s.balance > 0 && !s.voided },
    { icon: <Undo2 size={15} />, label: 'Return items', onClick: setReturnFor, show: s => !s.voided },
    { icon: <Eye size={15} />, label: 'View', onClick: s => setViewId(s.id) },
    { icon: <FileText size={15} />, label: 'Download invoice (PDF)', onClick: downloadInvoice, show: s => !s.voided },
    { icon: <MessageCircle size={15} />, label: 'Send receipt via WhatsApp', onClick: sendWhatsAppReceipt, show: s => !s.voided },
    { icon: <Ban size={15} />, label: 'Void sale', onClick: setVoidFor, show: s => !s.voided && isAdmin, variant: 'danger' },
  ];

  return (
    <div className="sales-page">
      <div className="page-header">
        <div className="page-title">
          <h1>Sales Orders</h1>
          <p>{rows ? `${rows.length} total transactions` : ' '}</p>
        </div>
        <button className="btn-primary" onClick={() => { resetForm(); setShowModal(true); }}><Plus size={16} /> New Sale</button>
      </div>

      {isOffline && <OfflineBanner label="sales list" />}
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={s => s.id}
        searchKeys={[s => customerName(s.customer_id), s => s.transaction_date, s => invoiceNo(s)]}
        searchPlaceholder="Search by customer or invoice…"
        exportName="sales"
        exportTitle="Sales Orders"
        rowActions={rowActions}
        emptyMessage="No sales yet. Record your first sale."
      />

      {/* New Sale Modal */}
      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>New Sale</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {createMut.error && <ErrorState message={createMut.error} />}
                <div className="grid-2">
                  <div className="form-group">
                    <label>Date</label>
                    <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
                  </div>
                  <div className="form-group">
                    <label>Customer</label>
                    <select value={form.customerId} onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))}>
                      <option value="">Walk-in / none</option>
                      {customers?.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name} — {c.company_store}</option>)}
                    </select>
                  </div>
                </div>

                <h3 className="section-title">Items</h3>
                {form.items.map((item, idx) => {
                  const stock = item.finished_good_id ? productStock(item.finished_good_id) : null;
                  const isOut = stock === 0;
                  const isOver = stock !== null && item.quantity > stock;
                  return (
                    <div className="item-row" key={idx}>
                      <div className="form-group">
                        <label>Product</label>
                        <select value={item.finished_good_id} onChange={e => updateItem(idx, 'finished_good_id', e.target.value)}>
                          <option value="">— select —</option>
                          {goods?.map(g => (
                            <option key={g.id} value={g.id} disabled={g.qty_balance === 0}>
                              {g.name}{g.qty_balance === 0 ? ' — OUT OF STOCK' : ` (${g.qty_balance} in stock)`}
                            </option>
                          ))}
                        </select>
                        {isOut && <small className="stock-error">Out of stock</small>}
                      </div>
                      <div className="form-group">
                        <label>Qty {stock !== null && <span className="stock-hint">({stock} avail)</span>}</label>
                        <NumberInput value={item.quantity}
                          onChange={v => updateItem(idx, 'quantity', v)}
                          style={{ borderColor: isOver ? '#dc2626' : undefined }} />
                        {isOver && <small className="stock-error">Exceeds stock ({stock})</small>}
                      </div>
                      <div className="form-group">
                        <label>Unit Price (₦)</label>
                        <NumberInput value={item.unit_price} onChange={v => updateItem(idx, 'unit_price', v)} />
                      </div>
                      <div className="form-group amount-col">
                        <label>Amount</label>
                        <div className="amount-display">{fmt(item.quantity * item.unit_price)}</div>
                      </div>
                      {form.items.length > 1 && (
                        <button type="button" className="remove-item" onClick={() => removeItem(idx)}><X size={14} /></button>
                      )}
                    </div>
                  );
                })}
                <button type="button" className="btn-ghost btn-sm add-item-btn" onClick={addItem}><Plus size={14} /> Add item</button>

                <div className="total-row">
                  {vatRate > 0 && (
                    <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 400, marginBottom: 4 }}>
                      Subtotal: {fmt(total)} &nbsp;·&nbsp; VAT ({vatRate}%): {fmt(vatAmt)}
                    </div>
                  )}
                  <strong>Total: {fmt(grandTotal)}</strong>
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
                  {createMut.pending ? 'Processing…' : 'Save Sale'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {viewId && (
        <SaleDetail id={viewId} onClose={() => setViewId(null)} customerName={customerName} productName={productName}
                    isAdmin={isAdmin} onVoidedReturn={refetch} />
      )}

      {voidFor && (
        <ConfirmDialog
          title="Void Sale"
          message={<>Void this {fmt(voidFor.total_amount)} sale to <strong>{customerName(voidFor.customer_id)}</strong>? The sold items will be returned to stock and the sale marked as voided. Any payments received should be refunded manually.</>}
          confirmLabel="Void Sale"
          pending={voidMut.pending}
          onConfirm={handleVoid}
          onCancel={() => setVoidFor(null)}
        />
      )}

      {/* Record Payment Modal */}
      {payFor && (
        <Modal onClose={() => setPayFor(null)} maxWidth={380}>
            <div className="modal-header">
              <h2>Record Payment</h2>
              <button className="close-btn" onClick={() => setPayFor(null)}><X size={18} /></button>
            </div>
            <div className="modal-body">
              {(payMut.error || spendCreditMut.error) && <ErrorState message={payMut.error || spendCreditMut.error || ''} />}
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem' }}>
                Outstanding balance: <strong style={{ color: '#dc2626' }}>{fmt(payFor.balance)}</strong>
              </p>
              {(() => {
                const cust = customers?.find(c => c.id === payFor.customer_id);
                const credit = cust?.credit_balance ?? 0;
                if (!cust || credit <= 0) return null;
                const spend = Math.min(credit, payFor.balance);
                return (
                  <div className="alert alert-info" style={{ fontSize: '0.82rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: '1rem' }}>
                    <span><Gift size={13} style={{ verticalAlign: -2 }} /> {cust.first_name} has {fmt(credit)} in store credit</span>
                    <button type="button" className="btn-secondary btn-sm" disabled={spendCreditMut.pending}
                      onClick={async () => {
                        const res = await spendCreditMut.mutate(payFor.id, spend);
                        if (res !== null) { toast.success(`${fmt(spend)} of store credit applied.`); setPayFor(null); refetch(); }
                      }}>
                      {spendCreditMut.pending ? 'Applying…' : `Use ${fmt(spend)}`}
                    </button>
                  </div>
                );
              })()}
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

      {returnFor && (
        <ReturnModal
          sale={returnFor}
          customerName={customerName}
          productName={productName}
          companyName={tenant?.name ?? 'My Business'}
          invoiceNo={invoiceNo(returnFor)}
          payTypes={payTypes ?? []}
          hasCustomer={!!returnFor.customer_id}
          onClose={() => setReturnFor(null)}
          onDone={() => { setReturnFor(null); refetch(); refetchGoods(); }}
        />
      )}
    </div>
  );
}

// ---- Return items (partial, mixed condition) → a credit note ----
interface ReturnLine {
  sale_item_id: string; finished_good_id: string; label: string;
  unit_price: number; max: number; qty: number; condition: ReturnCondition;
}
export function ReturnModal({ sale, customerName, productName, companyName, invoiceNo, payTypes, hasCustomer, onClose, onDone }: {
  sale: SalesOrder;
  customerName: (id: string | null) => string;
  productName: (id: string) => string;
  companyName: string;
  invoiceNo: string;
  payTypes: Lookup[];
  hasCustomer: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { data, loading, error } = useQuery<any>(() => salesApi.detail(sale.id), [sale.id]);
  const createMut = useMutation(returnsApi.sales.create);
  const [lines, setLines] = useState<ReturnLine[] | null>(null);
  const [reason, setReason] = useState('');
  const [method, setMethod] = useState<'cash' | 'store_credit'>('cash');
  const [payType, setPayType] = useState(payTypes[0]?.id ?? '');

  // Build the editable line list once the sale's items have loaded.
  useEffect(() => {
    if (data && lines === null) {
      setLines((data.sale_items ?? [])
        .filter((i: any) => Number(i.quantity) - Number(i.qty_returned ?? 0) > 0)
        .map((i: any) => ({
          sale_item_id: i.id, finished_good_id: i.finished_good_id, label: productName(i.finished_good_id),
          unit_price: i.unit_price, max: Number(i.quantity) - Number(i.qty_returned ?? 0), qty: 0, condition: 'resellable' as ReturnCondition,
        })));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const active = (lines ?? []).filter(l => l.qty > 0);
  const vatRate = sale.vat_rate || 0;
  const subtotal = active.reduce((s, l) => s + l.qty * l.unit_price, 0);
  const vatAmt = Math.round(subtotal * vatRate) / 100;
  const total = subtotal + vatAmt;
  const remainder = Math.max(0, total - sale.balance);
  const canSubmit = active.length > 0 && (method !== 'cash' || remainder <= 0 || !!payType);

  const setLine = (idx: number, patch: Partial<ReturnLine>) =>
    setLines(ls => ls ? ls.map((l, i) => i === idx ? { ...l, ...patch } : l) : ls);

  const submit = async () => {
    if (!canSubmit) { toast.error(remainder > 0 ? 'Choose a payment method for the refund.' : 'Set a quantity to return.'); return; }
    const returnId = await createMut.mutate({
      saleId: sale.id,
      items: active.map(l => ({ saleItemId: l.sale_item_id, qty: l.qty, condition: l.condition })),
      reason: reason.trim() || null,
      remainderMethod: method,
      paymentTypeId: method === 'cash' ? (payType || null) : null,
    });
    if (!returnId) { toast.error(createMut.error ?? 'Could not record the return.'); return; }
    toast.success('Return recorded — stock and balance updated.');
    try {
      const ret = await returnsApi.sales.get(returnId);
      await generateCreditNotePdf({
        companyName, creditNoteNo: ret.doc_no ?? returnId.slice(0, 8).toUpperCase(), invoiceNo, date: ret.return_date,
        customerName: customerName(sale.customer_id), reason: reason.trim() || undefined,
        items: active.map(l => ({ name: l.label, qty: l.qty, unitPrice: l.unit_price, amount: l.qty * l.unit_price, condition: l.condition })),
        subtotal, vatAmount: vatAmt, vatRate, total,
        appliedToBalance: Math.min(total, sale.balance), refunded: method === 'cash' ? remainder : 0, toStoreCredit: method === 'store_credit' ? remainder : 0,
      });
    } catch { /* the return is already recorded; a missed PDF isn't worth blocking on */ }
    onDone();
  };

  return (
    <Modal onClose={onClose} maxWidth={560}>
      <div className="modal-header">
        <h2>Return items — {invoiceNo}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {loading && <Loading />}
        {error && <ErrorState message={error} />}
        {createMut.error && <ErrorState message={createMut.error} />}
        {lines && lines.length === 0 && <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Every item on this sale has already been returned.</p>}
        {lines && lines.length > 0 && (
          <>
            {lines.map((l, idx) => (
              <div key={l.sale_item_id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.4fr', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.6rem' }}>
                <div className="form-group">
                  <label>{l.label}</label>
                  <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>{l.max.toLocaleString()} returnable at {fmt(l.unit_price)}</small>
                </div>
                <div className="form-group">
                  <label>Qty</label>
                  <NumberInput value={l.qty} onChange={v => setLine(idx, { qty: Math.max(0, Math.min(v, l.max)) })} />
                </div>
                <div className="form-group">
                  <label>Condition</label>
                  <select value={l.condition} disabled={l.qty === 0} onChange={e => setLine(idx, { condition: e.target.value as ReturnCondition })}>
                    {CONDITIONS.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
                  </select>
                </div>
              </div>
            ))}

            <div className="form-group">
              <label>Reason</label>
              <input value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. wrong size, arrived damaged" />
            </div>

            {active.length > 0 && (
              <>
                <div className="total-row" style={{ marginBottom: '0.75rem' }}>
                  {vatAmt > 0 && (
                    <div style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: 4 }}>
                      Subtotal: {fmt(subtotal)} &nbsp;·&nbsp; VAT: {fmt(vatAmt)}
                    </div>
                  )}
                  <strong>Credit total: {fmt(total)}</strong>
                  <div style={{ fontSize: '0.8rem', color: '#64748b', marginTop: 4 }}>
                    {Math.min(total, sale.balance) > 0 && <>Reduces balance owed by {fmt(Math.min(total, sale.balance))}. </>}
                    {remainder > 0 && <>{fmt(remainder)} left over to {method === 'cash' ? 'refund' : 'credit'}.</>}
                  </div>
                </div>

                {remainder > 0 && (
                  <div className="form-group">
                    <label>What happens to the {fmt(remainder)} left over?</label>
                    <div style={{ display: 'flex', gap: '0.5rem', marginBottom: method === 'cash' ? '0.5rem' : 0 }}>
                      <button type="button" className={method === 'cash' ? 'btn-primary' : 'btn-secondary'} onClick={() => setMethod('cash')}>Refund in cash</button>
                      <button type="button" className={method === 'store_credit' ? 'btn-primary' : 'btn-secondary'} disabled={!hasCustomer}
                              title={hasCustomer ? undefined : 'This sale has no named customer'} onClick={() => setMethod('store_credit')}>
                        Store credit
                      </button>
                    </div>
                    {method === 'cash' && (
                      <select value={payType} onChange={e => setPayType(e.target.value)}>
                        <option value="">— payment method —</option>
                        {payTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    )}
                  </div>
                )}
              </>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={createMut.pending || !canSubmit} onClick={submit}>
          {createMut.pending ? 'Saving…' : 'Record Return'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Sale detail (fetches items + payments) ----
function SaleDetail({ id, onClose, customerName, productName, isAdmin, onVoidedReturn }: {
  id: string; onClose: () => void;
  customerName: (id: string | null) => string;
  productName: (id: string) => string;
  isAdmin: boolean;
  onVoidedReturn: () => void;
}) {
  const { data, loading, error, refetch } = useQuery<any>(() => salesApi.detail(id), [id]);
  const { data: creditNotes, refetch: refetchReturns } = useQuery(() => returnsApi.sales.forSale(id), [id]);
  const { tenant } = useAuth();
  const toast = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);
  const voidMut = useMutation(returnsApi.sales.void);
  const [voidTarget, setVoidTarget] = useState<{ id: string; doc_no: string | null } | null>(null);

  const confirmVoid = async () => {
    if (!voidTarget) return;
    const res = await voidMut.mutate(voidTarget.id);
    if (res !== null) {
      toast.success('Return voided — stock and balance restored.');
      setVoidTarget(null);
      refetch();
      refetchReturns();
      onVoidedReturn();
    } else {
      toast.error(voidMut.error ?? 'Could not void that return.');
    }
  };

  const downloadCreditNote = async (ret: { id: string; doc_no: string | null; return_date: string; reason: string | null;
    subtotal: number; vat_amount: number; total: number; applied_to_balance: number; refunded: number; to_store_credit: number }) => {
    setDownloading(ret.id);
    try {
      const items = await returnsApi.sales.items(ret.id);
      await generateCreditNotePdf({
        companyName: tenant?.name ?? 'My Business', creditNoteNo: ret.doc_no ?? ret.id.slice(0, 8).toUpperCase(),
        invoiceNo: data?.doc_no ?? id.slice(0, 8).toUpperCase(), date: ret.return_date,
        customerName: customerName(data?.customer_id), reason: ret.reason,
        items: items.map(i => ({ name: productName(i.finished_good_id), qty: i.qty, unitPrice: i.unit_price, amount: i.amount, condition: i.condition })),
        subtotal: ret.subtotal, vatAmount: ret.vat_amount, vatRate: data?.vat_rate ?? 0, total: ret.total,
        appliedToBalance: ret.applied_to_balance, refunded: ret.refunded, toStoreCredit: ret.to_store_credit,
      });
    } catch (e: any) {
      toast.error(e.message ?? 'Could not build the credit note.');
    } finally {
      setDownloading(null);
    }
  };

  return (
    <>
    <Modal onClose={onClose}>
        <div className="modal-header">
          <h2>Sale Detail</h2>
          <button className="close-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          {loading && <Loading />}
          {error && <ErrorState message={error} />}
          {data && (
            <>
              <div className="view-meta">
                <div><span>Date</span><strong>{data.transaction_date}</strong></div>
                <div><span>Customer</span><strong>{customerName(data.customer_id)}</strong></div>
                <div><span>COGS</span><strong>{fmt(data.cogs)}</strong></div>
                <div><span>Gross Profit</span><strong style={{ color: '#16a34a' }}>{fmt(data.gross_profit)}</strong></div>
              </div>
              <table className="view-table">
                <thead><tr><th>Product</th><th>Qty</th><th>Unit Price</th><th>Amount</th></tr></thead>
                <tbody>
                  {data.sale_items?.map((i: any) => (
                    <tr key={i.id}>
                      <td>{productName(i.finished_good_id)}</td>
                      <td>{i.quantity}</td>
                      <td>{fmt(i.unit_price)}</td>
                      <td>{fmt(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="view-summary">
                <div><span>Total</span><strong>{fmt(data.total_amount)}</strong></div>
                {data.returned_total > 0 && <div><span>Returned</span><strong style={{ color: '#dc2626' }}>−{fmt(data.returned_total)}</strong></div>}
                <div><span>Paid</span><strong>{fmt(data.amount_paid)}</strong></div>
                <div className={data.balance > 0 ? 'text-danger' : ''}><span>Balance</span><strong>{fmt(data.balance)}</strong></div>
              </div>
              {creditNotes && creditNotes.length > 0 && (
                <>
                  <h3 className="section-title">Credit Notes</h3>
                  <table className="view-table">
                    <thead><tr><th>Date</th><th>Credit Note</th><th>Reason</th><th>Total</th><th /><th /></tr></thead>
                    <tbody>
                      {creditNotes.map(r => (
                        <tr key={r.id} style={r.voided ? { opacity: 0.55 } : undefined}>
                          <td>{r.return_date}</td>
                          <td>{r.doc_no}{r.voided && <span className="badge-gray" style={{ marginLeft: 6 }}>Voided</span>}</td>
                          <td style={r.voided ? { textDecoration: 'line-through' } : undefined}>{r.reason || '—'}</td>
                          <td style={r.voided ? { textDecoration: 'line-through' } : undefined}>{fmt(r.total)}</td>
                          <td>
                            <button className="btn-ghost btn-sm" disabled={downloading === r.id} onClick={() => downloadCreditNote(r)}>
                              <FileText size={13} /> {downloading === r.id ? 'Preparing…' : 'PDF'}
                            </button>
                          </td>
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
              {data.sale_payments?.length > 0 && (
                <>
                  <h3 className="section-title">Payments</h3>
                  <table className="view-table">
                    <thead><tr><th>Date</th><th>Amount</th><th>Ref</th></tr></thead>
                    <tbody>
                      {data.sale_payments.map((p: any) => (
                        <tr key={p.id}><td>{p.payment_date}</td><td>{fmt(p.amount_paid)}</td><td>{p.reference || '—'}</td></tr>
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
        message={<>Void credit note <strong>{voidTarget.doc_no}</strong>? Any resellable stock it put back is taken off the shelf again, the balance it paid down is restored, and any store credit it issued is clawed back. This is refused if that stock has since moved on, or the credit has already been spent.</>}
        confirmLabel="Void Return"
        pending={voidMut.pending}
        onConfirm={confirmVoid}
        onCancel={() => setVoidTarget(null)}
      />
    )}
    </>
  );
}
