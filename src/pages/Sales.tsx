import React, { useState } from 'react';
import { Plus, X, Eye, Wallet, Ban, FileText, MessageCircle } from 'lucide-react';
import {
  sales as salesApi, customers as customersApi, finishedGoods as goodsApi, lookups, branding,
  SalesOrder, Customer, FinishedGood, Lookup,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { generateInvoicePdf, whatsappLink } from '../lib/invoice';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import OfflineBanner from '../components/OfflineBanner';
import NumberInput from '../components/NumberInput';
import './Sales.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const statusMap: Record<string, { label: string; cls: string }> = {
  full: { label: 'Full Payment', cls: 'badge-success' },
  part: { label: 'Part Payment', cls: 'badge-warning' },
  unpaid: { label: 'Unpaid', cls: 'badge-danger' },
};

interface LineItem { finished_good_id: string; quantity: number; unit_price: number; }

export default function Sales() {
  const toast = useToast();
  const { tenant } = useAuth();
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
    const ok = await payMut.mutate(payFor.id, Number(payAmount), payType || null);
    if (ok !== null) {
      toast.success('Payment recorded.');
      setPayFor(null);
      refetch();
    } else if (payMut.error) {
      toast.error(payMut.error);
    }
  };

  const invoiceNo = (s: SalesOrder) => 'INV-' + s.id.slice(0, 8).toUpperCase();

  const downloadInvoice = async (s: SalesOrder) => {
    try {
      const detail = await salesApi.detail(s.id);
      const cust = customers?.find(c => c.id === s.customer_id);
      let logo: string | null = null;
      if (tenant?.logo_url) { try { logo = await branding.toDataUrl(tenant.logo_url); } catch { /* skip logo */ } }
      generateInvoicePdf({
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
    { icon: <Eye size={15} />, label: 'View', onClick: s => setViewId(s.id) },
    { icon: <FileText size={15} />, label: 'Download invoice (PDF)', onClick: downloadInvoice, show: s => !s.voided },
    { icon: <MessageCircle size={15} />, label: 'Send receipt via WhatsApp', onClick: sendWhatsAppReceipt, show: s => !s.voided },
    { icon: <Ban size={15} />, label: 'Void sale', onClick: setVoidFor, show: s => !s.voided, variant: 'danger' },
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
        searchKeys={[s => customerName(s.customer_id), s => s.transaction_date]}
        searchPlaceholder="Search by customer…"
        exportName="sales"
        exportTitle="Sales Orders"
        rowActions={rowActions}
        emptyMessage="No sales yet. Record your first sale."
      />

      {/* New Sale Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
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
          </div>
        </div>
      )}

      {viewId && <SaleDetail id={viewId} onClose={() => setViewId(null)} customerName={customerName} productName={productName} />}

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
        <div className="modal-overlay" onClick={() => setPayFor(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <h2>Record Payment</h2>
              <button className="close-btn" onClick={() => setPayFor(null)}><X size={18} /></button>
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
          </div>
        </div>
      )}
    </div>
  );
}

// ---- Sale detail (fetches items + payments) ----
function SaleDetail({ id, onClose, customerName, productName }: {
  id: string; onClose: () => void;
  customerName: (id: string | null) => string;
  productName: (id: string) => string;
}) {
  const { data, loading, error } = useQuery<any>(() => salesApi.detail(id), [id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
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
                <div><span>Paid</span><strong>{fmt(data.amount_paid)}</strong></div>
                <div className={data.balance > 0 ? 'text-danger' : ''}><span>Balance</span><strong>{fmt(data.balance)}</strong></div>
              </div>
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
      </div>
    </div>
  );
}
