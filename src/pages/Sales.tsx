import React, { useEffect, useMemo, useState } from 'react';
import { Plus, X, Eye, Wallet, Ban, FileText, MessageCircle, Undo2, Gift, Link2, Send, Trash2 } from 'lucide-react';
import {
  sales as salesApi, customers as customersApi, finishedGoods as goodsApi, lookups, branding, pricing,
  returns as returnsApi, storeCredit, payments as paymentsApi, deliveries as deliveriesApi, IntegrationStatus,
  customFieldDefs, customFields as customFieldsApi, stock, debts,
  SalesOrder, Customer, FinishedGood, Lookup, ReturnCondition, PriceList, PriceListItem, CustomerType, CustomFieldDef, StockLevel,
} from '../lib/api';
import { useBranches } from '../lib/useBranches';
import { qtyByProduct } from '../lib/branchStock';
import { todayIso } from '../lib/batches';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { hasFeature } from '../lib/features';
import { resolvePriceLocal, PriceContext } from '../lib/pricing';
import { generateInvoicePdf, generateCreditNotePdf, prettyDate } from '../lib/invoice';
import { DocTotals, DocLink } from '../components/DocParts';
import { dueText, daysLate } from '../lib/debts';
import { whatsappLink, howToPayLines, paymentRequestMessage } from '../lib/whatsapp';
import { enqueuePayment } from '../lib/offlineQueue';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import OfflineBanner from '../components/OfflineBanner';
import NumberInput from '../components/NumberInput';
import ApprovalModal from '../components/ApprovalModal';
import ReturnApprovalModal from '../components/ReturnApprovalModal';
import CustomFieldsSection from '../components/CustomFieldsSection';
import './Sales.scss';
import Modal from '../components/Modal';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const NEEDS_APPROVAL = /manager'?s? pin/i;
const CONDITIONS: { id: ReturnCondition; label: string; hint: string }[] = [
  { id: 'resellable', label: 'Resellable', hint: 'Goes back on the shelf' },
  { id: 'damaged', label: 'Damaged', hint: 'Written off — cost stays a loss' },
  { id: 'expired', label: 'Expired', hint: 'Written off — cost stays a loss' },
];

// Read the status off the money itself, so the label can never disagree
// with the Paid and Balance columns beside it.
const saleStatus = (s: { voided?: boolean; balance: number; amount_paid: number; due_date?: string | null }) =>
  s.voided ? { label: 'Voided', cls: 'badge-gray' }
  : s.balance <= 0 ? { label: 'Paid', cls: 'badge-success' }
  : s.due_date && daysLate(s.due_date) > 0 ? { label: 'Overdue', cls: 'badge-danger' }
  : s.amount_paid > 0 ? { label: 'Part paid', cls: 'badge-warning' }
  : { label: 'Unpaid', cls: 'badge-danger' };

interface LineItem { finished_good_id: string; quantity: number; unit_price: number; discount_reason: string; }

