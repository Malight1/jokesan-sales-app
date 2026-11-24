import React, { useMemo, useState } from 'react';
import { Plus, X, Pencil, Trash2, Eye, Phone, Copy, Wallet, MessageCircle, History } from 'lucide-react';
import {
  suppliers as suppliersApi, purchases as purchasesApi, customFieldDefs, lookups,
  Supplier, CustomFieldDef, PurchaseOrder, Lookup,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { hasFeature } from '../lib/features';
import { personName, supplierTitle } from '../lib/supplierName';
import { whatsappLink } from '../lib/whatsapp';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import CustomFieldsSection from '../components/CustomFieldsSection';
import Modal from '../components/Modal';
import OpeningDebtModal from '../components/OpeningDebtModal';
import { dueText } from '../lib/debts';
import { PayModal } from './Purchases';
import './Purchases.scss';
import '../styles/accounts.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

const emptyForm = {
  first_name: '', last_name: '', company_store: '', address: '', email: '', phone: '',
  bank_name: '', account_number: '', account_name: '',
  custom_fields: {} as Record<string, any>,
  payment_terms_days: '' as string,
};

interface Account { owed: number; credit: number; bought: number; paid: number; count: number; last: string | null; open: PurchaseOrder[] }
const emptyAccount: Account = { owed: 0, credit: 0, bought: 0, paid: 0, count: 0, last: null, open: [] };

export default function Suppliers() {
  const toast = useToast();
  const { profile, tenant } = useAuth();
  // Paying a supplier is admin, inventory or accounts; the database checks
  // it too (guard_money_write), this only hides buttons that would fail.
  const canPay = ['admin', 'inventory', 'accounts'].includes(profile?.role ?? '');
  const { data: rows, loading, error, refetch } = useQuery<Supplier[]>(() => suppliersApi.list(), []);
  const purchasesQ = useQuery<PurchaseOrder[]>(() => purchasesApi.list().catch(() => []), []);
  const { data: customFieldDefsData } = useQuery<CustomFieldDef[]>(() => customFieldDefs.forEntity('supplier').catch(() => []), []);
  const payTypesQ = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);
  // "Credit" isn't a way of paying a supplier; owing them is what a balance is.
  const payTypes = useMemo(() => (payTypesQ.data ?? []).filter(t => !/credit/i.test(t.name)), [payTypesQ.data]);
  const createMut = useMutation(suppliersApi.create);
  const updateMut = useMutation((id: string, s: Partial<Supplier>) => suppliersApi.update(id, s));
  const removeMut = useMutation(suppliersApi.remove);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Supplier | null>(null);
  const [deleteRow, setDeleteRow] = useState<Supplier | null>(null);
  const [viewing, setViewing] = useState<Supplier | null>(null);
  const [form, setForm] = useState(emptyForm);

  const accounts = useMemo(() => {
    const m = new Map<string, Account>();
    for (const p of purchasesQ.data ?? []) {
      if (!p.supplier_id || p.voided || p.status === 'cancelled') continue;
      const a = m.get(p.supplier_id) ?? { ...emptyAccount, open: [] };
      a.bought += p.total_amount;
      a.paid += p.total_paid;
      a.count += 1;
      if (p.balance > 0) { a.owed += p.balance; a.open.push(p); }
      if (p.balance < 0) a.credit += -p.balance;
      if (!a.last || p.purchase_date > a.last) a.last = p.purchase_date;
      m.set(p.supplier_id, a);
    }
    return m;
  }, [purchasesQ.data]);

  const openCreate = () => { setEditRow(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (s: Supplier) => {
    setEditRow(s);
    setForm({
      first_name: s.first_name ?? '', last_name: s.last_name ?? '', company_store: s.company_store ?? '',
      address: s.address ?? '', email: s.email ?? '', phone: s.phone ?? '',
      bank_name: s.bank_name ?? '', account_number: s.account_number ?? '', account_name: s.account_name ?? '',
      custom_fields: s.custom_fields ?? {},
      payment_terms_days: s.payment_terms_days == null ? '' : String(s.payment_terms_days),
    });
    setShowModal(true);
  };

  // These columns exist once their migrations have run (0032 custom
  // fields, 0053 bank details); until then, don't send them, or Postgres
  // rejects the whole save.
  const schemaHasCustomFields = (rows ?? []).some(r => 'custom_fields' in r);
  const schemaHasBank = (rows ?? []).some(r => 'account_number' in r);
  const schemaHasTerms = (rows ?? []).some(r => 'payment_terms_days' in r);
  // A supplier is often just a business, so either name will do.
  const hasName = !!(form.company_store.trim() || form.first_name.trim() || form.last_name.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasName) { toast.error('Enter a business name or a contact person.'); return; }
    const { custom_fields, bank_name, account_number, account_name, payment_terms_days, ...rest } = form;
    const terms = payment_terms_days.trim() === '' ? null : Math.round(Number(payment_terms_days));
    if (terms !== null && (terms < 0 || terms > 365)) { toast.error('Payment terms must be between 0 and 365 days.'); return; }
    const trimmed = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v.trim() || null]));
    const bank = { bank_name: bank_name.trim() || null, account_number: account_number.replace(/\s+/g, '') || null, account_name: account_name.trim() || null };
    const wantsBank = !!(bank.bank_name || bank.account_number || bank.account_name);
    const payload = {
      ...trimmed,
      ...(schemaHasBank || (rows ?? []).length === 0 || wantsBank ? bank : {}),
      ...(schemaHasCustomFields || Object.keys(custom_fields).length > 0 ? { custom_fields } : {}),
      ...(schemaHasTerms ? { payment_terms_days: terms } : {}),
    };
    let res = editRow ? await updateMut.mutate(editRow.id, payload) : await createMut.mutate(payload);
    // A first supplier on a database without 0053 yet: retry without bank fields.
    if (!res && !schemaHasBank && !wantsBank) {
      const { bank_name: _b, account_number: _n, account_name: _a, ...noBank } = payload as any;
      res = editRow ? await updateMut.mutate(editRow.id, noBank) : await createMut.mutate(noBank);
    }
    if (res) {
      toast.success(editRow ? 'Supplier updated.' : `${supplierTitle(res)} added.`);
      setShowModal(false);
      setForm(emptyForm);
      setEditRow(null);
      refetch();
    } else {
      const msg = (editRow ? updateMut.error : createMut.error) ?? '';
      toast.error(/account_number|bank_name|account_name/.test(msg)
        ? "Bank details can't be saved on this workspace yet. Clear them and save, or contact support."
        : msg || 'Something went wrong.');
    }
  };

  const handleDelete = async () => {
    if (!deleteRow) return;
    const res = await removeMut.mutate(deleteRow.id);
    if (res !== null) {
      toast.success('Supplier deleted.');
      setDeleteRow(null);
      refetch();
    } else {
      const msg = removeMut.error ?? '';
      toast.error(msg.includes('foreign key') || msg.includes('violates')
        ? `${supplierTitle(deleteRow)} can't be deleted because purchases are recorded against them.`
        : msg || 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const columns: Column<Supplier>[] = [
    { key: 'name', header: 'Supplier', value: s => supplierTitle(s),
      render: s => {
        const person = personName(s);
        const title = supplierTitle(s);
        return (
          <div className="acct-name">
            <strong>{title}</strong>
            {person && person !== title && <span>{person}</span>}
          </div>
        );
      } },
    { key: 'phone', header: 'Phone', value: s => s.phone ?? '',
      render: s => s.phone ? <a className="acct-tel" href={`tel:${s.phone.replace(/\s+/g, '')}`}>{s.phone}</a> : <span className="acct-muted">None</span> },
    { key: 'owed', header: 'You owe them', align: 'right', value: s => accounts.get(s.id)?.owed ?? 0,
      render: s => {
        const a = accounts.get(s.id);
        if (a && a.owed > 0) {
          return (
            <span className="acct-balance-cell">
              <span className="acct-owed">{fmt(a.owed)}</span>
              {canPay && <button type="button" className="acct-cell-btn" onClick={() => setViewing(s)}>Pay</button>}
            </span>
          );
        }
        if (a && a.credit > 0) return <span className="acct-credit">They owe you {fmt(a.credit)}</span>;
        return <span className="acct-num acct-muted">Nothing</span>;
      } },
    { key: 'bank', header: 'Pay into', value: s => s.account_number ?? '',
      render: s => s.account_number
        ? <div className="acct-name"><strong className="acct-num">{s.account_number}</strong><span>{s.bank_name}</span></div>
        : <span className="acct-muted">No bank details</span> },
    { key: 'last', header: 'Last purchase', value: s => accounts.get(s.id)?.last ?? '',
      render: s => accounts.get(s.id)?.last ? fmtDate(accounts.get(s.id)?.last) : <span className="acct-muted">None yet</span> },
  ];

  const rowActions: RowAction<Supplier>[] = [
    { icon: <Eye size={15} />, label: 'Open account', onClick: setViewing },
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;
  const all = Array.from(accounts.values());
  const totalOwed = all.reduce((s, a) => s + a.owed, 0);
  const owingCount = all.filter(a => a.owed > 0).length;
  const creditTotal = all.reduce((s, a) => s + a.credit, 0);

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Suppliers</h1>
          <p>{rows ? `${rows.length} ${rows.length === 1 ? 'supplier' : 'suppliers'}` : ' '}</p>
        </div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Supplier</button>
      </div>

      {rows && rows.length > 0 && (
        <div className="stat-cards">
          <div className="stat-card">
            <div className="stat-label">You owe suppliers</div>
            <div className="stat-value" style={{ color: totalOwed > 0 ? '#dc2626' : undefined }}>{fmt(totalOwed)}</div>
            <div className="stat-sub">{owingCount > 0 ? `Unpaid purchases with ${owingCount} ${owingCount === 1 ? 'supplier' : 'suppliers'}. Tap Pay to settle.` : 'Every supplier is paid up'}</div>
          </div>
          <div className="stat-card">
            <div className="stat-label">Suppliers owe you</div>
            <div className="stat-value" style={{ color: creditTotal > 0 ? '#16a34a' : undefined }}>{fmt(creditTotal)}</div>
            <div className="stat-sub">From goods you returned after paying</div>
          </div>
        </div>
      )}

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={s => s.id}
        searchKeys={[s => s.company_store ?? '', s => personName(s), s => s.phone ?? '', s => s.email ?? '']}
        searchPlaceholder="Search name or phone…"
        exportName="suppliers"
        exportTitle="Suppliers"
        rowActions={rowActions}
        emptyMessage="No suppliers yet. Add the people and businesses you buy stock from, so you can see what you owe each one and pay them."
      />

      {viewing && (
        <SupplierAccountModal
          supplier={viewing}
          account={accounts.get(viewing.id) ?? emptyAccount}
          canPay={canPay}
          payTypes={payTypes}
          onClose={() => setViewing(null)}
          onEdit={() => { const s = viewing; setViewing(null); openEdit(s); }}
          onPaid={() => purchasesQ.refetch()}
        />
      )}

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Supplier' : 'Add Supplier'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <ErrorState message={formError} />}
                <div className="form-group">
                  <label htmlFor="sup-company">Business name</label>
                  <input id="sup-company" value={form.company_store} placeholder="e.g. Alaba Wholesale Depot"
                         onChange={e => setForm(f => ({ ...f, company_store: e.target.value }))} />
                </div>
                <div className="grid-2">
                  <div className="form-group"><label htmlFor="sup-first">Contact first name</label><input id="sup-first" value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} /></div>
                  <div className="form-group"><label htmlFor="sup-last">Contact last name</label><input id="sup-last" value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} /></div>
                </div>
                <p className="acct-note" style={{ marginTop: '-0.5rem', marginBottom: '1rem' }}>A business name or a contact person is enough.</p>
                <div className="grid-2">
                  <div className="form-group"><label htmlFor="sup-phone">Phone (WhatsApp)</label><input id="sup-phone" type="tel" inputMode="tel" value={form.phone} placeholder="e.g. 0803 000 0000" onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
                  <div className="form-group"><label htmlFor="sup-email">Email</label><input id="sup-email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
                </div>
                <div className="form-group"><label htmlFor="sup-address">Address</label><input id="sup-address" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></div>
                {schemaHasTerms && hasFeature(tenant, 'debt_tools') && (
                  <div className="form-group">
                    <label htmlFor="sup-terms">Days you have to pay them</label>
                    <input id="sup-terms" inputMode="numeric" value={form.payment_terms_days} placeholder="Your usual terms"
                           onChange={e => setForm(f => ({ ...f, payment_terms_days: e.target.value.replace(/[^\d]/g, '').slice(0, 3) }))} />
                    <small className="acct-note">For example 30. Each bill gets a due date, and Reports show which bills are late.</small>
                  </div>
                )}

                <h3 className="section-title">Their bank account</h3>
                <p className="acct-note" style={{ marginBottom: '0.75rem' }}>Where you send their money. Shown every time you pay them, so nobody has to dig through chats for it.</p>
                <div className="grid-2">
                  <div className="form-group"><label htmlFor="sup-bank">Bank</label><input id="sup-bank" value={form.bank_name} placeholder="e.g. GTBank" onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} /></div>
                  <div className="form-group"><label htmlFor="sup-acct">Account number</label><input id="sup-acct" inputMode="numeric" value={form.account_number} placeholder="10 digits" maxLength={14} onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} /></div>
                </div>
                <div className="form-group"><label htmlFor="sup-acctname">Account name</label><input id="sup-acctname" value={form.account_name} placeholder="As it appears on the account" onChange={e => setForm(f => ({ ...f, account_name: e.target.value }))} /></div>

                <CustomFieldsSection defs={customFieldDefsData} values={form.custom_fields}
                  onChange={cf => setForm(f => ({ ...f, custom_fields: cf }))} />
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={pending || !hasName}>
                  {pending ? 'Saving…' : editRow ? 'Update Supplier' : 'Save Supplier'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {deleteRow && (
        <ConfirmDialog
          title="Delete Supplier"
          message={<>Delete <strong>{supplierTitle(deleteRow)}</strong>? This cannot be undone.</>}
          confirmLabel="Delete"
          pending={removeMut.pending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteRow(null)}
        />
      )}
    </div>
  );
}

