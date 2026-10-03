import React, { useMemo, useState } from 'react';
import { Plus, X, Pencil, Trash2 } from 'lucide-react';
import { suppliers as suppliersApi, purchases as purchasesApi, customFieldDefs, Supplier, CustomFieldDef, PurchaseOrder } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { personName, supplierTitle } from '../lib/supplierName';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import CustomFieldsSection from '../components/CustomFieldsSection';
import Modal from '../components/Modal';
import './Purchases.scss';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });
const emptyForm = { first_name: '', last_name: '', company_store: '', address: '', email: '', phone: '', custom_fields: {} as Record<string, any> };

export default function Suppliers() {
  const toast = useToast();
  const { data: rows, loading, error, refetch } = useQuery<Supplier[]>(() => suppliersApi.list(), []);
  // What's still owed per supplier. Purchases are readable by every role
  // that can open this page; a failure just leaves the column blank.
  const { data: purchases } = useQuery<PurchaseOrder[]>(() => purchasesApi.list().catch(() => []), []);
  const { data: customFieldDefsData } = useQuery<CustomFieldDef[]>(() => customFieldDefs.forEntity('supplier').catch(() => []), []);
  const createMut = useMutation(suppliersApi.create);
  const updateMut = useMutation((id: string, s: Partial<Supplier>) => suppliersApi.update(id, s));
  const removeMut = useMutation(suppliersApi.remove);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Supplier | null>(null);
  const [deleteRow, setDeleteRow] = useState<Supplier | null>(null);
  const [form, setForm] = useState(emptyForm);

  const owedBy = useMemo(() => {
    const m = new Map<string, { owed: number; count: number; last: string | null }>();
    for (const p of purchases ?? []) {
      if (!p.supplier_id || p.voided) continue;
      const e = m.get(p.supplier_id) ?? { owed: 0, count: 0, last: null };
      e.owed += p.balance;
      e.count += 1;
      if (!e.last || p.purchase_date > e.last) e.last = p.purchase_date;
      m.set(p.supplier_id, e);
    }
    return m;
  }, [purchases]);

  const openCreate = () => { setEditRow(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (s: Supplier) => {
    setEditRow(s);
    setForm({
      first_name: s.first_name ?? '', last_name: s.last_name ?? '', company_store: s.company_store ?? '',
      address: s.address ?? '', email: s.email ?? '', phone: s.phone ?? '', custom_fields: s.custom_fields ?? {},
    });
    setShowModal(true);
  };

  // The custom_fields column exists once migration 0032 has run; until
  // then, don't send it (Postgres would reject the whole save).
  const schemaHasCustomFields = (rows ?? []).some(r => 'custom_fields' in r);
  // A supplier is often just a business, so either name will do.
  const hasName = !!(form.company_store.trim() || form.first_name.trim() || form.last_name.trim());

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hasName) { toast.error('Enter a business name or a contact person.'); return; }
    const { custom_fields, ...rest } = form;
    const trimmed = Object.fromEntries(Object.entries(rest).map(([k, v]) => [k, v.trim() || null]));
    const payload = { ...trimmed, ...(schemaHasCustomFields || Object.keys(custom_fields).length > 0 ? { custom_fields } : {}) };
    const res = editRow ? await updateMut.mutate(editRow.id, payload) : await createMut.mutate(payload);
    if (res) {
      toast.success(editRow ? 'Supplier updated.' : `${supplierTitle(res)} added.`);
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
          <div className="pur-supplier-name">
            <strong>{title}</strong>
            {person && person !== title && <span>{person}</span>}
          </div>
        );
      } },
    { key: 'phone', header: 'Phone', value: s => s.phone ?? '',
      render: s => s.phone ? <a className="pur-tel" href={`tel:${s.phone.replace(/\s+/g, '')}`}>{s.phone}</a> : <span className="pur-muted">None</span> },
    { key: 'purchases', header: 'Purchases', align: 'right', value: s => owedBy.get(s.id)?.count ?? 0,
      render: s => <span className="pur-num">{owedBy.get(s.id)?.count ?? 0}</span> },
    { key: 'owed', header: 'You owe', align: 'right', value: s => owedBy.get(s.id)?.owed ?? 0,
      render: s => {
        const owed = owedBy.get(s.id)?.owed ?? 0;
        if (owed > 0) return <span className="pur-owed">{fmt(owed)}</span>;
        if (owed < 0) return <span className="pur-credit">Owes you {fmt(-owed)}</span>;
        return <span className="pur-num pur-muted">{fmt(0)}</span>;
      } },
    { key: 'email', header: 'Email', value: s => s.email ?? '' },
    { key: 'address', header: 'Address', value: s => s.address ?? '' },
  ];

  const rowActions: RowAction<Supplier>[] = [
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;
  const totalOwed = Array.from(owedBy.values()).reduce((s, e) => s + Math.max(0, e.owed), 0);
  const owingCount = Array.from(owedBy.values()).filter(e => e.owed > 0).length;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Suppliers</h1>
          <p>
            {rows ? `${rows.length} ${rows.length === 1 ? 'supplier' : 'suppliers'}` : ' '}
            {rows && totalOwed > 0 && ` · you owe ${fmt(totalOwed)} to ${owingCount} ${owingCount === 1 ? 'supplier' : 'suppliers'}`}
          </p>
        </div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Supplier</button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={s => s.id}
        searchKeys={[s => s.company_store ?? '', s => personName(s), s => s.phone ?? '', s => s.email ?? '']}
        searchPlaceholder="Search by name, business or phone…"
        exportName="suppliers"
        exportTitle="Suppliers"
        rowActions={rowActions}
        emptyMessage="No suppliers yet. Add the people and businesses you buy stock from, so you can see what you owe each one."
      />

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
                <p className="pur-field-hint" style={{ marginTop: '-0.5rem', marginBottom: '1rem' }}>A business name or a contact person is enough.</p>
                <div className="grid-2">
                  <div className="form-group"><label htmlFor="sup-phone">Phone</label><input id="sup-phone" type="tel" inputMode="tel" value={form.phone} placeholder="e.g. 0803 000 0000" onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
                  <div className="form-group"><label htmlFor="sup-email">Email</label><input id="sup-email" type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
                </div>
                <div className="form-group"><label htmlFor="sup-address">Address</label><input id="sup-address" value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></div>
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
