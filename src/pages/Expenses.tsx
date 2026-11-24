import React, { useState } from 'react';
import { Plus, X, Pencil, Ban } from 'lucide-react';
import { expenses as expensesApi, lookups, money as moneyApi, Expense, Lookup, MoneyAccount } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';
import Modal from '../components/Modal';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

const blankForm = () => ({
  expense_date: new Date().toISOString().split('T')[0],
  expense_type_id: '', description: '', amount: 0, payment_type_id: '', vat_amount: 0, money_account_id: '',
});

const SOURCE_LABEL: Record<string, string> = { till_pay_out: 'From the till', payment_fee: 'Automatic' };

export default function Expenses() {
  const toast = useToast();
  const { tenant } = useAuth();
  const { data: rows, loading, error, refetch } = useQuery<Expense[]>(() => expensesApi.list(), []);
  const { data: expTypes } = useQuery<Lookup[]>(() => lookups.expenseTypes(), []);
  const { data: payTypes } = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);
  // Which account paid (0061). Optional: the payment method decides otherwise.
  const { data: moneyAccounts } = useQuery<MoneyAccount[]>(() => moneyApi.accounts().catch(() => []), []);
  const createMut = useMutation(expensesApi.create);
  const updateMut = useMutation((id: string, e: Partial<Expense>) => expensesApi.update(id, e));
  const voidMut = useMutation(expensesApi.void);

  const [showModal, setShowModal] = useState(false);
  const [editRow, setEditRow] = useState<Expense | null>(null);
  const [voidRow, setVoidRow] = useState<Expense | null>(null);
  const [form, setForm] = useState(blankForm());

  // Default to this month: an all-time total only ever grows and tells the
  // owner nothing. "All time" is still one tap away.
  const thisMonth = new Date().toISOString().slice(0, 7);
  const [month, setMonth] = useState<string>(thisMonth);
  const months = Array.from(new Set([thisMonth, ...(rows ?? []).map(e => e.expense_date.slice(0, 7))])).sort().reverse();
  const shown = month === 'all' ? rows : (rows ?? []).filter(e => e.expense_date.startsWith(month));
  // Voided expenses stay on the list (crossed out) but never count.
  const shownTotal = (shown ?? []).filter(e => !e.voided).reduce((s, e) => s + Number(e.amount || 0), 0);
  // The VAT field is offered to VAT-registered businesses, or when editing
  // an expense that already has VAT on it.
  const showVat = !!tenant?.vat_enabled || Number(form.vat_amount) > 0;
  const monthLabel = (m: string) => new Date(m + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  const typeName = (id: string | null) => expTypes?.find(t => t.id === id)?.name ?? '—';
  const payName = (id: string | null) => payTypes?.find(t => t.id === id)?.name ?? '—';

  const openCreate = () => { setEditRow(null); setForm(blankForm()); setShowModal(true); };
  const openEdit = (x: Expense) => {
    setEditRow(x);
    setForm({
      expense_date: x.expense_date, expense_type_id: x.expense_type_id ?? '',
      description: x.description ?? '', amount: x.amount, payment_type_id: x.payment_type_id ?? '',
      vat_amount: Number(x.vat_amount ?? 0), money_account_id: x.money_account_id ?? '',
    });
    setShowModal(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.amount <= 0) { toast.error('Enter an amount greater than zero.'); return; }
    if (form.vat_amount < 0 || form.vat_amount > form.amount) { toast.error('The VAT has to be part of the amount, so it can\u2019t be more than it.'); return; }
    const payload = { ...form, vat_amount: Number(form.vat_amount) || 0, expense_type_id: form.expense_type_id || null, payment_type_id: form.payment_type_id || null,
      money_account_id: form.money_account_id || null };
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

  const handleVoid = async () => {
    if (!voidRow) return;
    const res = await voidMut.mutate(voidRow.id);
    if (res !== null) {
      toast.success('Expense voided. It stays on the list but no longer counts.');
      refetch();
    } else {
      toast.error(voidMut.error ?? 'Could not void that expense.');
    }
    setVoidRow(null);
  };

  const columns: Column<Expense>[] = [
    { key: 'expense_date', header: 'Date', value: e => e.expense_date },
    { key: 'type', header: 'Type', value: e => typeName(e.expense_type_id), render: e => <span className="badge-gray">{typeName(e.expense_type_id)}</span> },
    { key: 'description', header: 'Description', value: e => e.description ?? '',
      render: e => (
        <span className={e.voided ? 'strike' : undefined}>
          {e.description}
          {e.voided && <span className="badge-gray" style={{ marginLeft: 6 }}>Voided</span>}
          {!e.voided && e.source && SOURCE_LABEL[e.source] && <span className="badge-gray" style={{ marginLeft: 6 }}>{SOURCE_LABEL[e.source]}</span>}
        </span>
      ) },
    { key: 'amount', header: 'Amount', align: 'right', value: e => e.amount,
      render: e => (
        <span className={e.voided ? 'strike' : undefined}>
          <strong>{fmt(e.amount)}</strong>
          {Number(e.vat_amount) > 0 && <small style={{ display: 'block', color: '#64748b' }}>incl. VAT {fmt(Number(e.vat_amount))}</small>}
        </span>
      ) },
    { key: 'payment', header: 'Payment', value: e => payName(e.payment_type_id) },
  ];

  const rowActions: RowAction<Expense>[] = [
    { icon: <Pencil size={15} />, label: 'Edit', onClick: openEdit, show: e => !e.voided },
    { icon: <Ban size={15} />, label: 'Void', onClick: setVoidRow, variant: 'danger', show: e => !e.voided },
  ];

  const pending = createMut.pending || updateMut.pending;
  const formError = editRow ? updateMut.error : createMut.error;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Expenses</h1>
          <p>{month === 'all' ? `${fmt(shownTotal)} spent in total` : `${fmt(shownTotal)} spent in ${monthLabel(month)}`}</p>
        </div>
        <button className="btn-primary" onClick={openCreate}><Plus size={16} /> Log Expense</button>
      </div>

      <DataTable
        columns={columns}
        rows={rows ? shown ?? [] : null}
        loading={loading}
        toolbarExtra={
          <select className="input-sm" value={month} onChange={e => setMonth(e.target.value)} aria-label="Show expenses for">
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            <option value="all">All time</option>
          </select>
        }
        error={error}
        onRetry={refetch}
        getRowKey={e => e.id}
        searchKeys={[e => e.description ?? '', e => typeName(e.expense_type_id)]}
        searchPlaceholder="Search expenses…"
        exportName="expenses"
        exportTitle="Expenses"
        rowActions={rowActions}
        emptyMessage={month === 'all' || (rows ?? []).length === 0
          ? 'No expenses yet. Log rent, fuel, salaries and other running costs here so your profit report shows what you really made.'
          : `No expenses logged in ${monthLabel(month)}.`}
      />

      {showModal && (
        <Modal onClose={() => setShowModal(false)}>
            <div className="modal-header">
              <h2>{editRow ? 'Edit Expense' : 'Log Expense'}</h2>
              <button className="close-btn" onClick={() => setShowModal(false)} aria-label="Close"><X size={18} /></button>
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
                  <div className="form-group"><label>Amount paid (₦)</label><NumberInput value={form.amount} onChange={v => setForm(f => ({ ...f, amount: v }))} required /></div>
                  <div className="form-group">
                    <label>Payment Method</label>
                    <select value={form.payment_type_id} onChange={e => setForm(f => ({ ...f, payment_type_id: e.target.value }))}>
                      <option value="">— select —</option>
                      {payTypes?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                </div>
                {(moneyAccounts ?? []).length > 0 && (
                  <div className="form-group">
                    <label htmlFor="exp-from">Paid from</label>
                    <select id="exp-from" value={form.money_account_id} onChange={e => setForm(f => ({ ...f, money_account_id: e.target.value }))}>
                      <option value="">Based on the payment method</option>
                      {(moneyAccounts ?? []).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                )}
                {showVat && (
                  <div className="form-group">
                    <label htmlFor="exp-vat">VAT included in that amount (₦)</label>
                    <NumberInput id="exp-vat" value={form.vat_amount} onChange={v => setForm(f => ({ ...f, vat_amount: v }))} />
                    <small style={{ color: '#64748b', fontSize: '0.75rem' }}>
                      Only if the receipt shows VAT you can claim back. Leave it at 0 otherwise.
                    </small>
                  </div>
                )}
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

      {voidRow && (
        <ConfirmDialog
          title="Void expense"
          message={<>Void this {fmt(voidRow.amount)} expense ({voidRow.description || typeName(voidRow.expense_type_id)})? It stays on the list, crossed out, and stops counting in your profit. A void can't be undone.</>}
          confirmLabel="Void expense"
          pending={voidMut.pending}
          onConfirm={handleVoid}
          onCancel={() => setVoidRow(null)}
        />
      )}
    </div>
  );
}