export default function Sales() {
  const toast = useToast();
  // Voiding reverses stock and money. The database enforces admin-only
  // (guard_void, migration 0017) — this just keeps the button off screen
  // rather than letting staff click into a permission error.
  const { profile, tenant } = useAuth();
  const isAdmin = profile?.role === 'admin';
  // Cost and profit are the owner's business, not the cashier's: only
  // admin and accounts see them.
  const seesProfit = isAdmin || profile?.role === 'accounts';
  // Only the owner and accounts may date a sale on another day; the
  // database refuses it for everyone else (0055).
  const canPickDate = seesProfit;
  const tiersEnabled = hasFeature(tenant, 'price_tiers');
  const { data: rows, loading, error, refetch, isOffline } = useQuery<SalesOrder[]>(() => salesApi.list(), [], { cacheKey: 'sales-list' });
  const { data: customers } = useQuery<Customer[]>(() => customersApi.list(), [], { cacheKey: 'sales-customers' });
  const { data: goods, refetch: refetchGoods } = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const { data: payTypes } = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);
  // "Credit" means nothing was received, so it can't be how a payment came in.
  const moneyTypes = useMemo(() => (payTypes ?? []).filter(t => !/credit/i.test(t.name)), [payTypes]);
  // The sale comes out of THIS branch's shelves, so that's the stock to check.
  const { myBranchId } = useBranches();
  const levelsQ = useQuery<StockLevel[]>(() => stock.levels(myBranchId), [myBranchId]);
  const branchStock = useMemo(
    () => qtyByProduct((levelsQ.data ?? []).filter(l => l.product_kind === 'finished_good'), myBranchId, 'sellable'),
    [levelsQ.data, myBranchId],
  );
  const { data: priceLists } = useQuery<PriceList[]>(() => tiersEnabled ? pricing.lists() : Promise.resolve([]), [tiersEnabled]);
  const { data: priceItems } = useQuery<PriceListItem[]>(() => tiersEnabled ? pricing.allItems() : Promise.resolve([]), [tiersEnabled]);
  // Whether "Pay now" links are even available — no point showing the
  // button (or failing every click) until Paystack is connected.
  const { data: integration } = useQuery<IntegrationStatus>(() => paymentsApi.integrationStatus(), []);
  const [creatingLinkFor, setCreatingLinkFor] = useState<string | null>(null);
  const { data: custTypes } = useQuery<CustomerType[]>(() => tiersEnabled ? pricing.customerTypes() : Promise.resolve([]), [tiersEnabled]);
  const { data: saleFieldDefs } = useQuery<CustomFieldDef[]>(() => customFieldDefs.forEntity('sale').catch(() => []), []);

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
  const [deliverFor, setDeliverFor] = useState<SalesOrder | null>(null);
  const spendCreditMut = useMutation(storeCredit.spend);
  const [orderDiscount, setOrderDiscount] = useState(0);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const blankItem = (): LineItem => ({ finished_good_id: '', quantity: 1, unit_price: 0, discount_reason: '' });
  // amountPaid null means "the full amount", so a forgotten field records
  // a paid sale, not a silent debt.
  const [form, setForm] = useState<{ date: string; customerId: string; paymentTypeId: string; amountPaid: number | null; items: LineItem[] }>({
    date: todayIso(), customerId: '', paymentTypeId: '', amountPaid: null,
    items: [blankItem()],
  });

  const customerOption = (c: Customer) => {
    const person = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
    const company = (c.company_store ?? '').trim();
    return person && company ? `${person} · ${company}` : person || company || 'Unnamed customer';
  };
  const customerName = (id: string | null) => {
    const c = customers?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Walk-in' : '—';
  };
  const productName = (id: string) => goods?.find(g => g.id === id)?.name ?? '—';
  const productStock = (id: string) => branchStock.get(id) ?? 0;

  const priceCtx: PriceContext = useMemo(() => ({
    priceListItems: priceItems ?? [],
    defaultListId: priceLists?.find(l => l.is_default && l.is_active)?.id ?? null,
    customers: customers ?? [],
    customerTypes: custTypes ?? [],
  }), [priceItems, priceLists, customers, custTypes]);
  const listPriceFor = (fgId: string, qty: number, customerId: string) =>
    resolvePriceLocal(fgId, qty, customerId || null, priceCtx, goods?.find(g => g.id === fgId)?.selling_price ?? 0);

  const cartSubtotal = form.items.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const total = Math.max(cartSubtotal - orderDiscount, 0);

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, blankItem()] }));
  const removeItem = (idx: number) => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  const updateItem = (idx: number, field: keyof LineItem, value: any) =>
    setForm(f => {
      const items = [...f.items];
      (items[idx] as any)[field] = value;
      if (field === 'finished_good_id') {
        items[idx].unit_price = listPriceFor(String(value), items[idx].quantity || 1, f.customerId);
        items[idx].discount_reason = '';
      }
      return { ...f, items };
    });
  // Picking a customer reprices every line to their tier. On a form this
  // small, the natural order is "pick who it's for, then add items" — a
  // price hand-typed before that gets overwritten, same trade-off POS
  // avoids by tracking per-line overrides, which isn't worth the extra
  // state here.
  const setCustomer = (customerId: string) =>
    setForm(f => ({
      ...f, customerId,
      items: f.items.map(i => i.finished_good_id
        ? { ...i, unit_price: listPriceFor(i.finished_good_id, i.quantity || 1, customerId), discount_reason: '' }
        : i),
    }));

  const resetForm = () => {
    setForm({ date: todayIso(), customerId: '', paymentTypeId: '', amountPaid: null, items: [blankItem()] });
    setOrderDiscount(0); setNeedsApproval(false); setApprovalError(null);
  };

  const stockError = form.items.some(i => {
    if (!i.finished_good_id) return false;
    return i.quantity <= 0 || i.quantity > productStock(i.finished_good_id);
  });
  const validItems = form.items.filter(i => i.finished_good_id && i.quantity > 0);
  const vatRate = tenant?.vat_enabled ? tenant.vat_rate : 0;
  const vatAmt = total * vatRate / 100;
  const grandTotal = total + vatAmt;
  const totalDiscount = validItems.reduce((s, i) => s + Math.max((listPriceFor(i.finished_good_id, i.quantity, form.customerId) - i.unit_price) * i.quantity, 0), 0) + orderDiscount;
  const paidNow = form.amountPaid ?? grandTotal;
  const owingAfter = Math.max(0, grandTotal - paidNow);
  // A debt with no name on it can never be collected (the till has the same rule).
  const walkInDebt = owingAfter > 0.009 && !form.customerId;
  const canSubmit = validItems.length > 0 && total > 0 && !stockError && !walkInDebt;

  const submitSale = async (approval?: { userId: string; pin: string }) => {
    if (walkInDebt) { toast.error('Pick the customer who will owe the balance, or take the full amount.'); return; }
    if (!canSubmit) { toast.error('Check items — product, quantity, and available stock.'); return; }
    if (approval) { setApproving(true); setApprovalError(null); }
    const res = await createMut.mutate({
      customerId: form.customerId || null,
      date: form.date,
      paymentTypeId: form.paymentTypeId || null,
      amountPaid: Number(paidNow) || 0,
      items: validItems.map(i => ({
        finished_good_id: i.finished_good_id, quantity: Number(i.quantity), unit_price: Number(i.unit_price),
        ...(i.discount_reason.trim() ? { discount_reason: i.discount_reason.trim() } : {}),
      })),
      vatRate,
      ...(orderDiscount > 0 ? { orderDiscount } : {}),
      ...(approval ? { approval } : {}),
    });
    if (approval) setApproving(false);
    if (res) {
      toast.success('Sale recorded — stock deducted, COGS calculated.');
      setShowModal(false);
      resetForm();
      refetch();
      refetchGoods();
      levelsQ.refetch();
    } else if (!approval && createMut.error && NEEDS_APPROVAL.test(createMut.error)) {
      setNeedsApproval(true);
    } else if (approval) {
      setApprovalError(createMut.error ?? 'Could not approve that discount.');
    } else if (createMut.error) {
      toast.error(createMut.error);
    }
  };

  const openPay = (so: SalesOrder) => {
    setPayFor(so);
    setPayAmount(so.balance);
    setPayType(moneyTypes[0]?.id ?? '');
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
      const invoiceFields = (saleFieldDefs ?? [])
        .filter(d => d.show_on_invoice)
        .map(d => ({ label: d.label, value: detail.custom_fields?.[d.key] }))
        .filter(f => f.value !== undefined && f.value !== null && f.value !== '');
      await generateInvoicePdf({
        companyName: tenant?.name ?? 'My Business',
        companyAddress: tenant?.address,
        invoiceNo: invoiceNo(s),
        date: s.transaction_date,
        dueDate: s.due_date ?? null,
        customerName: customerName(s.customer_id),
        customerPhone: cust?.phone,
        customerAddress: cust?.address,
        items: (detail.sale_items ?? []).map((i: any) => ({
          name: productName(i.finished_good_id), qty: i.quantity, unitPrice: i.unit_price, amount: i.amount,
        })),
        total: s.total_amount, paid: s.amount_paid, balance: s.balance,
        subtotal: s.subtotal, vatAmount: s.vat_amount, vatRate: s.vat_rate,
        tin: tenant?.tin, logoDataUrl: logo,
        // Only worth the customer's attention when there's actually a
        // balance owed — generateInvoicePdf itself gates the same way.
        bankDetails: s.balance > 0 ? tenant?.bank_details : null,
        customFields: invoiceFields.length > 0 ? invoiceFields : undefined,
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
      s.balance > 0 ? `Balance due: *₦${s.balance.toLocaleString()}*` : `Status: PAID ✅`,
      ``,
      ...(s.balance > 0 ? howToPayLines(tenant?.bank_details) : []),
      `Thank you for your patronage!`,
    ];
    window.open(whatsappLink(cust?.phone, lines.join('\n')), '_blank');
  };

  // Generates a Paystack pay link (payment-link-create) and hands it
  // straight to WhatsApp — the sale updates on its own the moment the
  // customer pays, via the payments-webhook Edge Function.
  const getPayLink = async (s: SalesOrder) => {
    setCreatingLinkFor(s.id);
    try {
      const res = await paymentsApi.createLink(s.id);
      if (res.error || !res.url) { toast.error(res.error ?? 'Could not create a payment link.'); return; }
      const cust = customers?.find(c => c.id === s.customer_id);
      const message = paymentRequestMessage({
        businessName: tenant?.name ?? 'us', customerName: customerName(s.customer_id), total: s.balance,
        invoices: [{ docNo: invoiceNo(s), date: s.transaction_date, balance: s.balance }],
        bank: tenant?.bank_details, payUrl: res.url, payUntil: res.expiresAt, friendly: false,
      });
      window.open(whatsappLink(cust?.phone, message), '_blank');
      toast.success('Payment link created — the sale updates automatically once it\'s paid.');
    } catch (e: any) {
      toast.error(e.message ?? 'Could not create a payment link.');
    } finally {
      setCreatingLinkFor(null);
    }
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
      render: s => <DocLink onClick={() => setViewId(s.id)} label={`Open ${invoiceNo(s)}`}>{invoiceNo(s)}</DocLink> },
    { key: 'transaction_date', header: 'Date', value: s => s.transaction_date, render: s => <span className="nowrap">{prettyDate(s.transaction_date)}</span> },
    { key: 'customer', header: 'Customer', value: s => customerName(s.customer_id) },
    { key: 'total_amount', header: 'Total', align: 'right', value: s => s.total_amount, render: s => fmt(s.total_amount) },
    { key: 'amount_paid', header: 'Paid', align: 'right', value: s => s.amount_paid, render: s => fmt(s.amount_paid) },
    { key: 'balance', header: 'Balance', align: 'right', value: s => s.balance, render: s => s.balance > 0 ? <span className="text-danger">{fmt(s.balance)}</span> : <span className="text-muted">{fmt(0)}</span> },
    ...(seesProfit ? [{ key: 'gross_profit', header: 'Profit', align: 'right', value: (s: SalesOrder) => s.gross_profit, render: (s: SalesOrder) => <span className={s.gross_profit < 0 ? 'text-danger' : ''}>{fmt(s.gross_profit)}</span> } as Column<SalesOrder>] : []),
    { key: 'payment_status', header: 'Status', value: s => saleStatus(s).label,
      render: s => <span className={saleStatus(s).cls}>{saleStatus(s).label}</span> },
  ];

  const rowActions: RowAction<SalesOrder>[] = [
    { icon: <Wallet size={15} />, label: 'Record payment', onClick: openPay, show: s => s.balance > 0 && !s.voided },
    { icon: <Link2 size={15} />, label: creatingLinkFor ? 'Creating link…' : 'Get payment link', onClick: getPayLink,
      show: s => s.balance > 0 && !s.voided && !!integration?.connected },
    { icon: <Undo2 size={15} />, label: 'Return items', onClick: setReturnFor, show: s => !s.voided },
    { icon: <Send size={15} />, label: 'Create delivery note', onClick: setDeliverFor, show: s => !s.voided },
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
          <p>Every sale and invoice, what was paid and what is still owed.</p>
        </div>
        <button className="btn-primary" onClick={() => { resetForm(); setShowModal(true); }} data-tour="sales-new"><Plus size={16} /> New Sale</button>
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
              <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <form onSubmit={e => { e.preventDefault(); submitSale(); }}>
              <div className="modal-body">
                {createMut.error && !needsApproval && <ErrorState message={createMut.error} />}
                <div className="grid-2">
                  <div className="form-group">
                    <label htmlFor="ns-date">Date</label>
                    <input id="ns-date" type="date" value={form.date} max={todayIso()} disabled={!canPickDate}
                           title={canPickDate ? undefined : 'Only the owner or accounts can change a sale’s date'}
                           onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
                  </div>
                  <div className="form-group">
                    <label>Customer</label>
                    <select value={form.customerId} onChange={e => setCustomer(e.target.value)}>
                      <option value="">Walk-in / none</option>
                      {customers?.map(c => <option key={c.id} value={c.id}>{customerOption(c)}</option>)}
                    </select>
                  </div>
                </div>

                <h3 className="doc-section-title">Products</h3>
                <div className="doc-lines">
                  <div className="doc-line doc-line-head" aria-hidden="true">
                    <span>Product</span><span>Qty</span><span>Price (₦)</span><span className="r">Amount</span><span />
                  </div>
                  {form.items.map((item, idx) => {
                    const stock = item.finished_good_id ? productStock(item.finished_good_id) : null;
                    const isOut = stock === 0;
                    const isOver = stock !== null && item.quantity > stock;
                    const list = item.finished_good_id ? listPriceFor(item.finished_good_id, item.quantity || 1, form.customerId) : 0;
                    const discounted = tiersEnabled && item.finished_good_id && item.unit_price < list;
                    return (
                      <div key={idx} className="doc-line">
                        <div className="dl-product">
                          <select aria-label={`Product, line ${idx + 1}`} value={item.finished_good_id} onChange={e => updateItem(idx, 'finished_good_id', e.target.value)}>
                            <option value="">Choose a product</option>
                            {goods?.map(g => (
                              <option key={g.id} value={g.id} disabled={productStock(g.id) === 0}>
                                {g.name}{productStock(g.id) === 0 ? ' (out of stock)' : ''}
                              </option>
                            ))}
                          </select>
                          {stock !== null && (
                            <small className={`dl-hint${isOut || isOver ? ' is-bad' : ''}`}>
                              {isOut ? 'Out of stock' : isOver ? `Only ${stock} in stock` : `${stock} in stock`}
                              {discounted ? ` · list price ${fmt(list)}` : ''}
                            </small>
                          )}
                        </div>
                        <NumberInput aria-label={`Quantity, line ${idx + 1}`} value={item.quantity}
                          onChange={v => updateItem(idx, 'quantity', v)} aria-invalid={isOver || undefined}
                          style={{ borderColor: isOver ? '#dc2626' : undefined }} />
                        <NumberInput aria-label={`Unit price, line ${idx + 1}`} placeholder="Price" value={item.unit_price} onChange={v => updateItem(idx, 'unit_price', v)} />
                        <span className="dl-amount">{fmt(item.quantity * item.unit_price)}</span>
                        {form.items.length > 1
                          ? <button type="button" className="dl-remove" onClick={() => removeItem(idx)} aria-label={`Remove line ${idx + 1}`}><Trash2 size={15} /></button>
                          : <span />}
                        {discounted && (
                          <input className="dl-extra" value={item.discount_reason} aria-label={`Reason for the discount, line ${idx + 1}`}
                                 placeholder="Reason for the lower price (e.g. regular customer)"
                                 onChange={e => updateItem(idx, 'discount_reason', e.target.value)} />
                        )}
                      </div>
                    );
                  })}
                </div>
                <button type="button" className="btn-ghost btn-sm" onClick={addItem}><Plus size={14} /> Add another product</button>

                <DocTotals
                  rows={[
                    (vatRate > 0 || orderDiscount > 0) && { label: 'Subtotal', value: fmt(cartSubtotal) },
                    tiersEnabled && {
                      label: <label htmlFor="ns-discount">Discount</label>,
                      value: <NumberInput id="ns-discount" className="dt-input" placeholder="0" value={orderDiscount}
                                          onChange={v => setOrderDiscount(Math.max(0, Math.min(v, cartSubtotal)))} />,
                    },
                    vatRate > 0 && { label: `VAT (${vatRate}%)`, value: fmt(vatAmt) },
                  ]}
                  total={{ label: 'Total', value: fmt(grandTotal), tone: 'accent' }}
                  after={[totalDiscount > 0 && { label: 'You are giving', value: `${fmt(totalDiscount)} off`, tone: 'good' }]} />

                <h3 className="doc-section-title">Payment</h3>
                <div className="grid-2">
                  <div className="form-group">
                    <label htmlFor="ns-paytype">How they paid</label>
                    <select id="ns-paytype" value={form.paymentTypeId} onChange={e => setForm(f => ({ ...f, paymentTypeId: e.target.value }))}>
                      <option value="">Choose a payment method</option>
                      {payTypes?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label htmlFor="ns-paid">Amount paid (₦)</label>
                    <NumberInput id="ns-paid" value={paidNow} onChange={v => setForm(f => ({ ...f, amountPaid: v }))} />
                  </div>
                </div>
                {walkInDebt && (
                  <p className="stock-error" role="alert" style={{ marginTop: 0 }}>
                    {fmt(owingAfter)} would be left owing. Pick the customer who owes it, or take the full amount.
                  </p>
                )}
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

      {needsApproval && (
        <ApprovalModal
          pending={approving}
          error={approvalError}
          onCancel={() => { setNeedsApproval(false); setApprovalError(null); }}
          onApprove={(managerId, pin) => submitSale({ userId: managerId, pin })}
        />
      )}

      {viewId && (
        <SaleDetail id={viewId} onClose={() => setViewId(null)} customerName={customerName} productName={productName}
                    isAdmin={isAdmin} onVoidedReturn={refetch} customFieldDefs={saleFieldDefs}
                    actions={(() => {
                      const row = rows?.find(r => r.id === viewId);
                      if (!row || row.voided) return undefined;
                      return {
                        onPdf: () => downloadInvoice(row),
                        onWhatsApp: () => sendWhatsAppReceipt(row),
                        onPay: row.balance > 0 ? () => { setViewId(null); openPay(row); } : undefined,
                      };
                    })()} />
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
              <button className="close-btn" onClick={() => setPayFor(null)} aria-label="Close"><X size={18} /></button>
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
                  <option value="">Choose a payment method</option>
                  {moneyTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
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

      {deliverFor && (
        <CreateDeliveryModal
          sale={deliverFor}
          productName={productName}
          customerAddress={customers?.find(c => c.id === deliverFor.customer_id)?.address ?? null}
          onClose={() => setDeliverFor(null)}
          onDone={() => setDeliverFor(null)}
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
  const { profile: me } = useAuth();
  // A till-only cashier's return needs a manager's PIN first (0054).
  const needsApproval = me?.role === 'cashier';
  const [askApproval, setAskApproval] = useState(false);
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
    <>
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
                <DocTotals
                  rows={[vatAmt > 0 && { label: 'Subtotal', value: fmt(subtotal) }, vatAmt > 0 && { label: 'VAT', value: fmt(vatAmt) }]}
                  total={{ label: 'Credit total', value: fmt(total), tone: 'accent' }}
                  after={[
                    Math.min(total, sale.balance) > 0 && { label: 'Off the balance owed', value: fmt(Math.min(total, sale.balance)) },
                    remainder > 0 && { label: method === 'cash' ? 'Left to refund' : 'Left to credit', value: fmt(remainder) },
                  ]} />

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
        <button type="button" className="btn-primary" disabled={createMut.pending || !canSubmit}
          onClick={() => (needsApproval ? setAskApproval(true) : submit())}>
          {createMut.pending ? 'Saving…' : needsApproval ? 'Get approval and record' : 'Record Return'}
        </button>
      </div>
    </Modal>
    {askApproval && (
      <ReturnApprovalModal
        saleId={sale.id}
        invoiceNo={invoiceNo}
        onCancel={() => setAskApproval(false)}
        onApproved={() => { setAskApproval(false); submit(); }}
      />
    )}
    </>
  );
}

// ---- Create a delivery note (partial — a sale can have more than one) ----
interface DeliveryLine { sale_item_id: string; label: string; max: number; qty: number; }
function CreateDeliveryModal({ sale, productName, customerAddress, onClose, onDone }: {
  sale: SalesOrder;
  productName: (id: string) => string;
  customerAddress: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { data, loading, error } = useQuery<any>(() => salesApi.detail(sale.id), [sale.id]);
  const createMut = useMutation(deliveriesApi.create);
  const [lines, setLines] = useState<DeliveryLine[] | null>(null);
  const [driverName, setDriverName] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [destination, setDestination] = useState(customerAddress ?? '');
  const [note, setNote] = useState('');

  // The "still to deliver" cap per line is enforced server-side (across
  // every non-failed delivery note on this sale) — this modal only needs
  // to stop someone claiming more than the LINE ever sold in total.
  useEffect(() => {
    if (data && lines === null) {
      setLines((data.sale_items ?? []).map((i: any) => {
        const max = Number(i.quantity) - Number(i.qty_returned ?? 0);
        return { sale_item_id: i.id, label: productName(i.finished_good_id), max, qty: max };
      }).filter((l: DeliveryLine) => l.max > 0));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const setLine = (idx: number, qty: number) =>
    setLines(ls => ls ? ls.map((l, i) => i === idx ? { ...l, qty } : l) : ls);

  const active = (lines ?? []).filter(l => l.qty > 0);

  const submit = async () => {
    if (active.length === 0) { toast.error('Enter a quantity to deliver.'); return; }
    const res = await createMut.mutate({
      saleId: sale.id,
      items: active.map(l => ({ sale_item_id: l.sale_item_id, qty: l.qty })),
      driverName: driverName.trim() || null, vehicleNo: vehicleNo.trim() || null,
      destination: destination.trim() || null, note: note.trim() || null,
    });
    if (res) { toast.success('Delivery note created.'); onDone(); }
    else toast.error(createMut.error ?? 'Could not create the delivery note — it may already be fully claimed by another one.');
  };

  return (
    <Modal onClose={onClose} maxWidth={480}>
      <div className="modal-header">
        <h2>Create delivery note</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {loading && <Loading />}
        {error && <ErrorState message={error} />}
        {createMut.error && <ErrorState message={createMut.error} />}
        {lines && lines.length === 0 && <p style={{ color: '#94a3b8', fontSize: '0.85rem' }}>Nothing on this sale is left to deliver.</p>}
        {lines && lines.length > 0 && (
          <>
            {lines.map((l, idx) => (
              <div key={l.sale_item_id} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.6rem' }}>
                <div className="form-group">
                  <label>{l.label}</label>
                  <small style={{ color: '#94a3b8', fontSize: '0.72rem' }}>{l.max.toLocaleString()} on this sale (a second delivery note can claim any leftover)</small>
                </div>
                <div className="form-group">
                  <label>Qty to deliver</label>
                  <NumberInput value={l.qty} onChange={v => setLine(idx, v)} min={0} max={l.max} />
                </div>
              </div>
            ))}
            <div className="grid-2">
              <div className="form-group"><label>Driver</label><input value={driverName} onChange={e => setDriverName(e.target.value)} /></div>
              <div className="form-group"><label>Vehicle No.</label><input value={vehicleNo} onChange={e => setVehicleNo(e.target.value)} /></div>
            </div>
            <div className="form-group"><label>Destination</label><input value={destination} onChange={e => setDestination(e.target.value)} /></div>
            <div className="form-group"><label>Note (optional)</label><input value={note} onChange={e => setNote(e.target.value)} /></div>
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={createMut.pending || active.length === 0} onClick={submit}>
          {createMut.pending ? 'Saving…' : 'Create Delivery Note'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Sale detail (fetches items + payments) ----
function SaleDetail({ id, onClose, customerName, productName, isAdmin, onVoidedReturn, customFieldDefs: fieldDefs, actions }: {
  actions?: { onPdf: () => void; onWhatsApp: () => void; onPay?: () => void };
  id: string; onClose: () => void;
  customerName: (id: string | null) => string;
  productName: (id: string) => string;
  isAdmin: boolean;
  onVoidedReturn: () => void;
  customFieldDefs?: CustomFieldDef[] | null;
}) {
  const { profile: viewer } = useAuth();
  const seesProfit = viewer?.role === 'admin' || viewer?.role === 'accounts';
  const { data, loading, error, refetch } = useQuery<any>(() => salesApi.detail(id), [id]);
  const { data: creditNotes, refetch: refetchReturns } = useQuery(() => returnsApi.sales.forSale(id), [id]);
  const { tenant } = useAuth();
  const toast = useToast();
  const [downloading, setDownloading] = useState<string | null>(null);
  const voidMut = useMutation(returnsApi.sales.void);
  const [voidTarget, setVoidTarget] = useState<{ id: string; doc_no: string | null } | null>(null);
  const [customFieldValues, setCustomFieldValues] = useState<Record<string, any>>({});
  const [customFieldsDirty, setCustomFieldsDirty] = useState(false);
  // Due date and write-offs (migration 0062).
  const writeOffsQ = useQuery(() => debts.writeOffs([id]).catch(() => []), [id]);
  const [dueEdit, setDueEdit] = useState<string | null>(null);
  const canMoveDue = (viewer?.role === 'admin' || viewer?.role === 'accounts' || viewer?.role === 'sales') && hasFeature(tenant, 'debt_tools');
  const saveDue = async () => {
    if (!dueEdit) return;
    try { await debts.setDueDate('sale', id, dueEdit); toast.success('Due date changed.'); setDueEdit(null); refetch(); }
    catch (e: any) { toast.error(e?.message ?? 'Could not change the due date.'); }
  };
  const undoWriteOff = async (wid: string) => {
    try { await debts.undoWriteOff(wid); toast.success('Write-off undone. The amount is owed again.'); writeOffsQ.refetch(); refetch(); onVoidedReturn(); }
    catch (e: any) { toast.error(e?.message ?? 'Could not undo it.'); }
  };
  const writtenOff = (writeOffsQ.data ?? []).reduce((sum, w) => sum + Number(w.amount), 0);
  const saveFieldsMut = useMutation((v: Record<string, any>) => customFieldsApi.set('sale', id, v));

  useEffect(() => {
    if (data && !customFieldsDirty) setCustomFieldValues(data.custom_fields ?? {});
  }, [data, customFieldsDirty]);

  const saveCustomFields = async () => {
    const res = await saveFieldsMut.mutate(customFieldValues);
    if (res !== null) {
      toast.success('Custom fields saved.');
      setCustomFieldsDirty(false);
      refetch();
    } else {
      toast.error(saveFieldsMut.error ?? 'Could not save custom fields.');
    }
  };

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
          <h2>{data ? <>Sale <span className="sd-num">{data.doc_no ?? ''}</span></> : 'Sale'}</h2>
          <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          {loading && <Loading />}
          {error && <ErrorState message={error} />}
          {data && (
            <>
              <div className="view-meta">
                <div><span>Date</span><strong>{prettyDate(data.transaction_date)}</strong></div>
                <div><span>Customer</span><strong>{customerName(data.customer_id)}</strong></div>
                {data.due_date && (
                  <div>
                    <span>Due</span>
                    {dueEdit !== null ? (
                      <span className="sd-due-edit">
                        <input type="date" value={dueEdit} onChange={e => setDueEdit(e.target.value)} aria-label="New due date" />
                        <button type="button" className="btn-primary btn-sm" onClick={saveDue}>Save</button>
                        <button type="button" className="btn-ghost btn-sm" onClick={() => setDueEdit(null)}>Cancel</button>
                      </span>
                    ) : (
                      <strong>
                        {prettyDate(data.due_date)}
                        {data.balance > 0 && dueText(data.due_date).late && <span className="sd-late"> · {dueText(data.due_date).text}</span>}
                        {canMoveDue && data.balance > 0 && !data.voided && (
                          <button type="button" className="link-inline sd-due-btn" onClick={() => setDueEdit(data.due_date.slice(0, 10))}>Change</button>
                        )}
                      </strong>
                    )}
                  </div>
                )}
                {seesProfit && <div><span>Cost of goods</span><strong>{fmt(data.cogs)}</strong></div>}
                {seesProfit && <div><span>Gross profit</span><strong className={data.gross_profit < 0 ? 'text-danger' : ''}>{fmt(data.gross_profit)}</strong></div>}
              </div>
              <table className="view-table">
                <thead><tr><th>Product</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Amount</th></tr></thead>
                <tbody>
                  {data.sale_items?.map((i: any) => (
                    <tr key={i.id}>
                      <td>{productName(i.finished_good_id)}</td>
                      <td className="r">{i.quantity}</td>
                      <td className="r">{fmt(i.unit_price)}</td>
                      <td className="r">{fmt(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <DocTotals
                rows={[
                  data.vat_amount > 0 && { label: 'Subtotal', value: fmt(data.subtotal) },
                  data.vat_amount > 0 && { label: `VAT (${data.vat_rate}%)`, value: fmt(data.vat_amount) },
                  Number(data.opening_amount || 0) > 0
                    ? { label: 'Owed before ProfixBook', value: fmt(data.opening_amount) }
                    : { label: 'Total', value: fmt(data.total_amount) },
                  data.returned_total > 0 && { label: 'Returned', value: `−${fmt(data.returned_total)}`, tone: 'bad' },
                  { label: 'Paid', value: fmt(data.amount_paid) },
                  writtenOff > 0 && { label: 'Written off', value: `−${fmt(writtenOff)}`, tone: 'muted' },
                ]}
                total={data.balance > 0
                  ? { label: 'Balance due', value: fmt(data.balance), tone: 'warn' }
                  : { label: 'Paid in full', value: fmt(0), tone: 'good' }} />
              {isAdmin && (writeOffsQ.data ?? []).length > 0 && (
                <div className="sd-writeoffs">
                  {(writeOffsQ.data ?? []).map(w => (
                    <div key={w.id}>
                      <span>Written off {fmt(w.amount)} on {prettyDate(w.writeoff_date)}{w.reason ? `: ${w.reason}` : ''}</span>
                      {hasFeature(tenant, 'debt_tools') && <button type="button" className="btn-ghost btn-sm" onClick={() => undoWriteOff(w.id)}><Undo2 size={13} /> Undo</button>}
                    </div>
                  ))}
                </div>
              )}
              {creditNotes && creditNotes.length > 0 && (
                <>
                  <h3 className="section-title">Credit Notes</h3>
                  <table className="view-table">
                    <thead><tr><th>Date</th><th>Credit Note</th><th>Reason</th><th>Total</th><th /><th /></tr></thead>
                    <tbody>
                      {creditNotes.map(r => (
                        <tr key={r.id} style={r.voided ? { opacity: 0.55 } : undefined}>
                          <td className="nowrap">{prettyDate(r.return_date)}</td>
                          <td>{r.doc_no}{r.voided && <span className="badge-gray" style={{ marginLeft: 6 }}>Voided</span>}</td>
                          <td style={r.voided ? { textDecoration: 'line-through' } : undefined}>{r.reason || <span className="text-muted">No reason given</span>}</td>
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
                        <tr key={p.id}><td className="nowrap">{prettyDate(p.payment_date)}</td><td>{fmt(p.amount_paid)}</td><td>{p.reference || <span className="text-muted">None</span>}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
              {fieldDefs && fieldDefs.length > 0 && (
                <>
                  <CustomFieldsSection defs={fieldDefs} values={customFieldValues}
                    onChange={v => { setCustomFieldValues(v); setCustomFieldsDirty(true); }} />
                  <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.5rem' }}>
                    <button type="button" className="btn-secondary btn-sm" disabled={!customFieldsDirty || saveFieldsMut.pending}
                            onClick={saveCustomFields}>
                      {saveFieldsMut.pending ? 'Saving…' : 'Save custom fields'}
                    </button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        {actions && data && (
          <div className="modal-footer sd-footer">
            <button type="button" className="btn-ghost" onClick={actions.onPdf}><FileText size={15} /> Invoice PDF</button>
            <button type="button" className="btn-secondary" onClick={actions.onWhatsApp}><MessageCircle size={15} /> WhatsApp</button>
            {actions.onPay && <button type="button" className="btn-primary" onClick={actions.onPay}><Wallet size={15} /> Record payment</button>}
          </div>
        )}
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
