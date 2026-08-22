import React, { useState } from 'react';
import { Plus, X, Pencil, Trash2 } from 'lucide-react';
import { suppliers as suppliersApi, Supplier } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import Modal from '../components/Modal';

const emptyForm = { first_name: '', last_name: '', company_store: '', address: '', email: '', phone: '' };

export default function Suppliers() {
  const toast = useToast();
  const { data: rows, loading, error, refetch } = useQuery<Supplier[]>(() => suppliersApi.list(), []);
  const createMut = useMutation(suppliersApi.create);
  const updateMut = useMutation((id: string, s: Partial<Supplier>) => suppliersApi.update(id, s));
  const removeMut = useMutation(suppliersApi.remove);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Supplier | null>(null);
  const [deleteRow, setDeleteRow] = useState<Supplier | null>(null);
  const [form, setForm] = useState(emptyForm);

  const fullName = (s: Supplier) => `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim();

  const openCreate = () => { setEditRow(null); setForm(emptyForm); setShowModal(true); };
  const openEdit = (s: Supplier) => {
    setEditRow(s);
    setForm({
      first_name: s.first_name ?? '', last_name: s.last_name ?? '', company_store: s.company_store ?? '',
      address: s.address ?? '', email: s.email ?? '', phone: s.phone ?? '',
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = editRow ? await updateMut.mutate(editRow.id, form) : await createMut.mutate(form);
    if (res) {
      toast.success(editRow ? 'Supplier updated.' : 'Supplier added.');
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
        ? 'Cannot delete — this supplier has purchases linked to them.'
        : msg || 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const columns: Column<Supplier>[] = [
    { key: 'name', header: 'Name', value: fullName, render: s => <strong>{fullName(s)}</strong> },
    { key: 'company_store', header: 'Company', value: s => s.company_store ?? '' },
    { key: 'phone', header: 'Phone', value: s => s.phone ?? '' },
    { key: 'email', header: 'Email', value: s => s.email ?? '' },
    { key: 'address', header: 'Address', value: s => s.address ?? '' },
  ];

  const rowActions: RowAction<Supplier>[] = [
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Suppliers</h1><p>{rows ? `${rows.length} suppliers` : ' '}</p></div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Add Supplier</button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={s => s.id}
        searchKeys={[s => fullName(s), s => s.company_store ?? '', s => s.phone ?? '']}
        searchPlaceholder="Search suppliers…"
        exportName="suppliers"
        exportTitle="Suppliers"
        rowActions={rowActions}
        emptyMessage="No suppliers yet. Add your first one."
      />

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Supplier' : 'Add Supplier'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <ErrorState message={formError} />}
                <div className="grid-2">
                  <div className="form-group"><label>First Name</label><input value={form.first_name} onChange={e => setForm(f => ({ ...f, first_name: e.target.value }))} required /></div>
                  <div className="form-group"><label>Last Name</label><input value={form.last_name} onChange={e => setForm(f => ({ ...f, last_name: e.target.value }))} /></div>
                </div>
                <div className="form-group"><label>Company</label><input value={form.company_store} onChange={e => setForm(f => ({ ...f, company_store: e.target.value }))} /></div>
                <div className="form-group"><label>Address</label><input value={form.address} onChange={e => setForm(f => ({ ...f, address: e.target.value }))} /></div>
                <div className="grid-2">
                  <div className="form-group"><label>Email</label><input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} /></div>
                  <div className="form-group"><label>Phone</label><input value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} /></div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={pending}>
                  {pending ? 'Saving…' : editRow ? 'Update Supplier' : 'Save Supplier'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {deleteRow && (
        <ConfirmDialog
          title="Delete Supplier"
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
