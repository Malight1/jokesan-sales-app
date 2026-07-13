import React, { useState } from 'react';
import { Plus, X, Eye, Wallet, Ban } from 'lucide-react';
import { purchases as purchasesApi, suppliers as suppliersApi, materials as materialsApi, lookups, PurchaseOrder, Supplier, Material, Lookup } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from '../components/DataStates';
import DataTable, { Column, RowAction } from '../components/DataTable';
import ConfirmDialog from '../components/ConfirmDialog';
import NumberInput from '../components/NumberInput';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

const statusMap: Record<string, { label: string; cls: string }> = {
  full: { label: 'Full Payment', cls: 'badge-success' },
  part: { label: 'Part Payment', cls: 'badge-warning' },
  unpaid: { label: 'Unpaid', cls: 'badge-danger' },
};

interface LineItem { material_id: string; qty: number; cost_price: number; }

export default function Purchases() {
  const toast = useToast();
  const { data: rows, loading, error, refetch } = useQuery<PurchaseOrder[]>(() => purchasesApi.list(), []);
  const { data: suppliers } = useQuery<Supplier[]>(() => suppliersApi.list(), []);
  const { data: materials } = useQuery<Material[]>(() => materialsApi.list(), []);
  const { data: payTypes } = useQuery<Lookup[]>(() => lookups.paymentTypes(), []);

  const createMut = useMutation(purchasesApi.create);
  const payMut = useMutation(purchasesApi.addPayment);
  const voidMut = useMutation(purchasesApi.void);

  const [showModal, setShowModal] = useState(false);
  const [viewId, setViewId] = useState<string | null>(null);
  const [voidFor, setVoidFor] = useState<PurchaseOrder | null>(null);
  const [payFor, setPayFor] = useState<PurchaseOrder | null>(null);
  const [payAmount, setPayAmount] = useState(0);
  const [payType, setPayType] = useState('');

  const blankItem = (): LineItem => ({ material_id: '', qty: 1, cost_price: 0 });
  const [form, setForm] = useState({
    supplierId: '', date: new Date().toISOString().split('T')[0], paymentTypeId: '', amountPaid: 0,
    items: [blankItem()],
  });

  const supplierName = (id: string | null) => {
    const s = suppliers?.find(x => x.id === id);
    return s ? `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() || s.company_store || 'Unknown' : '—';
  };

  const total = form.items.reduce((s, i) => s + i.qty * i.cost_price, 0);

  const addItem = () => setForm(f => ({ ...f, items: [...f.items, blankItem()] }));
  const removeItem = (idx: number) => setForm(f => ({ ...f, items: f.items.filter((_, i) => i !== idx) }));
  const updateItem = (idx: number, field: keyof LineItem, value: any) =>
    setForm(f => { const items = [...f.items]; (items[idx] as any)[field] = value; return { ...f, items }; });

  const resetForm = () => setForm({
    supplierId: '', date: new Date().toISOString().split('T')[0], paymentTypeId: '', amountPaid: 0, items: [blankItem()],
  });

  const validItems = form.items.filter(i => i.material_id && i.qty > 0 && i.cost_price >= 0);
  const canSubmit = validItems.length > 0 && total > 0;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) { toast.error('Add at least one material with quantity and cost.'); return; }
    const res = await createMut.mutate({
      supplierId: form.supplierId || null,
      date: form.date,
      paymentTypeId: form.paymentTypeId || null,
      amountPaid: Number(form.amountPaid) || 0,
      items: validItems.map(i => ({ material_id: i.material_id, qty: Number(i.qty), cost_price: Number(i.cost_price) })),
    });
    if (res) {
      toast.success('Purchase recorded — material stock updated.');
      setShowModal(false);
      resetForm();
      refetch();
    } else if (createMut.error) {
      toast.error(createMut.error);
    }
  };

  const openPay = (po: PurchaseOrder) => {
    setPayFor(po);
    setPayAmount(po.balance);
    setPayType(payTypes?.[0]?.id ?? '');
  };

  const submitPayment = async () => {
    if (!payFor) return;
    if (payAmount <= 0) { toast.error('Enter a payment amount.'); return; }
    const ok = await payMut.mutate(payFor.id, Number(payAmount), payType || null);
    if (ok !== null) {
      toast.success('Payment recorded.');
      setPayFor(null);
      refetch();
    } else if (payMut.error) {
      toast.error(payMut.error);
    }
  };

  const handleVoid = async () => {
    if (!voidFor) return;
    const res = await voidMut.mutate(voidFor.id);
    if (res !== null) {
      toast.success('Purchase voided — material stock reversed.');
      setVoidFor(null);
      refetch();
    } else {
      toast.error(voidMut.error ?? 'Void failed.');
      setVoidFor(null);
    }
  };

  const columns: Column<PurchaseOrder>[] = [
    { key: 'purchase_date', header: 'Date', value: p => p.purchase_date },
    { key: 'supplier', header: 'Supplier', value: p => supplierName(p.supplier_id) },
    { key: 'total_amount', header: 'Total', align: 'right', value: p => p.total_amount, render: p => fmt(p.total_amount) },
    { key: 'total_paid', header: 'Paid', align: 'right', value: p => p.total_paid, render: p => fmt(p.total_paid) },
    { key: 'balance', header: 'Balance', align: 'right', value: p => p.balance,
      render: p => <span style={{ color: p.balance > 0 ? '#dc2626' : 'inherit', fontWeight: p.balance > 0 ? 600 : 400 }}>{fmt(p.balance)}</span> },
    { key: 'payment_status', header: 'Status', value: p => p.voided ? 'Voided' : (statusMap[p.payment_status]?.label ?? p.payment_status),
      render: p => p.voided
        ? <span className="badge-gray" style={{ textDecoration: 'line-through' }}>Voided</span>
        : <span className={statusMap[p.payment_status]?.cls ?? 'badge-gray'}>{statusMap[p.payment_status]?.label ?? p.payment_status}</span> },
  ];

  const rowActions: RowAction<PurchaseOrder>[] = [
    { icon: <Wallet size={15} />, label: 'Record payment', onClick: openPay, show: p => p.balance > 0 && !p.voided },
    { icon: <Eye size={15} />, label: 'View', onClick: p => setViewId(p.id) },
    { icon: <Ban size={15} />, label: 'Void purchase', onClick: setVoidFor, show: p => !p.voided, variant: 'danger' },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Purchases</h1>
          <p>{rows ? `${rows.length} purchase orders` : ' '}</p>
        </div>
        <button className="btn-primary" onClick={() => { resetForm(); setShowModal(true); }}><Plus size={16} /> New Purchase</button>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={p => p.id}
        searchKeys={[p => supplierName(p.supplier_id), p => p.purchase_date]}
        searchPlaceholder="Search by supplier…"
        exportName="purchases"
        exportTitle="Purchase Orders"
        rowActions={rowActions}
        emptyMessage="No purchases yet. Record your first purchase to add stock."
      />

      {/* New Purchase Modal */}
      {showModal && (
        <div className="modal-overlay" onClick={() => setShowModal(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <div className="modal-header">
              <h2>New Purchase Order</h2>
              <button className="close-btn" onClick={() => setShowModal(false)}><X size={18} /></button>
            </div>
            <form onSubmit={handleSubmit}>
              <div className="modal-body">
                {createMut.error && <ErrorState message={createMut.error} />}
                <div className="grid-2">
                  <div className="form-group">
                    <label>Supplier</label>
                    <select value={form.supplierId} onChange={e => setForm(f => ({ ...f, supplierId: e.target.value }))}>
                      <option value="">— select —</option>
                      {suppliers?.map(s => <option key={s.id} value={s.id}>{s.first_name} {s.last_name} — {s.company_store}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Date</label>
                    <input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} required />
                  </div>
                </div>

                <p style={{ fontSize: '0.875rem', fontWeight: 600, color: '#475569', marginBottom: '0.5rem' }}>Items</p>
                {form.items.map((item, idx) => (
                  <div key={idx} style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1.2fr auto', gap: '0.5rem', alignItems: 'flex-end', marginBottom: '0.5rem' }}>
                    <div className="form-group">
                      <label>Material</label>
                      <select value={item.material_id} onChange={e => updateItem(idx, 'material_id', e.target.value)}>
                        <option value="">— select —</option>
                        {materials?.map(m => <option key={m.id} value={m.id}>{m.name}{m.unit ? ` (${m.unit})` : ''}</option>)}
                      </select>
                    </div>
                    <div className="form-group">
                      <label>Qty</label>
                      <NumberInput value={item.qty} onChange={v => updateItem(idx, 'qty', v)} />
                    </div>
                    <div className="form-group">
                      <label>Unit Cost (₦)</label>
                      <NumberInput value={item.cost_price} onChange={v => updateItem(idx, 'cost_price', v)} />
                    </div>
                    {form.items.length > 1 && (
                      <button type="button" onClick={() => removeItem(idx)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#dc2626', padding: '0.5rem', marginBottom: '1rem' }}><X size={14} /></button>
                    )}
                  </div>
                ))}
                <button type="button" className="btn-ghost btn-sm" onClick={addItem} style={{ marginBottom: '1rem' }}><Plus size={14} /> Add item</button>

                <div style={{ textAlign: 'right', fontWeight: 700, paddingBottom: '1rem', borderBottom: '1px solid #e2e8f0', marginBottom: '1rem' }}>
                  Total: {fmt(total)}
                </div>

                <div className="grid-2">
                  <div className="form-group">
                    <label>Payment Type</label>
                    <select value={form.paymentTypeId} onChange={e => setForm(f => ({ ...f, paymentTypeId: e.target.value }))}>
                      <option value="">— select —</option>
                      {payTypes?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div className="form-group">
                    <label>Amount Paid (₦)</label>
                    <NumberInput value={form.amountPaid} onChange={v => setForm(f => ({ ...f, amountPaid: v }))} />
                  </div>
                </div>
              </div>
              <div className="modal-footer">
                <button type="button" className="btn-secondary" onClick={() => setShowModal(false)}>Cancel</button>
                <button type="submit" className="btn-primary" disabled={createMut.pending || !canSubmit}>
                  {createMut.pending ? 'Saving…' : 'Save Purchase'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Record Payment Modal */}
      {payFor && (
        <div className="modal-overlay" onClick={() => setPayFor(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 380 }}>
            <div className="modal-header">
              <h2>Record Payment</h2>
              <button className="close-btn" onClick={() => setPayFor(null)}><X size={18} /></button>
            </div>
            <div className="modal-body">
              {payMut.error && <ErrorState message={payMut.error} />}
              <p style={{ fontSize: '0.85rem', color: '#64748b', marginBottom: '1rem' }}>
                Outstanding balance: <strong style={{ color: '#dc2626' }}>{fmt(payFor.balance)}</strong>
              </p>
              <div className="form-group">
                <label>Amount (₦)</label>
                <NumberInput value={payAmount} onChange={setPayAmount} />
              </div>
              <div className="form-group">
                <label>Payment Type</label>
                <select value={payType} onChange={e => setPayType(e.target.value)}>
                  <option value="">— select —</option>
                  {payTypes?.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
            </div>
            <div className="modal-footer">
              <button type="button" className="btn-secondary" onClick={() => setPayFor(null)}>Cancel</button>
              <button type="button" className="btn-primary" disabled={payMut.pending} onClick={submitPayment}>
                {payMut.pending ? 'Saving…' : 'Record Payment'}
              </button>
            </div>
          </div>
        </div>
      )}

      {viewId && (
        <PurchaseDetail
          id={viewId}
          onClose={() => setViewId(null)}
          supplierName={supplierName}
          materialName={(id: string) => materials?.find(m => m.id === id)?.name ?? '—'}
        />
      )}

      {voidFor && (
        <ConfirmDialog
          title="Void Purchase"
          message={<>Void this {fmt(voidFor.total_amount)} purchase from <strong>{supplierName(voidFor.supplier_id)}</strong>? The received materials will be removed from stock. This is only possible if none of them have been used in production.</>}
          confirmLabel="Void Purchase"
          pending={voidMut.pending}
          onConfirm={handleVoid}
          onCancel={() => setVoidFor(null)}
        />
      )}
    </div>
  );
}

// ---- Purchase detail (fetches items + payments) ----
function PurchaseDetail({ id, onClose, supplierName, materialName }: {
  id: string; onClose: () => void;
  supplierName: (id: string | null) => string;
  materialName: (id: string) => string;
}) {
  const { data, loading, error } = useQuery<any>(() => purchasesApi.detail(id), [id]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Purchase Detail</h2>
          <button className="close-btn" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">
          {loading && <Loading />}
          {error && <ErrorState message={error} />}
          {data && (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '1rem', fontSize: '0.85rem' }}>
                <div><span style={{ color: '#94a3b8' }}>Date</span><br /><strong>{data.purchase_date}</strong></div>
                <div><span style={{ color: '#94a3b8' }}>Supplier</span><br /><strong>{supplierName(data.supplier_id)}</strong></div>
                <div><span style={{ color: '#94a3b8' }}>Total</span><br /><strong>{fmt(data.total_amount)}</strong></div>
                <div><span style={{ color: '#94a3b8' }}>Balance</span><br /><strong style={{ color: data.balance > 0 ? '#dc2626' : '#16a34a' }}>{fmt(data.balance)}</strong></div>
              </div>
              <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#64748b' }}><th>Material</th><th>Qty</th><th>Remaining</th><th>Unit Cost</th><th>Amount</th></tr>
                </thead>
                <tbody>
                  {data.purchase_items?.map((i: any) => (
                    <tr key={i.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '0.4rem 0' }}>{materialName(i.material_id)}</td>
                      <td>{Number(i.qty).toLocaleString()}</td>
                      <td>{Number(i.qty_remaining).toLocaleString()}</td>
                      <td>{fmt(i.cost_price)}</td>
                      <td>{fmt(i.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.purchase_payments?.length > 0 && (
                <>
                  <h3 style={{ fontSize: '0.9rem', margin: '1rem 0 0.5rem' }}>Payments</h3>
                  <table style={{ width: '100%', fontSize: '0.85rem', borderCollapse: 'collapse' }}>
                    <thead><tr style={{ textAlign: 'left', color: '#64748b' }}><th>Date</th><th>Amount</th><th>Ref</th></tr></thead>
                    <tbody>
                      {data.purchase_payments.map((p: any) => (
                        <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '0.4rem 0' }}>{p.payment_date}</td><td>{fmt(p.amount_paid)}</td><td>{p.reference || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