// One supplier's account: how much you owe, on which purchases, and where
// to send the money. "Pay" records the payment against that purchase.
function SupplierAccountModal({ supplier, account, canPay, payTypes, onClose, onEdit, onPaid }: {
  supplier: Supplier; account: Account; canPay: boolean; payTypes: Lookup[];
  onClose: () => void; onEdit: () => void; onPaid: () => void;
}) {
  const toast = useToast();
  const { profile, tenant } = useAuth();
  const debtTools = hasFeature(tenant, 'debt_tools');
  const [paying, setPaying] = useState<PurchaseOrder | null>(null);
  const [addingOpening, setAddingOpening] = useState(false);
  const name = supplierTitle(supplier);
  const open = [...account.open].sort((a, b) => a.purchase_date.localeCompare(b.purchase_date));
  const docNo = (p: PurchaseOrder) => p.doc_no ?? `#${p.id.slice(0, 8).toUpperCase()}`;
  const hasBankDetails = !!(supplier.account_number || supplier.bank_name);

  const copyAccount = async () => {
    const text = [supplier.bank_name, supplier.account_number, supplier.account_name].filter(Boolean).join('\n');
    try { await navigator.clipboard.writeText(text); toast.success('Bank details copied.'); }
    catch { toast.error('Could not copy.'); }
  };

  // After paying by transfer, let the supplier know it's on its way.
  const tellSupplier = () => {
    const lines = [
      `Hello ${personName(supplier) || name},`,
      '',
      `Our balance with you is ${fmt(account.owed)}${open.length > 0 ? ` across ${open.length} ${open.length === 1 ? 'delivery' : 'deliveries'}` : ''}.`,
      'We are arranging payment. Please confirm the account to pay into is correct:',
      ...(hasBankDetails ? ['', [supplier.bank_name, supplier.account_number, supplier.account_name].filter(Boolean).join(' · ')] : ['', '(please send your account details)']),
      '',
      'Thank you.',
    ];
    window.open(whatsappLink(supplier.phone, lines.join('\n')), '_blank');
  };

  return (
    <>
      <Modal onClose={onClose} maxWidth={640}>
        <div className="modal-header acct-modal-head">
          <div>
            <h2>{name}</h2>
            <div className="acct-contact">
              {personName(supplier) && personName(supplier) !== name && <span>{personName(supplier)}</span>}
              {supplier.phone ? <a href={`tel:${supplier.phone.replace(/\s+/g, '')}`}>{supplier.phone}</a> : <span>No phone saved</span>}
              {supplier.address && <span>{supplier.address}</span>}
            </div>
          </div>
          <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div className="modal-body">
          <dl className="acct-figures">
            <div className={account.owed > 0 ? 'is-owed' : ''}><dt>You owe them</dt><dd>{fmt(account.owed)}</dd></div>
            <div><dt>Bought from them</dt><dd>{fmt(account.bought)}</dd></div>
            <div className={account.credit > 0 ? 'is-credit' : ''}><dt>{account.credit > 0 ? 'They owe you' : 'Paid so far'}</dt><dd>{fmt(account.credit > 0 ? account.credit : account.paid)}</dd></div>
          </dl>

          <section className="acct-section">
            <h3>Pay into</h3>
            {hasBankDetails ? (
              <div className="acct-bank">
                <div className="acct-bank-lines">
                  {supplier.account_number && <span className="acct-bank-number">{supplier.account_number}</span>}
                  <span>{[supplier.bank_name, supplier.account_name].filter(Boolean).join(' · ')}</span>
                </div>
                <button type="button" className="btn-secondary btn-sm" onClick={copyAccount}><Copy size={13} /> Copy</button>
              </div>
            ) : (
              <div className="acct-bank-missing">
                No bank details saved for {name}. <button type="button" className="link-inline" onClick={onEdit}>Add their account</button> so it's here next time you pay.
              </div>
            )}
          </section>

          <div className="acct-actions">
            {supplier.phone && (
              <>
                <button type="button" className="btn-secondary" onClick={tellSupplier}><MessageCircle size={16} /> Message on WhatsApp</button>
                <a className="btn-secondary" href={`tel:${supplier.phone.replace(/\s+/g, '')}`}><Phone size={16} /> Call</a>
              </>
            )}
            <button type="button" className="btn-ghost" onClick={onEdit}><Pencil size={16} /> Edit details</button>
            {profile?.role === 'admin' && (
              debtTools && <button type="button" className="btn-ghost" onClick={() => setAddingOpening(true)}><History size={16} /> Owed before ProfixBook</button>
            )}
          </div>

          <section className="acct-section" style={{ marginBottom: 0 }}>
            <h3>Unpaid purchases</h3>
            {open.length === 0 ? (
              <div className="acct-empty">{account.count > 0 ? `You don't owe ${name} anything.` : `No purchases from ${name} yet.`}</div>
            ) : (
              <ul className="acct-list">
                {open.map(p => (
                  <li key={p.id}>
                    <div className="acct-list-main">
                      <span className="acct-list-title">
                        {docNo(p)}
                        {Number(p.opening_amount || 0) > 0 && <span className="acct-list-tag">owed before ProfixBook</span>}
                      </span>
                      <span className="acct-list-meta">
                        {fmtDate(p.purchase_date)}
                        {p.due_date && <> · <span className={dueText(p.due_date).late ? 'acct-late' : undefined}>{dueText(p.due_date).text}</span></>}
                        {p.total_paid > 0
                          ? ` · paid ${fmt(p.total_paid)} of ${fmt(p.total_amount + Number(p.opening_amount || 0))}`
                          : ` · ${fmt(p.total_amount + Number(p.opening_amount || 0))}, nothing paid yet`}
                      </span>
                    </div>
                    <span className="acct-list-amount acct-owed">{fmt(p.balance)}</span>
                    {canPay && (
                      <div className="acct-list-actions">
                        <button type="button" className="btn-primary btn-sm" onClick={() => setPaying(p)}><Wallet size={13} /> Pay</button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </Modal>

      {paying && (
        <PayModal
          purchase={paying}
          supplierName={name}
          payTypes={payTypes}
          onClose={() => setPaying(null)}
          onDone={() => { setPaying(null); onPaid(); }}
        />
      )}
      {addingOpening && (
        <OpeningDebtModal kind="supplier" partyId={supplier.id} partyName={name}
                          onClose={() => setAddingOpening(false)} onDone={() => { setAddingOpening(false); onPaid(); }} />
      )}
    </>
  );
}
