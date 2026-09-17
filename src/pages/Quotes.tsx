import React, { useState } from 'react';
import { Plus, X, Eye, FileText, MessageCircle, ArrowRightCircle, Ban } from 'lucide-react';
import {
  quotes as quotesApi, customers as customersApi, finishedGoods as goodsApi, lookups, branding,
  Quote, QuoteStatus, Customer, FinishedGood, Lookup,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { generateQuotePdf } from '../lib/invoice';
import { whatsappLink } from '../lib/whatsapp';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import Modal from '../components/Modal';
import ApprovalModal from '../components/ApprovalModal';
import NumberInput from '../components/NumberInput';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const NEEDS_APPROVAL = /manager'?s? pin/i;

interface LineItem { finished_good_id: string; quantity: number; unit_price: number; }

const STATUS_BADGE: Record<QuoteStatus, string> = {
  draft: 'badge-gray', sent: 'badge-primary', accepted: 'badge-success',
  declined: 'badge-danger', converted: 'badge-success', cancelled: 'badge-danger',
};

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
  const [form, setForm] = useState({
    kind: 'quote' as 'quote' | 'proforma', customerId: '', validUntil: '', notes: '', terms: '',
    items: [blankItem()],
  });

  const customerName = (id: string | null) => {
    const c = customers?.find(x => x.id === id);
    return c ? `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer' : '—';
  };
  const productName = (id: string) => goods?.find(g => g.id === id)?.name ?? '—';

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, blankItem()] }));
  const removeItem = (idx: number) => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  const updateItem = (idx: number, field: keyof LineItem, value: any) =>
    setForm(f => {
      const items = [...f.items];
      (items[idx] as any)[field] = value;
      if (field === 'finished_good_id') items[idx].unit_price = goods?.find(g => g.id === value)?.selling_price ?? 0;
      return { ...f, items };
    });

  const validItems = form.items.filter(i => i.finished_good_id && i.quantity > 0);
  const subtotal = validItems.reduce((s, i) => s + i.quantity * i.unit_price, 0);
  const vatRate = tenant?.vat_enabled ? tenant.vat_rate : 0;
  const vatAmt = subtotal * vatRate / 100;
  const canSubmit = validItems.length > 0;

  const resetForm = () => setForm({ kind: 'quote', customerId: '', validUntil: '', notes: '', terms: '', items: [blankItem()] });

  const submitQuote = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) { toast.error('Add at least one item.'); return; }
    const res = await createMut.mutate({
      customerId: form.customerId || null, kind: form.kind,
      items: validItems.map(i => ({ finished_good_id: i.finished_good_id, quantity: Number(i.quantity), unit_price: Number(i.unit_price) })),
      validUntil: form.validUntil || null, notes: form.notes.trim() || null, terms: form.terms.trim() || null,
    });
    if (res) {
      toast.success(form.kind === 'proforma' ? 'Proforma invoice created.' : 'Quote created.');
      setShowModal(false); resetForm(); refetch();
    } else {
      toast.error(createMut.error ?? 'Could not create it.');
    }
  };

  const changeStatus = async (q: Quote, status: Exclude<QuoteStatus, 'converted'>) => {
    const res = await statusMut.mutate(q.id, status);
    if (res !== null) { toast.success(`${q.doc_no} marked ${status}.`); refetch(); }
    else toast.error(statusMut.error ?? 'Could not update status.');
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
    } catch (e: any) {
      toast.error(e.message ?? 'Could not generate the PDF.');
    }
  };

  const sendWhatsApp = (q: Quote) => {
    const cust = customers?.find(c => c.id === q.customer_id);
    const lines = [
      `Hello ${customerName(q.customer_id)}!`,
      ``,
      `*${tenant?.name ?? 'Quote'}* — ${q.doc_no} (${q.kind === 'proforma' ? 'Proforma Invoice' : 'Quotation'})`,
      `Total: ${fmt(q.total)}`,
      q.valid_until ? `Valid until: ${q.valid_until}` : '',
      ``,
      `Let us know if you'd like to go ahead!`,
    ].filter(Boolean);
    window.open(whatsappLink(cust?.phone, lines.join('\n')), '_blank');
    if (q.status === 'draft') changeStatus(q, 'sent');
  };

  const columns: Column<Quote>[] = [
    { key: 'doc_no', header: 'No.', value: q => q.doc_no ?? '', render: q => <span style={{ fontVariantNumeric: 'tabular-nums' }}>{q.doc_no}</span> },
    { key: 'kind', header: 'Kind', value: q => q.kind, render: q => <span className="badge-gray">{q.kind === 'proforma' ? 'Proforma' : 'Quote'}</span> },
    { key: 'customer', header: 'Customer', value: q => customerName(q.customer_id) },
    { key: 'issue_date', header: 'Date', value: q => q.issue_date },
    { key: 'total', header: 'Total', align: 'right', value: q => q.total, render: q => fmt(q.total) },
    { key: 'status', header: 'Status', value: q => q.status, render: q => <span className={STATUS_BADGE[q.status]}>{q.status}</span> },
  ];

  const rowActions: RowAction<Quote>[] = [
    { icon: <Eye size={15} />, label: 'View', onClick: q => setViewId(q.id) },
    { icon: <FileText size={15} />, label: 'Download PDF', onClick: downloadPdf },
    { icon: <MessageCircle size={15} />, label: 'Send on WhatsApp', onClick: sendWhatsApp },
    { icon: <ArrowRightCircle size={15} />, label: 'Convert to sale', onClick: setConvertFor,
      show: q => q.status !== 'converted' && q.status !== 'declined' && q.status !== 'cancelled' },
    { icon: <Ban size={15} />, label: 'Cancel', onClick: q => changeStatus(q, 'cancelled'),
      show: q => q.status !== 'converted' && q.status !== 'cancelled', variant: 'danger' },
  ];

  if (loading) return <Loading label="Loading quotes…" />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;

  const viewQuote = rows?.find(q => q.id === viewId) ?? null;

  return (
    <div className="quotes-page">
      <div className="page-header">
        <div className="page-title"><h1>Quotes</h1><p>Price estimates and proforma invoices — no stock or money moves until converted</p></div>
        <button className="btn-primary" onClick={() => { resetForm(); setShowModal(true); }}><Plus size={16} /> New Quote</button>
      </div>

      <DataTable
        columns={columns}
        rows={rows ?? []}
        getRowKey={q => q.id}
        rowActions={rowActions}
        searchKeys={[q => q.doc_no ?? '', q => customerName(q.customer_id)]}
        searchPlaceholder="Search quotes…"
        emptyMessage="No quotes yet."
      />

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
          <div className="modal-header">
            <h2>New {form.kind === 'proforma' ? 'Proforma Invoice' : 'Quote'}</h2>
            <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
          </div>
          <form onSubmit={submitQuote}>
            <div className="modal-body">
              {createMut.error && <ErrorState message={createMut.error} />}
              <div className="grid-2">
                <div className="form-group">
                  <label>Kind</label>
                  <select value={form.kind} onChange={e => setForm(f => ({ ...f, kind: e.target.value as 'quote' | 'proforma' }))}>
                    <option value="quote">Quote</option>
                    <option value="proforma">Proforma Invoice</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Customer</label>
                  <select value={form.customerId} onChange={e => setForm(f => ({ ...f, customerId: e.target.value }))}>
                    <option value="">Walk-in / none</option>
                    {customers?.map(c => <option key={c.id} value={c.id}>{c.first_name} {c.last_name} — {c.company_store}</option>)}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>Valid until (optional)</label>
                <input type="date" value={form.validUntil} onChange={e => setForm(f => ({ ...f, validUntil: e.target.value }))} />
              </div>

              <h3 className="section-title">Items</h3>
              {form.items.map((item, idx) => (
                <div key={idx} style={{ display: 'flex', gap: '0.6rem', alignItems: 'flex-end', marginBottom: '0.6rem' }}>
                  <div className="form-group" style={{ flex: 2, marginBottom: 0 }}>
                    <label>Product</label>
                    <select value={item.finished_good_id} onChange={e => updateItem(idx, 'finished_good_id', e.target.value)}>
                      <option value="">— select —</option>
                      {goods?.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                    <label>Qty</label>
                    <NumberInput value={item.quantity} onChange={v => updateItem(idx, 'quantity', v)} />
                  </div>
                  <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
                    <label>Unit Price (₦)</label>
                    <NumberInput value={item.unit_price} onChange={v => updateItem(idx, 'unit_price', v)} />
                  </div>
                  <div style={{ minWidth: 90, textAlign: 'right', fontWeight: 600, paddingBottom: 8 }}>{fmt(item.quantity * item.unit_price)}</div>
                  {form.items.length > 1 && (
                    <button type="button" className="remove-item" onClick={() => removeItem(idx)} style={{ marginBottom: 8 }}><X size={14} /></button>
                  )}
                </div>
              ))}
              <button type="button" className="btn-ghost btn-sm" onClick={addItem}><Plus size={14} /> Add item</button>

              <div className="grid-2" style={{ marginTop: '1rem' }}>
                <div className="form-group">
                  <label>Notes (optional)</label>
                  <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
                </div>
                <div className="form-group">
                  <label>Terms (optional)</label>
                  <input value={form.terms} onChange={e => setForm(f => ({ ...f, terms: e.target.value }))} placeholder="e.g. 50% deposit, balance on delivery" />
                </div>
              </div>

              <div className="total-row">
                {vatRate > 0 && (
                  <div style={{ fontSize: '0.85rem', color: '#64748b', fontWeight: 400, marginBottom: 4 }}>
                    Subtotal: {fmt(subtotal)} &nbsp;·&nbsp; VAT ({vatRate}%): {fmt(vatAmt)}
                  </div>
                )}
                <strong>Total: {fmt(subtotal + vatAmt)}</strong>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
              <button type="submit" className="btn-primary" disabled={createMut.pending || !canSubmit}>
                {createMut.pending ? 'Saving…' : 'Save'}
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

function QuoteViewModal({ quote, customerName, productName, onClose }: {
  quote: Quote; customerName: string; productName: (id: string) => string; onClose: () => void;
}) {
  const { data: detail, loading } = useQuery<any>(() => quotesApi.detail(quote.id), [quote.id]);
  return (
    <Modal onClose={onClose} maxWidth={480}>
      <div className="modal-header"><h2>{quote.doc_no}</h2></div>
      <div className="modal-body">
        <p style={{ color: '#64748b', fontSize: '0.85rem', marginBottom: '0.75rem' }}>
          {quote.kind === 'proforma' ? 'Proforma Invoice' : 'Quote'} for <strong>{customerName}</strong> · <span className={STATUS_BADGE[quote.status]}>{quote.status}</span>
        </p>
        {loading ? <Loading label="Loading…" /> : (
          <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
            <thead><tr style={{ textAlign: 'left', color: '#94a3b8' }}><th>Item</th><th style={{ textAlign: 'right' }}>Qty</th><th style={{ textAlign: 'right' }}>Price</th><th style={{ textAlign: 'right' }}>Amount</th></tr></thead>
            <tbody>
              {(detail?.quote_items ?? []).map((i: any) => (
                <tr key={i.id}>
                  <td>{productName(i.finished_good_id)}</td>
                  <td style={{ textAlign: 'right' }}>{i.quantity}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(i.unit_price)}</td>
                  <td style={{ textAlign: 'right' }}>{fmt(i.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="total-row" style={{ marginTop: '0.75rem' }}><strong>Total: {fmt(quote.total)}</strong></div>
        {quote.notes && <p style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.5rem' }}>Notes: {quote.notes}</p>}
      </div>
      <div className="modal-footer">
        <button className="btn-primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

function ConvertQuoteModal({ quote, payTypes, onClose, onDone }: {
  quote: Quote; payTypes: Lookup[]; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [amountPaid, setAmountPaid] = useState(quote.total);
  const [paymentTypeId, setPaymentTypeId] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsApproval, setNeedsApproval] = useState(false);
  const [approving, setApproving] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);

  const submit = async (approval?: { userId: string; pin: string }) => {
    setPending(true);
    if (approval) { setApproving(true); setApprovalError(null); }
    try {
      await quotesApi.convert(quote.id, amountPaid, paymentTypeId || null, approval ?? null);
      toast.success(`${quote.doc_no} converted to a sale.`);
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

  return (
    <Modal onClose={onClose} maxWidth={380}>
      <div className="modal-header"><h2>Convert {quote.doc_no} to a sale</h2></div>
      <div className="modal-body">
        {error && <ErrorState message={error} />}
        <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem' }}>
          This creates a real sale at the quoted prices and deducts stock. Total: {fmt(quote.total)}.
        </p>
        <div className="form-group">
          <label>Payment Type</label>
          <select value={paymentTypeId} onChange={e => setPaymentTypeId(e.target.value)}>
            <option value="">— on credit —</option>
            {payTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Amount Paid Now (₦)</label>
          <NumberInput value={amountPaid} onChange={setAmountPaid} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-primary" disabled={pending} onClick={() => submit()}>
          {pending ? 'Converting…' : 'Convert to Sale'}
        </button>
      </div>
    </Modal>
  );
}
