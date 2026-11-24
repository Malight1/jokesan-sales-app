import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Plus, X, Pencil, Trash2, Wallet, MessageCircle, Phone, Copy, Link2, Eye, FileText, Ban, History } from 'lucide-react';
import {
  customers as customersApi, sales as salesApi, lookups, pricing, customFieldDefs, payments as paymentsApi, debts,
  Customer, PriceList, CustomFieldDef, SaleBalance, Lookup, IntegrationStatus,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { hasFeature } from '../lib/features';
import { whatsappLink, paymentRequestMessage, hasBank } from '../lib/whatsapp';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import OfflineBanner from '../components/OfflineBanner';
import CustomFieldsSection from '../components/CustomFieldsSection';
import CollectPaymentModal from '../components/CollectPaymentModal';
import Modal from '../components/Modal';
import NumberInput from '../components/NumberInput';
import StatementModal from '../components/StatementModal';
import OpeningDebtModal from '../components/OpeningDebtModal';
import { dueText } from '../lib/debts';
import '../styles/accounts.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

const emptyForm = {
  first_name: '', last_name: '', company_store: '', address: '', phone: '', email: '', customer_type_id: '', price_list_id: '',
  tin: '', customer_kind: 'b2c' as 'b2b' | 'b2c', custom_fields: {} as Record<string, any>,
  payment_terms_days: '' as string,
};

export const customerTitle = (c: Pick<Customer, 'first_name' | 'last_name' | 'company_store'>) =>
  `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || c.company_store || 'Customer';

interface Account { owed: number; bought: number; paid: number; invoices: number; last: string | null; open: SaleBalance[] }

export default function Customers() {
  const toast = useToast();
  const { tenant } = useAuth();
  const tiersEnabled = hasFeature(tenant, 'price_tiers');
  const { data: rows, loading, error, refetch, isOffline } = useQuery<Customer[]>(() => customersApi.list(), [], { cacheKey: 'customers-list' });
  const salesQ = useQuery<SaleBalance[]>(() => salesApi.balances().catch(() => []), [], { cacheKey: 'customers-balances' });
  const { data: types } = useQuery(() => lookups.customerTypes(), []);
  const { data: priceLists } = useQuery<PriceList[]>(() => pricing.lists().catch(() => []), []);
  const { data: customFieldDefsData } = useQuery<CustomFieldDef[]>(() => customFieldDefs.forEntity('customer').catch(() => []), []);
  const createMut = useMutation(customersApi.create);
  const updateMut = useMutation((id: string, c: Partial<Customer>) => customersApi.update(id, c));
  const removeMut = useMutation(customersApi.remove);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Customer | null>(null);
  const [deleteRow, setDeleteRow] = useState<Customer | null>(null);
  const [viewing, setViewing] = useState<Customer | null>(null);
  const [form, setForm] = useState(emptyForm);

  const typeName = (id: string | null) => types?.find(t => t.id === id)?.name ?? '';

  // Every customer's running account, worked out from their invoices.
  const accounts = useMemo(() => {
    const m = new Map<string, Account>();
    for (const s of salesQ.data ?? []) {
      if (!s.customer_id || s.voided) continue;
      const a = m.get(s.customer_id) ?? { owed: 0, bought: 0, paid: 0, invoices: 0, last: null, open: [] };
      a.bought += s.total_amount;
      a.paid += s.amount_paid;
      a.invoices += 1;
      if (s.balance > 0) { a.owed += s.balance; a.open.push(s); }
      if (!a.last || s.transaction_date > a.last) a.last = s.transaction_date;
      m.set(s.customer_id, a);
    }
    return m;
  }, [salesQ.data]);

  const totalOwed = Array.from(accounts.values()).reduce((s, a) => s + a.owed, 0);
  const owingCount = Array.from(accounts.values()).filter(a => a.owed > 0).length;
  const creditHeld = (rows ?? []).reduce((s, c) => s + (c.credit_balance ?? 0), 0);

  const openCreate = () => { setEditRow(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (c: Customer) => {
    setEditRow(c);
    setForm({
      first_name: c.first_name ?? '', last_name: c.last_name ?? '', company_store: c.company_store ?? '',
      address: c.address ?? '', phone: c.phone ?? '', email: c.email ?? '', customer_type_id: c.customer_type_id ?? '',
      price_list_id: c.price_list_id ?? '', tin: c.tin ?? '', customer_kind: c.customer_kind ?? 'b2c',
      custom_fields: c.custom_fields ?? {},
      payment_terms_days: c.payment_terms_days == null ? '' : String(c.payment_terms_days),
    });
    setShowModal(true);
  };

  // The custom_fields/tin/customer_kind columns exist once their
  // migrations have run; until then, don't send them (Postgres would
  // reject the whole save).
  const schemaHasCustomFields = (rows ?? []).some(r => 'custom_fields' in r);
  const schemaHasEinvoiceFields = (rows ?? []).some(r => 'customer_kind' in r);
  const schemaHasTerms = (rows ?? []).some(r => 'payment_terms_days' in r);
  const hasName = !!(form.first_name.trim() || form.company_store.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasName) { toast.error("Enter the customer's name or their business name."); return; }
    const { price_list_id, tin, customer_kind, custom_fields, payment_terms_days, ...rest } = form;
    const terms = payment_terms_days.trim() === '' ? null : Math.round(Number(payment_terms_days));
    if (terms !== null && (!Number.isFinite(terms) || terms < 0 || terms > 365)) { toast.error('Payment terms must be between 0 and 365 days.'); return; }
    const trimmed = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, typeof v === 'string' ? (v.trim() || null) : v]));
    const payload = {
      ...trimmed, customer_type_id: form.customer_type_id || null,
      ...(tiersEnabled ? { price_list_id: price_list_id || null } : {}),
      ...(schemaHasEinvoiceFields ? { tin: tin.trim() || null, customer_kind } : {}),
      ...(schemaHasCustomFields || Object.keys(custom_fields).length > 0 ? { custom_fields } : {}),
      ...(schemaHasTerms ? { payment_terms_days: terms } : {}),
    };
    const res = editRow
      ? await updateMut.mutate(editRow.id, payload)
      : await createMut.mutate(payload);
    if (res) {
      toast.success(editRow ? 'Customer updated.' : `${customerTitle(res)} added.`);
      setShowModal(false);
      setForm(emptyForm);
      setEditRow(null);
      refetch();
    } else {
      toast.error((editRow ? updateMut.error : createMut.error) ?? 'Something went wrong.');
    }
  };

  const handleDelete = async () => {
    if (!deleteRow) return;
    const res = await removeMut.mutate(deleteRow.id);
    if (res !== null) {
      toast.success('Customer deleted.');
      setDeleteRow(null);
      refetch();
    } else {
      const msg = removeMut.error ?? '';
      toast.error(msg.includes('foreign key') || msg.includes('violates')
        ? `${customerTitle(deleteRow)} can't be deleted because they have sales on record.`
        : msg || 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const columns: Column<Customer>[] = [
    { key: 'name', header: 'Customer', value: c => customerTitle(c),
      render: c => {
        const person = `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();
        return (
          <div className="acct-name">
            <strong>{customerTitle(c)}</strong>
            {c.company_store && person && <span>{c.company_store}</span>}
          </div>
        );
      } },
    { key: 'phone', header: 'Phone', value: c => c.phone ?? '',
      render: c => c.phone ? <a className="acct-tel" href={`tel:${c.phone.replace(/\s+/g, '')}`}>{c.phone}</a> : <span className="acct-muted">None</span> },
    { key: 'type', header: 'Type', value: c => typeName(c.customer_type_id),
      render: c => typeName(c.customer_type_id) ? <span className="badge-gray">{typeName(c.customer_type_id)}</span> : <span className="acct-muted">None</span> },
    { key: 'owed', header: 'Owes you', align: 'right', value: c => accounts.get(c.id)?.owed ?? 0,
      render: c => {
        const owed = accounts.get(c.id)?.owed ?? 0;
        if (owed <= 0) return <span className="acct-num acct-muted">{fmt(0)}</span>;
        return (
          <span className="acct-balance-cell">
            <span className="acct-owed">{fmt(owed)}</span>
            <button type="button" className="acct-cell-btn" onClick={() => setViewing(c)}>Collect</button>
          </span>
        );
      } },
    { key: 'credit_balance', header: 'Store credit', align: 'right', value: c => c.credit_balance ?? 0,
      render: c => (c.credit_balance ?? 0) > 0
        ? <span className="acct-credit">{fmt(c.credit_balance ?? 0)}</span>
        : <span className="acct-muted">None</span> },
    { key: 'last', header: 'Last bought', value: c => accounts.get(c.id)?.last ?? '',
      render: c => accounts.get(c.id)?.last ? fmtDate(accounts.get(c.id)?.last) : <span className="acct-muted">Never</span> },
  ];

  const rowActions: RowAction<Customer>[] = [
    { icon: <Eye size={15} />, label: 'Open account', onClick: setViewing },
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Customers</h1>
          <p>{rows ? `${rows.length} ${rows.length === 1 ? 'customer' : 'customers'}` : ' '}</p>
        </div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Customer</button>
      </div>

      {rows && rows.length > 0 && (
        <div className="stat-cards">
          <div className="stat-card">
            <div className="stat-label">Customers owe you</div>
            <div className="stat-value" style={{ color: totalOwed > 0 ? '#dc2626' : undefined }}>{fmt(totalOwed)}</div>
            <div className="stat-sub">{owingCount > 0 ? `${owingCount} ${owingCount === 1 ? 'customer has' : 'customers have'} unpaid invoices` : 'Nobody owes you right now'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Store credit you hold</div>
            <div className="stat-value">{fmt(creditHeld)}</div>
            <div className="stat-sub">From returns, spent on their next purchase</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Where customers pay you</div>
            {hasBank(tenant?.bank_details) ? (
              <>
                <div className="stat-value" style={{ fontSize: '1.15rem' }}>{tenant?.bank_details?.account_number}</div>
                <div className="stat-sub">{[tenant?.bank_details?.bank_name, tenant?.bank_details?.account_name].filter(Boolean).join(' · ')}</div>
              </>
            ) : (
              <div className="stat-sub" style={{ marginTop: 0 }}>
                No bank account yet. <Link to="/settings">Add it in Settings</Link> so every reminder tells customers where to pay.
              </div>
            )}
          </div>
        </div>
      )}

      {isOffline && <OfflineBanner label="customer list" />}
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={c => c.id}
        searchKeys={[c => customerTitle(c), c => c.company_store ?? '', c => c.phone ?? '']}
        searchPlaceholder="Search name or phone…"
        exportName="customers"
        exportTitle="Customers"
        rowActions={rowActions}
        emptyMessage="No customers yet. Add the people you sell to on credit, so you can see who owes you and remind them in one tap."
      />

      {viewing && (
        <CustomerAccountModal
          customer={viewing}
          account={accounts.get(viewing.id) ?? { owed: 0, bought: 0, paid: 0, invoices: 0, last: null, open: [] }}
          onClose={() => setViewing(null)}
          onEdit={() => { const c = viewing; setViewing(null); openEdit(c); }}
          onPaid={() => { salesQ.refetch(); refetch(); }}
        />
      )}

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Customer' : 'Add Customer'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <ErrorState message={formError} />}
                <div className="grid-2">
                  <div className="form-group"><label htmlFor="cus-first">First name</label><input id="cus-first" value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} /></div>
                  <div className="form-group"><label htmlFor="cus-last">Last name</label><input id="cus-last" value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} /></div>
                </div>
                <div className="form-group"><label htmlFor="cus-company">Business or store name</label><input id="cus-company" value={form.company_store} placeholder="e.g. Mama Tunde Stores" onChange={e => setForm(f => ({ ...f, company_store: e.target.value }))} /></div>
                <p className="acct-note" style={{ marginTop: '-0.5rem', marginBottom: '1rem' }}>A first name or a business name is enough.</p>
                <div className="grid-2">
                  <div className="form-group">
                    <label htmlFor="cus-phone">Phone (WhatsApp)</label>
                    <input id="cus-phone" type="tel" inputMode="tel" value={form.phone} placeholder="e.g. 0803 000 0000" onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
                  </div>
                  <div className="form-group">
                    <label htmlFor="cus-type">Customer type</label>
                    <select id="cus-type" value={form.customer_type_id} onChange={e => setForm(f => ({ ...f, customer_type_id: e.target.value }))}>
                      <option value="">None</option>
                      {types?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="grid-2">
                  <div className="form-group"><label htmlFor="cus-email">Email (optional)</label><input id="cus-email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
                  <div className="form-group"><label htmlFor="cus-address">Address</label><input id="cus-address" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></div>
                </div>
                {schemaHasTerms && (
                  <div className="form-group">
                    <label htmlFor="cus-terms">Days they have to pay</label>
                    <input id="cus-terms" inputMode="numeric" value={form.payment_terms_days} placeholder="Your usual terms"
                           onChange={e => setForm(f => ({ ...f, payment_terms_days: e.target.value.replace(/[^\d]/g, '').slice(0, 3) }))} />
                    <small className="acct-note">For example 14 or 30. Leave it empty to use your usual terms from Settings. Invoices show the due date, and Reports show who is late.</small>
                  </div>
                )}
                {tiersEnabled && (
                  <div className="form-group">
                    <label htmlFor="cus-pricelist">Price list</label>
                    <select id="cus-pricelist" value={form.price_list_id} onChange={e => setForm(f => ({ ...f, price_list_id: e.target.value }))}>
                      <option value="">Use their customer type's list</option>
                      {priceLists?.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
                    </select>
                    <small className="acct-note">Only for this one customer. Leave it to follow their customer type.</small>
                  </div>
                )}
                {schemaHasEinvoiceFields && (
                  <div className="grid-2">
                    <div className="form-group">
                      <label htmlFor="cus-kind">Is this a registered business?</label>
                      <select id="cus-kind" value={form.customer_kind} onChange={e => setForm(f => ({ ...f, customer_kind: e.target.value as 'b2b' | 'b2c' }))}>
                        <option value="b2c">No, an individual</option>
                        <option value="b2b">Yes, a registered business</option>
                      </select>
                    </div>
                    {form.customer_kind === 'b2b' && (
                      <div className="form-group">
                        <label htmlFor="cus-tin">Tax ID (TIN)</label>
                        <input id="cus-tin" value={form.tin} onChange={e => setForm(f => ({ ...f, tin: e.target.value }))} placeholder="e.g. 01234567-0001" />
                      </div>
                    )}
                  </div>
                )}
                <CustomFieldsSection defs={customFieldDefsData} values={form.custom_fields}
                  onChange={cf => setForm(f => ({ ...f, custom_fields: cf }))} />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={pending || !hasName}>
                  {pending ? 'Saving…' : editRow ? 'Update Customer' : 'Save Customer'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {deleteRow && (
        <ConfirmDialog
          title="Delete Customer"
          message={<>Delete <strong>{customerTitle(deleteRow)}</strong>? This cannot be undone.</>}
          confirmLabel="Delete"
          pending={removeMut.pending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteRow(null)}
        />
      )}
    </div>
  );
}

// One customer's account: what they owe, on which invoices, and the two
// ways to get paid (record money that came in, or send them a payment
// request with your bank account and, if Paystack is connected, a pay link).
function CustomerAccountModal({ customer, account, onClose, onEdit, onPaid }: {
  customer: Customer; account: Account; onClose: () => void; onEdit: () => void; onPaid: () => void;
}) {
  const toast = useToast();
  const { tenant, profile } = useAuth();
  const { data: payTypes } = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);
  const { data: integration } = useQuery<IntegrationStatus>(() => paymentsApi.integrationStatus().catch(() => ({ connected: false } as IntegrationStatus)), []);
  const [collecting, setCollecting] = useState<SaleBalance | null>(null);
  const [linkFor, setLinkFor] = useState<string | null>(null);
  const [showStatement, setShowStatement] = useState(false);
  const [addingOpening, setAddingOpening] = useState(false);
  const [writingOff, setWritingOff] = useState<SaleBalance | null>(null);
  const isOwner = profile?.role === 'admin';

  const name = customerTitle(customer);
  const bank = tenant?.bank_details;
  const canRemind = hasFeature(tenant, 'debt_reminders');
  const docNo = (s: SaleBalance) => s.doc_no ?? `#${s.id.slice(0, 8).toUpperCase()}`;
  const open = [...account.open].sort((a, b) => a.transaction_date.localeCompare(b.transaction_date));
  const daysOld = (d: string) => Math.max(0, Math.floor((Date.now() - new Date(d).getTime()) / 86_400_000));

  const sendRequest = async () => {
    if (!canRemind) {
      toast.info('WhatsApp payment requests are on the Growth plan and above. Upgrade under Settings → Billing.');
      return;
    }
    const message = paymentRequestMessage({
      businessName: tenant?.name ?? 'us', customerName: name, total: account.owed,
      invoices: open.map(s => ({ docNo: docNo(s), date: fmtDate(s.transaction_date), balance: s.balance })),
      bank,
    });
    window.open(whatsappLink(customer.phone, message), '_blank');
    try { await customersApi.markReminded(customer.id); } catch { /* reminder still sent */ }
  };

  const sendPayLink = async (s: SaleBalance) => {
    setLinkFor(s.id);
    try {
      const res = await paymentsApi.createLink(s.id);
      if (res.error || !res.url) { toast.error(res.error ?? 'Could not create a pay link.'); return; }
      const message = paymentRequestMessage({
        businessName: tenant?.name ?? 'us', customerName: name, total: s.balance,
        invoices: [{ docNo: docNo(s), date: fmtDate(s.transaction_date), balance: s.balance }],
        bank, payUrl: res.url, payUntil: res.expiresAt, friendly: false,
      });
      window.open(whatsappLink(customer.phone, message), '_blank');
      toast.success('Pay link sent. The invoice marks itself paid once they pay.');
    } finally {
      setLinkFor(null);
    }
  };

  const copyAccount = async () => {
    const text = [bank?.bank_name, bank?.account_number, bank?.account_name].filter(Boolean).join('\n');
    try { await navigator.clipboard.writeText(text); toast.success('Bank details copied.'); }
    catch { toast.error('Could not copy.'); }
  };

  return (
    <>
      <Modal onClose={onClose} maxWidth={640}>
        <div className="modal-header acct-modal-head">
          <div>
            <h2>{name}</h2>
            <div className="acct-contact">
              {customer.company_store && customer.company_store !== name && <span>{customer.company_store}</span>}
              {customer.phone ? <a href={`tel:${customer.phone.replace(/\s+/g, '')}`}>{customer.phone}</a> : <span>No phone saved</span>}
              {customer.last_reminded_at && <span>Last reminded {fmtDate(customer.last_reminded_at)}</span>}
            </div>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          <dl className="acct-figures">
            <div className={account.owed > 0 ? 'is-owed' : ''}><dt>Owes you</dt><dd>{fmt(account.owed)}</dd></div>
            <div><dt>Bought in total</dt><dd>{fmt(account.bought)}</dd></div>
            <div className={(customer.credit_balance ?? 0) > 0 ? 'is-credit' : ''}><dt>Store credit</dt><dd>{fmt(customer.credit_balance ?? 0)}</dd></div>
          </dl>

          <div className="acct-actions">
            {account.owed > 0 && (
              <button type="button" className="btn-primary" onClick={sendRequest}>
                <MessageCircle size={16} /> Send payment request
              </button>
            )}
            {customer.phone && (
              <a className="btn-secondary" href={`tel:${customer.phone.replace(/\s+/g, '')}`}><Phone size={16} /> Call</a>
            )}
            <button type="button" className="btn-secondary" onClick={() => setShowStatement(true)}><FileText size={16} /> Statement</button>
            <button type="button" className="btn-ghost" onClick={onEdit}><Pencil size={16} /> Edit details</button>
            {isOwner && (
              <button type="button" className="btn-ghost" onClick={() => setAddingOpening(true)}><History size={16} /> Owed before ProfixBook</button>
            )}
          </div>

          <section className="acct-section">
            <h3>Unpaid invoices</h3>
            {open.length === 0 ? (
              <div className="acct-empty">{account.invoices > 0 ? `${name} has paid every invoice.` : `No sales to ${name} yet.`}</div>
            ) : (
              <ul className={`acct-list${isOwner ? ' has-many-actions' : ''}`}>
                {open.map(s => (
                  <li key={s.id}>
                    <div className="acct-list-main">
                      <span className="acct-list-title">
                        {docNo(s)}
                        {Number(s.opening_amount || 0) > 0 && <span className="acct-list-tag">owed before ProfixBook</span>}
                      </span>
                      <span className="acct-list-meta">
                        {fmtDate(s.transaction_date)}
                        {s.due_date
                          ? <> · <span className={dueText(s.due_date).late ? 'acct-late' : undefined}>{dueText(s.due_date).text}</span></>
                          : <> · {daysOld(s.transaction_date) === 0 ? 'today' : `${daysOld(s.transaction_date)} days ago`}</>}
                        {s.amount_paid > 0 && ` · paid ${fmt(s.amount_paid)} of ${fmt(s.total_amount + Number(s.opening_amount || 0))}`}
                      </span>
                    </div>
                    <span className="acct-list-amount acct-owed">{fmt(s.balance)}</span>
                    <div className="acct-list-actions">
                      <button type="button" className="btn-secondary btn-sm" onClick={() => setCollecting(s)}><Wallet size={13} /> Record payment</button>
                      {integration?.connected && (
                        <button type="button" className="btn-ghost btn-sm" onClick={() => sendPayLink(s)} disabled={linkFor === s.id}>
                          <Link2 size={13} /> {linkFor === s.id ? 'Creating…' : 'Pay link'}
                        </button>
                      )}
                      {isOwner && (
                        <button type="button" className="btn-ghost btn-sm" onClick={() => setWritingOff(s)}>
                          <Ban size={13} /> Write off
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="acct-section" style={{ marginBottom: 0 }}>
            <h3>Where they pay you</h3>
            {hasBank(bank) ? (
              <div className="acct-bank">
                <div className="acct-bank-lines">
                  <span className="acct-bank-number">{bank.account_number}</span>
                  <span>{[bank.bank_name, bank.account_name].filter(Boolean).join(' · ')}</span>
                </div>
                <button type="button" className="btn-secondary btn-sm" onClick={copyAccount}><Copy size={13} /> Copy</button>
              </div>
            ) : (
              <div className="acct-bank-missing">
                Your bank account isn't saved, so payment requests can't say where to pay.{' '}
                {profile?.role === 'admin'
                  ? <Link to="/settings" onClick={onClose}>Add it in Settings → Business &amp; Profile.</Link>
                  : 'Ask your admin to add it in Settings.'}
              </div>
            )}
          </section>
        </div>
      </Modal>

      {collecting && (
        <CollectPaymentModal
          saleId={collecting.id}
          docNo={docNo(collecting)}
          customerName={name}
          balance={collecting.balance}
          payTypes={payTypes ?? []}
          onClose={() => setCollecting(null)}
          onDone={() => { setCollecting(null); onPaid(); }}
        />
      )}
      {showStatement && (
        <StatementModal customerId={customer.id} customerName={name} phone={customer.phone} onClose={() => setShowStatement(false)} />
      )}
      {addingOpening && (
        <OpeningDebtModal kind="customer" partyId={customer.id} partyName={name}
                          onClose={() => setAddingOpening(false)} onDone={() => { setAddingOpening(false); onPaid(); }} />
      )}
      {writingOff && (
        <WriteOffModal sale={writingOff} docNo={docNo(writingOff)} customerName={name}
                       onClose={() => setWritingOff(null)} onDone={() => { setWritingOff(null); onPaid(); }} />
      )}
    </>
  );
}

// Writing off what a customer will never pay (migration 0062). No money
// moves: the invoice stops being owed and the amount shows as a bad debt
// on the Profit & Loss.
function WriteOffModal({ sale, docNo, customerName, onClose, onDone }: {
  sale: SaleBalance; docNo: string; customerName: string; onClose: () => void; onDone: () => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState(Number(sale.balance));
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (amount <= 0 || amount > sale.balance + 0.005) { setError(`Enter an amount from ₦1 up to ${fmt(sale.balance)}.`); return; }
    setPending(true); setError(null);
    try {
      await debts.writeOff(sale.id, amount, reason.trim() || null);
      toast.success(`${fmt(amount)} written off ${docNo}.`);
      onDone();
    } catch (err: any) {
      setError(err?.message ?? 'Could not write it off.');
    } finally {
      setPending(false);
    }
  };

  return (
    <Modal onClose={onClose} maxWidth={440}>
      <div className="modal-header">
        <h2>Write off {docNo}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <ErrorState message={error} />}
          <p style={{ fontSize: '0.875rem', color: '#475569', lineHeight: 1.55, margin: '0 0 1rem' }}>
            Only when {customerName} will never pay. The invoice stops showing as owed, and the amount counts as a bad debt
            on your Profit &amp; Loss. No money moves. If they pay after all, open the invoice under Sales Orders and undo the write-off.
          </p>
          <div className="form-group">
            <label htmlFor="wo-amount">Amount to write off (₦)</label>
            <NumberInput id="wo-amount" value={amount} onChange={setAmount} />
            <small className="acct-note">{fmt(sale.balance)} is still owed on this invoice.</small>
          </div>
          <div className="form-group">
            <label htmlFor="wo-reason">Why (optional)</label>
            <input id="wo-reason" value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Customer closed the shop and moved away" />
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
          <button type="submit" className="btn-danger" disabled={pending}>{pending ? 'Saving…' : 'Write off'}</button>
        </div>
      </form>
    </Modal>
  );
}
