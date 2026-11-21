import React, { useState } from 'react';
import { Plus, X, Eye, FileText, MessageCircle, ArrowRightCircle, Ban, CheckCircle2, Trash2 } from 'lucide-react';
import {
  quotes as quotesApi, customers as customersApi, finishedGoods as goodsApi, lookups, branding,
  Quote, QuoteStatus, Customer, FinishedGood, Lookup,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { generateQuotePdf } from '../lib/invoice';
import { whatsappLink, howToPayLines } from '../lib/whatsapp';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import Modal from '../components/Modal';
import ApprovalModal from '../components/ApprovalModal';
import NumberInput from '../components/NumberInput';
import BankAccountCard from '../components/BankAccountCard';
import './Quotes.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const NEEDS_APPROVAL = /manager'?s? pin/i;
const today = () => new Date().toISOString().slice(0, 10);
const inDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

interface LineItem { finished_good_id: string; quantity: number; unit_price: number; }

const STATUS: Record<QuoteStatus | 'expired', { label: string; cls: string }> = {
  draft: { label: 'Draft', cls: 'badge-gray' },
  sent: { label: 'Sent', cls: 'badge-primary' },
  accepted: { label: 'Accepted', cls: 'badge-success' },
  declined: { label: 'Declined', cls: 'badge-danger' },
  converted: { label: 'Became a sale', cls: 'badge-success' },
  cancelled: { label: 'Cancelled', cls: 'badge-gray' },
  expired: { label: 'Expired', cls: 'badge-warning' },
};

// Past its valid-until date and still waiting on the customer.
const isExpired = (q: Quote) =>
  !!q.valid_until && q.valid_until < today() && (q.status === 'draft' || q.status === 'sent' || q.status === 'accepted');
const statusOf = (q: Quote) => (isExpired(q) ? STATUS.expired : STATUS[q.status]);
const isOpen = (q: Quote) => q.status !== 'converted' && q.status !== 'declined' && q.status !== 'cancelled';
const kindName = (k: Quote['kind']) => (k === 'proforma' ? 'Proforma invoice' : 'Quote');

export default function Quotes() {
  const toast = useToast();
  const { tenant } = useAuth();
  const { data: rows, loading, error, refetch } = useQuery<Quote[]>(() => quotesApi.list(), [], { cacheKey: 'quotes-list' });
  const { data: customers } = useQuery<Customer[]>(() => customersApi.list(), [], { cacheKey: 'quotes-customers' });
  const { data: goods } = useQuery<FinishedGood[]>(() => goodsApi.list(), [], { cacheKey: 'quotes-goods' });
  const { data: payTypes } = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);

  const createMut = useMutation(quotesApi.create);
  const statusMut = useMutation(quotesApi.setStatus);

  const [showModal, setShowModal] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [convertFor, setConvertFor] = useState<Quote | null>(null);

  const blankItem = (): LineItem => ({ finished_good_id: '', quantity: 1, unit_price: 0 });
  const blankForm = () => ({
    kind: 'quote' as 'quote' | 'proforma', customerId: '', validUntil: inDays(14), notes: '', terms: '',
    items: [blankItem()],
  });
  const [form, setForm] = useState(blankForm);

  const customerName = (id: string | null) => {
    const c = customers?.find(x => x.id === id);
    if (!c) return 'Walk-in customer';
    return `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer';
  };
  const customerOption = (c: Customer) => {
    const person = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
    const company = (c.company_store ?? '').trim();
    return person && company ? `${person} · ${company}` : person || company || 'Unnamed customer';
  };
  const productName = (id: string) => goods?.find(g => g.id === id)?.name ?? 'Unknown product';

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, blankItem()] }));
  const removeItem = (idx: number) => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  const updateItem = (idx: number, field: keyof LineItem, value: any) =>
    setForm(f => {
      const items = [...f.items];
      items[idx] = { ...items[idx], [field]: value };
      if (field === 'finished_good_id') items[idx].unit_price = goods?.find(g => g.id === value)?.selling_price ?? 0;
      return { ...f, items };
    });

  const validItems = form.items.filter(i => i.finished_good_id && i.quantity > 0);
  const subtotal = validItems.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const vatRate = tenant?.vat_enabled ? tenant.vat_rate : 0;
  const vatAmt = subtotal * vatRate / 100;
  const canSubmit = validItems.length > 0;

  const resetForm = () => setForm(blankForm());

  const submitQuote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) { toast.error('Add at least one product.'); return; }
    const res = await createMut.mutate({
      customerId: form.customerId || null, kind: form.kind,
      items: validItems.map(i => ({ finished_good_id: i.finished_good_id, quantity: Number(i.quantity), unit_price: Number(i.unit_price) })),
      validUntil: form.validUntil || null, notes: form.notes.trim() || null, terms: form.terms.trim() || null,
    });
    if (res) {
      toast.success(`${kindName(form.kind)} saved. Send it from the list with the WhatsApp or PDF button.`);
      setShowModal(false); resetForm(); refetch();
    } else {
      toast.error(createMut.error ?? 'Could not save it.');
    }
  };

  const changeStatus = async (q: Quote, status: Exclude<QuoteStatus, 'converted'>) => {
    const res = await statusMut.mutate(q.id, status);
    if (res !== null) { toast.success(`${q.doc_no} marked ${STATUS[status].label.toLowerCase()}.`); refetch(); }
    else toast.error(statusMut.error ?? 'Could not update it.');
  };

  const downloadPdf = async (q: Quote) => {
    try {
      const detail = await quotesApi.detail(q.id);
      let logo: string | null = null;
      if (tenant?.logo_url) { try { logo = await branding.toDataUrl(tenant.logo_url); } catch { /* skip logo */ } }
      const cust = customers?.find(c => c.id === q.customer_id);
      await generateQuotePdf({
        companyName: tenant?.name ?? 'My Business', kind: q.kind, docNo: q.doc_no ?? q.id.slice(0, 8).toUpperCase(),
        date: q.issue_date, validUntil: q.valid_until, customerName: customerName(q.customer_id),
        customerPhone: cust?.phone, customerAddress: cust?.address,
        items: (detail.quote_items ?? []).map((i: any) => ({ name: productName(i.finished_good_id), qty: i.quantity, unitPrice: i.unit_price, amount: i.amount })),
        subtotal: q.subtotal, vatAmount: q.vat_amount, vatRate: q.vat_rate, total: q.total,
        notes: q.notes, terms: q.terms, bankDetails: tenant?.bank_details, tin: tenant?.tin, logoDataUrl: logo,
      });
      if (q.status === 'draft') changeStatus(q, 'sent');
    } catch (e: any) {
      toast.error(e.message ?? 'Could not make the PDF.');
    }
  };

  const sendWhatsApp = async (q: Quote) => {
    const cust = customers?.find(c => c.id === q.customer_id);
    let itemLines: string[] = [];
    try {
      const detail = await quotesApi.detail(q.id);
      itemLines = (detail.quote_items ?? []).slice(0, 12).map((i: any) =>
        `• ${productName(i.finished_good_id)} × ${i.quantity} = ${fmt(i.amount)}`);
    } catch { /* send without the item list */ }
    const lines = [
      `Hello ${customerName(q.customer_id)},`,
      ``,
      `Here is your ${kindName(q.kind).toLowerCase()} from *${tenant?.name ?? 'us'}* (${q.doc_no}).`,
      ``,
      ...itemLines,
      ...(itemLines.length ? [''] : []),
      q.vat_amount > 0 ? `VAT (${q.vat_rate}%): ${fmt(q.vat_amount)}` : '',
      `*Total: ${fmt(q.total)}*`,
      q.valid_until ? `Valid until ${fmtDate(q.valid_until)}` : '',
      q.terms ? `Terms: ${q.terms}` : '',
      ``,
      ...howToPayLines(tenant?.bank_details),
      `Reply to this message to go ahead, or if you have any questions.`,
    ].filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== ''));
    window.open(whatsappLink(cust?.phone, lines.join('\n')), '_blank');
    if (q.status === 'draft') changeStatus(q, 'sent');
  };

  const columns: Column<Quote>[] = [
    { key: 'doc_no', header: 'No.', value: q => q.doc_no ?? '', render: q => <span className="q-num">{q.doc_no}</span> },
    { key: 'kind', header: 'Type', value: q => kindName(q.kind), render: q => <span className="badge-gray">{q.kind === 'proforma' ? 'Proforma' : 'Quote'}</span> },
    { key: 'customer', header: 'Customer', value: q => customerName(q.customer_id) },
    { key: 'issue_date', header: 'Date', value: q => q.issue_date, render: q => fmtDate(q.issue_date) },
    { key: 'valid_until', header: 'Valid until', value: q => q.valid_until ?? '',
      render: q => q.valid_until ? fmtDate(q.valid_until) : <span className="q-muted">No end date</span> },
    { key: 'total', header: 'Total', align: 'right', value: q => q.total, render: q => <strong className="q-num">{fmt(q.total)}</strong> },
    { key: 'status', header: 'Status', value: q => statusOf(q).label, render: q => <span className={statusOf(q).cls}>{statusOf(q).label}</span> },
  ];

  const rowActions: RowAction<Quote>[] = [
    { icon: <Eye size={15} />, label: 'Open', onClick: q => setViewId(q.id) },
    { icon: <MessageCircle size={15} />, label: 'Send on WhatsApp', onClick: sendWhatsApp, show: isOpen },
    { icon: <FileText size={15} />, label: 'Download PDF', onClick: downloadPdf },
    { icon: <CheckCircle2 size={15} />, label: 'Customer accepted', onClick: q => changeStatus(q, 'accepted'),
      show: q => q.status === 'draft' || q.status === 'sent' },
    { icon: <ArrowRightCircle size={15} />, label: 'Turn into a sale', onClick: setConvertFor, show: isOpen },
    { icon: <X size={15} />, label: 'Customer declined', onClick: q => changeStatus(q, 'declined'),
      show: q => q.status === 'draft' || q.status === 'sent' || q.status === 'accepted' },
    { icon: <Ban size={15} />, label: 'Cancel', onClick: q => changeStatus(q, 'cancelled'),
      show: q => q.status !== 'converted' && q.status !== 'cancelled', variant: 'danger' },
  ];

  if (loading) return <Loading label="Loading quotes…" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;

  const viewQuote = rows?.find(q => q.id === viewId) ?? null;
  const openValue = (rows ?? []).filter(q => isOpen(q) && !isExpired(q)).reduce((s, q) => s + q.total, 0);
  const openCount = (rows ?? []).filter(q => isOpen(q) && !isExpired(q)).length;
  const expiredCount = (rows ?? []).filter(isExpired).length;

  return (
    <div className="quotes-page">
      <div className="page-header">
        <div className="page-title">
          <h1>Quotes</h1>
          <p>Price quotes and proforma invoices. Stock and money only move when you turn one into a sale.</p>
        </div>
        <button className="btn-primary" onClick={() => { resetForm(); setShowModal(true); }}><Plus size={16} /> New Quote</button>
      </div>

      {(rows?.length ?? 0) > 0 && (
        <div className="stat-cards">
          <div className="stat-card">
            <div className="stat-label">Waiting on customers</div>
            <div className="stat-value">{fmt(openValue)}</div>
            <div className="stat-sub">{openCount} open {openCount === 1 ? 'quote' : 'quotes'}{expiredCount > 0 ? ` · ${expiredCount} expired` : ''}</div>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows ?? []}
        getRowKey={q => q.id}
        rowActions={rowActions}
        searchKeys={[q => q.doc_no ?? '', q => customerName(q.customer_id)]}
        searchPlaceholder="Search by number or customer…"
        exportName="quotes"
        exportTitle="Quotes"
        emptyMessage="No quotes yet. Create one, send it on WhatsApp, and turn it into a sale when the customer agrees."
      />

      {showModal && (
        <Modal onClose={() => setShowModal(false)} maxWidth={680}>
          <div className="modal-header">
            <h2>New {kindName(form.kind).toLowerCase()}</h2>
            <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button>
          </div>
          <form onSubmit={submitQuote}>
            <div className="modal-body">
              {createMut.error && <ErrorState message={createMut.error} />}

              <div className="q-kind" role="radiogroup" aria-label="Document type">
                {(['quote', 'proforma'] as const).map(k => (
                  <button key={k} type="button" role="radio" aria-checked={form.kind === k}
                    className={form.kind === k ? 'is-on' : ''} onClick={() => setForm(f => ({ ...f, kind: k }))}>
                    <strong>{kindName(k)}</strong>
                    <span>{k === 'quote' ? 'A price offer the customer can accept' : 'A bill to pay before you deliver'}</span>
                  </button>
                ))}
              </div>

              <div className="grid-2">
                <div className="form-group">
                  <label htmlFor="q-customer">Customer</label>
                  <select id="q-customer" value={form.customerId} onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))}>
                    <option value="">Walk-in customer</option>
                    {customers?.map(c => <option key={c.id} value={c.id}>{customerOption(c)}</option>)}
                  </select>
                </div>
                <div className="form-group">
                  <label htmlFor="q-valid">Valid until</label>
                  <input id="q-valid" type="date" value={form.validUntil} min={today()} onChange={e => setForm(f => ({ ...f, validUntil: e.target.value }))} />
                </div>
              </div>

              <h3 className="section-title">Products</h3>
              <div className="q-lines">
                <div className="q-line q-line-head" aria-hidden="true">
                  <span>Product</span><span>Qty</span><span>Price (₦)</span><span className="r">Amount</span><span />
                </div>
                {form.items.map((item, idx) => (
                  <div key={idx} className="q-line">
                    <select aria-label={`Product, line ${idx + 1}`} value={item.finished_good_id} onChange={e => updateItem(idx, 'finished_good_id', e.target.value)}>
                      <option value="">Choose a product</option>
                      {goods?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                    <NumberInput aria-label={`Quantity, line ${idx + 1}`} placeholder="Qty" value={item.quantity} onChange={v => updateItem(idx, 'quantity', v)} />
                    <NumberInput aria-label={`Unit price, line ${idx + 1}`} placeholder="Price ₦" value={item.unit_price} onChange={v => updateItem(idx, 'unit_price', v)} />
                    <span className="q-line-amount">{fmt(item.quantity * item.unit_price)}</span>
                    {form.items.length > 1
                      ? <button type="button" className="remove-item" onClick={() => removeItem(idx)} aria-label={`Remove line ${idx + 1}`}><Trash2 size={15} /></button>
                      : <span />}
                  </div>
                ))}
              </div>
              <button type="button" className="btn-ghost btn-sm" onClick={addItem}><Plus size={14} /> Add another product</button>

              <div className="total-row" style={{ marginTop: '1rem' }}>
                {vatRate > 0 && (
                  <div className="q-subtotals">Subtotal {fmt(subtotal)} · VAT ({vatRate}%) {fmt(vatAmt)}</div>
                )}
                <strong>Total {fmt(subtotal + vatAmt)}</strong>
              </div>

              <h3 className="section-title">Where the customer pays</h3>
              <BankAccountCard />

              <div className="grid-2">
                <div className="form-group">
                  <label htmlFor="q-terms">Terms (optional)</label>
                  <input id="q-terms" value={form.terms} onChange={e => setForm(f => ({ ...f, terms: e.target.value }))} placeholder="e.g. 50% deposit, balance on delivery" />
                </div>
                <div className="form-group">
                  <label htmlFor="q-notes">Note to customer (optional)</label>
                  <input id="q-notes" value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} placeholder="e.g. Delivery included" />
                </div>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={createMut.pending || !canSubmit}>
                {createMut.pending ? 'Saving…' : `Save ${kindName(form.kind).toLowerCase()}`}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {viewQuote && (
        <QuoteViewModal
          quote={viewQuote}
          customerName={customerName(viewQuote.customer_id)}
          productName={productName}
          onClose={() => setViewId(null)}
          onWhatsApp={() => sendWhatsApp(viewQuote)}
          onPdf={() => downloadPdf(viewQuote)}
          onConvert={() => { setViewId(null); setConvertFor(viewQuote); }}
        />
      )}

      {convertFor && (
        <ConvertQuoteModal
          quote={convertFor}
          payTypes={payTypes ?? []}
          onClose={() => setConvertFor(null)}
          onDone={() => { setConvertFor(null); refetch(); }}
        />
      )}
    </div>
  );
}

function QuoteViewModal({ quote, customerName, productName, onClose, onWhatsApp, onPdf, onConvert }: {
  quote: Quote; customerName: string; productName: (id: string) => string; onClose: () => void;
  onWhatsApp: () => void; onPdf: () => void; onConvert: () => void;
}) {
  const { data: detail, loading } = useQuery<any>(() => quotesApi.detail(quote.id), [quote.id]);
  const st = statusOf(quote);
  return (
    <Modal onClose={onClose} maxWidth={560}>
      <div className="modal-header">
        <h2>{kindName(quote.kind)} {quote.doc_no}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        <dl className="q-meta">
          <div><dt>Customer</dt><dd>{customerName}</dd></div>
          <div><dt>Status</dt><dd><span className={st.cls}>{st.label}</span></dd></div>
          <div><dt>Date</dt><dd>{fmtDate(quote.issue_date)}</dd></div>
          <div><dt>Valid until</dt><dd>{quote.valid_until ? fmtDate(quote.valid_until) : 'No end date'}</dd></div>
        </dl>
        {loading ? <Loading label="Loading…" /> : (
          <table className="q-items">
            <thead><tr><th>Product</th><th className="r">Qty</th><th className="r">Price</th><th className="r">Amount</th></tr></thead>
            <tbody>
              {(detail?.quote_items ?? []).map((i: any) => (
                <tr key={i.id}>
                  <td>{productName(i.finished_good_id)}</td>
                  <td className="r">{i.quantity}</td>
                  <td className="r">{fmt(i.unit_price)}</td>
                  <td className="r">{fmt(i.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="total-row" style={{ marginTop: '0.75rem' }}>
          {quote.vat_amount > 0 && <div className="q-subtotals">Subtotal {fmt(quote.subtotal)} · VAT ({quote.vat_rate}%) {fmt(quote.vat_amount)}</div>}
          <strong>Total {fmt(quote.total)}</strong>
        </div>
        {quote.terms && <p className="q-note"><strong>Terms:</strong> {quote.terms}</p>}
        {quote.notes && <p className="q-note"><strong>Note:</strong> {quote.notes}</p>}
        <h3 className="section-title">Where the customer pays</h3>
        <BankAccountCard compact />
      </div>
      <div className="modal-footer q-view-footer">
        <button className="btn-ghost" onClick={onPdf}><FileText size={15} /> PDF</button>
        {isOpen(quote) && <button className="btn-secondary" onClick={onWhatsApp}><MessageCircle size={15} /> WhatsApp</button>}
        {isOpen(quote) && <button className="btn-primary" onClick={onConvert}><ArrowRightCircle size={15} /> Turn into a sale</button>}
      </div>
    </Modal>
  );
}

function ConvertQuoteModal({ quote, payTypes, onClose, onDone }: {
  quote: Quote; payTypes: Lookup[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const realTypes = payTypes.filter(p => !/credit/i.test(p.name));
  const [paymentTypeId, setPaymentTypeId] = useState(() =>
    (realTypes.find(p => /transfer|bank/i.test(p.name)) ?? realTypes.find(p => /cash/i.test(p.name)) ?? realTypes[0])?.id ?? '');
  const [amountPaid, setAmountPaid] = useState(quote.total);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const onCredit = paymentTypeId === '';

  const pickType = (id: string) => {
    setPaymentTypeId(id);
    if (id === '') setAmountPaid(0);
    else if (amountPaid === 0) setAmountPaid(quote.total);
  };

  const submit = async (approval?: { userId: string; pin: string }) => {
    setPending(true);
    if (approval) { setApproving(true); setApprovalError(null); }
    try {
      await quotesApi.convert(quote.id, onCredit ? 0 : amountPaid, paymentTypeId || null, approval ?? null);
      toast.success(`${quote.doc_no} is now a sale. Find the invoice under Sales Orders.`);
      onDone();
    } catch (e: any) {
      const msg = e.message ?? String(e);
      if (!approval && NEEDS_APPROVAL.test(msg)) { setNeedsApproval(true); return; }
      if (approval) { setApprovalError(msg); return; }
      setError(msg);
    } finally {
      setPending(false);
      setApproving(false);
    }
  };

  if (needsApproval) {
    return (
      <ApprovalModal
        pending={approving}
        error={approvalError}
        onCancel={() => setNeedsApproval(false)}
        onApprove={(managerId, pin) => submit({ userId: managerId, pin })}
      />
    );
  }

  const owing = Math.max(0, quote.total - (onCredit ? 0 : amountPaid));
  // A debt with no name on it can never be collected.
  const walkInDebt = owing > 0 && !quote.customer_id;

  return (
    <Modal onClose={onClose} maxWidth={420}>
      <div className="modal-header">
        <h2>Turn {quote.doc_no} into a sale</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {error && <ErrorState message={error} />}
        <p className="q-note" style={{ marginTop: 0, marginBottom: '1rem' }}>
          This creates a real sale for {fmt(quote.total)} at the quoted prices and takes the goods out of stock.
        </p>
        <div className="form-group">
          <label htmlFor="cv-type">How did they pay?</label>
          <select id="cv-type" value={paymentTypeId} onChange={e => pickType(e.target.value)}>
            {realTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            {quote.customer_id && <option value="">Not paid yet (on credit)</option>}
          </select>
        </div>
        {!onCredit && (
          <div className="form-group">
            <label htmlFor="cv-amount">Amount paid now (₦)</label>
            <NumberInput id="cv-amount" value={amountPaid} max={quote.total} onChange={setAmountPaid} />
          </div>
        )}
        {walkInDebt
          ? <p className="q-note" role="alert">This quote is for a walk-in customer, so nothing can be left owing. Take the full {fmt(quote.total)}, or make a new quote with the customer's name.</p>
          : owing > 0 && <p className="q-note">The customer will owe {fmt(owing)}. You'll see it on their account under Customers.</p>}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={pending || walkInDebt} onClick={() => submit()}>
          {pending ? 'Working…' : 'Create sale'}
        </button>
      </div>
    </Modal>
  );
}
