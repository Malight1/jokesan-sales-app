import React, { useState } from 'react';
import { Plus, X, Pencil, Trash2 } from 'lucide-react';
import { expenses as expensesApi, lookups, Expense, Lookup } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';
import Modal from '../components/Modal';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const blankForm = () => ({
  expense_date: new Date().toISOString().split('T')[0],
  expense_type_id: '', description: '', amount: 0, payment_type_id: '',
});

export default function Expenses() {
  const toast = useToast();
  const { data: rows, loading, error, refetch } = useQuery<Expense[]>(() => expensesApi.list(), []);
  const { data: expTypes } = useQuery<Lookup[]>(() => lookups.expenseTypes(), []);
  const { data: payTypes } = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);
  const createMut = useMutation(expensesApi.create);
  const updateMut = useMutation((id: string, e: Partial<Expense>) => expensesApi.update(id, e));
  const removeMut = useMutation(expensesApi.remove);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Expense | null>(null);
  const [deleteRow, setDeleteRow] = useState<Expense | null>(null);
  const [form, setForm] = useState(blankForm());

  const total = (rows ?? []).reduce((s, e) => s + e.amount, 0);
  const typeName = (id: string | null) => expTypes?.find(t => t.id === id)?.name ?? '—';
  const payName = (id: string | null) => payTypes?.find(t => t.id === id)?.name ?? '—';

  const openCreate = () => { setEditRow(null); setForm(blankForm()); setShowModal(true); };
  const openEdit = (x: Expense) => {
    setEditRow(x);
    setForm({
      expense_date: x.expense_date, expense_type_id: x.expense_type_id ?? '',
      description: x.description ?? '', amount: x.amount, payment_type_id: x.payment_type_id ?? '',
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.amount <= 0) { toast.error('Enter an amount greater than zero.'); return; }
    const payload = { ...form, expense_type_id: form.expense_type_id || null, payment_type_id: form.payment_type_id || null };
    const res = editRow ? await updateMut.mutate(editRow.id, payload) : await createMut.mutate(payload);
    if (res) {
      toast.success(editRow ? 'Expense updated.' : 'Expense logged.');
      setShowModal(false);
      setForm(blankForm());
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
      toast.success('Expense deleted.');
      setDeleteRow(null);
      refetch();
    } else {
      toast.error(removeMut.error ?? 'Delete failed.');
      setDeleteRow(null);
    }
  };

  const columns: Column<Expense>[] = [
    { key: 'expense_date', header: 'Date', value: e => e.expense_date },
    { key: 'type', header: 'Type', value: e => typeName(e.expense_type_id), render: e => <span className="badge-gray">{typeName(e.expense_type_id)}</span> },
    { key: 'description', header: 'Description', value: e => e.description ?? '' },
    { key: 'amount', header: 'Amount', align: 'right', value: e => e.amount, render: e => <strong>{fmt(e.amount)}</strong> },
    { key: 'payment', header: 'Payment', value: e => payName(e.payment_type_id) },
  ];

  const rowActions: RowAction<Expense>[] = [
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit },
    { icon: <Trash2 size={15} />, label: 'Delete', onClick: setDeleteRow, variant: 'danger' },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Expenses</h1><p>Total: {fmt(total)}</p></div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Log Expense</button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={e => e.id}
        searchKeys={[e => e.description ?? '', e => typeName(e.expense_type_id)]}
        searchPlaceholder="Search expenses…"
        exportName="expenses"
        exportTitle="Expenses"
        rowActions={rowActions}
        emptyMessage="No expenses logged yet."
      />

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Expense' : 'Log Expense'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {formError && <ErrorState message={formError} />}
                <div className="grid-2">
                  <div className="form-group">
                    <label>Date</label>
                    <input type="date" value={form.expense_date} onChange={e => setForm(f => ({ ...f, expense_date: e.target.value }))} required />
                  </div>
                  <div className="form-group">
                    <label>Type</label>
                    <select value={form.expense_type_id} onChange={e => setForm(f => ({ ...f, expense_type_id: e.target.value }))}>
                      <option value="">— select —</option>
                      {expTypes?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="form-group"><label>Description</label><input value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} /></div>
                <div className="grid-2">
                  <div className="form-group"><label>Amount (₦)</label><NumberInput value={form.amount} onChange={v => setForm(f => ({ ...f, amount: v }))} required /></div>
                  <div className="form-group">
                    <label>Payment Method</label>
                    <select value={form.payment_type_id} onChange={e => setForm(f => ({ ...f, payment_type_id: e.target.value }))}>
                      <option value="">— select —</option>
                      {payTypes?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={pending}>
                  {pending ? 'Saving…' : editRow ? 'Update Expense' : 'Save Expense'}
                </button>
              </div>
            </form>
        </Modal>
      )}

      {deleteRow && (
        <ConfirmDialog
          title="Delete Expense"
          message={<>Delete this {fmt(deleteRow.amount)} expense ({deleteRow.description || typeName(deleteRow.expense_type_id)})? This cannot be undone.</>}
          confirmLabel="Delete"
          pending={removeMut.pending}
          onConfirm={handleDelete}
          onCancel={() => setDeleteRow(null)}
        />
      )}
    </div>
  );
}
