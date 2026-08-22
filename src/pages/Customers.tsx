import React, { useState } from 'react';
import { Plus, X, Pencil, Trash2 } from 'lucide-react';
import { customers as customersApi, lookups, Customer } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import OfflineBanner from '../components/OfflineBanner';
import Modal from '../components/Modal';

const emptyForm = { first_name: '', last_name: '', company_store: '', address: '', phone: '', customer_type_id: '' };

export default function Customers() {
  const toast = useToast();
  const { data: rows, loading, error, refetch, isOffline } = useQuery<Customer[]>(() => customersApi.list(), [], { cacheKey: 'customers-list' });
  const { data: types } = useQuery(() => lookups.customerTypes(), []);
  const createMut = useMutation(customersApi.create);
  const updateMut = useMutation((id: string, c: Partial<Customer>) => customersApi.update(id, c));
  const removeMut = useMutation(customersApi.remove);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Customer | null>(null);
  const [deleteRow, setDeleteRow] = useState<Customer | null>(null);
  const [form, setForm] = useState(emptyForm);

  const typeName = (id: string | null) => types?.find(t => t.id === id)?.name ?? '—';
  const fullName = (c: Customer) => `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim();

  const openCreate = () => { setEditRow(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (c: Customer) => {
    setEditRow(c);
    setForm({
      first_name: c.first_name ?? '', last_name: c.last_name ?? '', company_store: c.company_store ?? '',
      address: c.address ?? '', phone: c.phone ?? '', customer_type_id: c.customer_type_id ?? '',
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = { ...form, customer_type_id: form.customer_type_id || null };
    const res = editRow
      ? await updateMut.mutate(editRow.id, payload)
      : await createMut.mutate(payload);
    if (res) {
      toast.success(editRow ? 'Customer updated.' : 'Customer added.');
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
        ? 'Cannot delete — this customer has sales linked to them.'
        : msg || 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const columns: Column<Customer>[] = [
    { key: 'name', header: 'Name', value: fullName, render: c => <strong>{fullName(c)}</strong> },
    { key: 'company_store', header: 'Company / Store', value: c => c.company_store ?? '' },
    { key: 'phone', header: 'Phone', value: c => c.phone ?? '' },
    { key: 'address', header: 'Address', value: c => c.address ?? '' },
    { key: 'type', header: 'Type', value: c => typeName(c.customer_type_id),
      render: c => <span className={typeName(c.customer_type_id) === 'Corporate' ? 'badge-primary' : 'badge-gray'}>{typeName(c.customer_type_id)}</span> },
  ];

  const rowActions: RowAction<Customer>[] = [
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Customers</h1><p>{rows ? `${rows.length} customers` : ' '}</p></div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Customer</button>
      </div>

      {isOffline && <OfflineBanner label="customer list" />}
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={c => c.id}
        searchKeys={[c => fullName(c), c => c.company_store ?? '', c => c.phone ?? '']}
        searchPlaceholder="Search customers…"
        exportName="customers"
        exportTitle="Customers"
        rowActions={rowActions}
        emptyMessage="No customers yet. Add your first one."
      />

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Customer' : 'Add Customer'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <ErrorState message={formError} />}
                <div className="grid-2">
                  <div className="form-group"><label>First Name</label><input value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} required /></div>
                  <div className="form-group"><label>Last Name</label><input value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} /></div>
                </div>
                <div className="form-group"><label>Company / Store</label><input value={form.company_store} onChange={e => setForm(f => ({ ...f, company_store: e.target.value }))} /></div>
                <div className="grid-2">
                  <div className="form-group"><label>Phone</label><input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
                  <div className="form-group">
                    <label>Customer Type</label>
                    <select value={form.customer_type_id} onChange={e => setForm(f => ({ ...f, customer_type_id: e.target.value }))}>
                      <option value="">— select —</option>
                      {types?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="form-group"><label>Address</label><input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={pending}>
                  {pending ? 'Saving…' : editRow ? 'Update Customer' : 'Save Customer'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {deleteRow && (
        <ConfirmDialog
          title="Delete Customer"
          message={<>Delete <strong>{fullName(deleteRow) || deleteRow.company_store}</strong>? This cannot be undone.</>}
          confirmLabel="Delete"
          pending={removeMut.pending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteRow(null)}
        />
      )}
    </div>
  );
}
