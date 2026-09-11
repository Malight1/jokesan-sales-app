import React, { useMemo, useState } from 'react';
import { ArrowRight, Send } from 'lucide-react';
import {
  transfers as transfersApi, stock, materials as materialsApi, finishedGoods as goodsApi,
  StockTransfer, StockLevel, Material, FinishedGood,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useAuth } from '../lib/AuthContext';
import { useToast } from '../lib/ToastContext';
import { useBranches } from '../lib/useBranches';
import { qtyByProduct } from '../lib/branchStock';
import { Loading, ErrorState, Empty } from '../components/DataStates';
import DataTable, { Column } from '../components/DataTable';
import NumberInput from '../components/NumberInput';

const fmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });

// Moves stock from one branch to another. The stock travels at its original
// FIFO cost (transfer_stock, migration 0020), so a product's margin is the
// same whichever branch finally sells it. The company total doesn't change.
export default function Transfers() {
  const { profile } = useAuth();
  const toast = useToast();
  const { multi, active, myBranchId, nameOf, loading: branchesLoading } = useBranches();
  const isAdmin = profile?.role === 'admin';

  const listQ = useQuery<StockTransfer[]>(() => transfersApi.list(), []);
  const levelsQ = useQuery<StockLevel[]>(() => stock.levels(null), []);
  const matsQ = useQuery<Material[]>(() => materialsApi.list(), []);
  const goodsQ = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const sendMut = useMutation(transfersApi.create);

  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<'finished_good' | 'material'>('finished_good');
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState(0);
  const [note, setNote] = useState('');

  // A storekeeper always sends from their own branch; an admin can pick.
  const fromId = isAdmin ? (from || myBranchId || '') : (myBranchId || '');
  const destinations = active.filter(b => b.id !== fromId);
  const toId = destinations.some(b => b.id === to) ? to : '';

  const availHere = useMemo(
    () => qtyByProduct((levelsQ.data ?? []).filter(l => l.product_kind === kind), fromId),
    [levelsQ.data, kind, fromId],
  );
  const catalog: { id: string; name: string; unit: string | null }[] =
    kind === 'finished_good' ? (goodsQ.data ?? []) : (matsQ.data ?? []);
  const options = catalog
    .filter(i => (availHere.get(i.id) ?? 0) > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
  const chosen = catalog.find(i => i.id === productId);
  const available = availHere.get(productId) ?? 0;

  const itemName = useMemo(() => {
    const names = new Map<string, { name: string; unit: string | null }>();
    (matsQ.data ?? []).forEach(m => names.set(m.id, { name: m.name, unit: m.unit }));
    (goodsQ.data ?? []).forEach(g => names.set(g.id, { name: g.name, unit: g.unit }));
    return names;
  }, [matsQ.data, goodsQ.data]);

  const problem = !fromId ? 'Choose the branch sending the stock.'
    : !toId ? 'Choose where the stock is going.'
    : !productId ? 'Choose what to send.'
    : !qty || qty <= 0 ? 'Enter how much to send.'
    : qty > available ? `Only ${available.toLocaleString()} ${chosen?.unit ?? ''} at ${nameOf(fromId)}.`
    : null;

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    if (problem) { toast.error(problem); return; }
    const res = await sendMut.mutate({
      fromBranchId: fromId, toBranchId: toId, kind, productId, qty, note: note.trim() || null,
    });
    if (res !== null) {
      toast.success(`Sent ${qty.toLocaleString()} ${chosen?.unit ?? ''} ${chosen?.name ?? ''} to ${nameOf(toId)}.`);
      setProductId(''); setQty(0); setNote('');
      listQ.refetch();
      levelsQ.refetch();
    } else {
      toast.error(sendMut.error ?? 'Transfer failed.');
    }
  };

  const columns: Column<StockTransfer>[] = [
    { key: 'created_at', header: 'Date', value: t => t.created_at,
      render: t => new Date(t.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) },
    { key: 'item', header: 'Item', value: t => itemName.get(t.product_id)?.name ?? '—',
      render: t => <strong>{itemName.get(t.product_id)?.name ?? '—'}</strong> },
    { key: 'qty', header: 'Qty', align: 'right', value: t => Number(t.qty),
      render: t => `${Number(t.qty).toLocaleString()} ${itemName.get(t.product_id)?.unit ?? ''}` },
    { key: 'route', header: 'From → To', value: t => `${nameOf(t.from_branch_id)} → ${nameOf(t.to_branch_id)}`,
      render: t => <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        {nameOf(t.from_branch_id)} <ArrowRight size={13} /> {nameOf(t.to_branch_id)}
      </span> },
    { key: 'total_cost', header: 'Value at cost', align: 'right', value: t => Number(t.total_cost),
      render: t => fmt(Number(t.total_cost)) },
    { key: 'note', header: 'Note', value: t => t.note ?? '', render: t => t.note ?? '—' },
  ];

  if (branchesLoading) return <Loading label="Loading branches…" />;

  if (!multi || active.length < 2) {
    return (
      <div>
        <div className="page-header">
          <div className="page-title"><h1>Stock Transfers</h1><p>Move stock between your branches</p></div>
        </div>
        <Empty message={!multi
          ? 'Transfers move stock between branches. This company is set up as a single location, so there is nowhere to send stock to.'
          : 'You need at least two active branches to transfer stock. Add another under Settings → Branches.'} />
      </div>
    );
  }

  const loading = levelsQ.loading || matsQ.loading || goodsQ.loading;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Stock Transfers</h1>
          <p>Stock arrives at its original cost, so margins stay true wherever it's sold</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.25rem' }}>
        <h3 style={{ marginBottom: '1rem' }}>Send stock</h3>
        {loading ? <Loading label="Checking what each branch holds…" /> : (
          <form onSubmit={send}>
            <div className="grid-2">
              <div className="form-group">
                <label>From</label>
                {isAdmin ? (
                  <select value={fromId} onChange={e => { setFrom(e.target.value); setProductId(''); }}>
                    {active.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                ) : (
                  <input value={nameOf(fromId)} disabled />
                )}
              </div>
              <div className="form-group">
                <label>To</label>
                <select value={toId} onChange={e => setTo(e.target.value)}>
                  <option value="">Choose a branch…</option>
                  {destinations.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </div>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label>Type</label>
                <select value={kind} onChange={e => { setKind(e.target.value as any); setProductId(''); }}>
                  <option value="finished_good">Finished products</option>
                  <option value="material">Raw &amp; packaging materials</option>
                </select>
              </div>
              <div className="form-group">
                <label>Item</label>
                <select value={productId} onChange={e => setProductId(e.target.value)}>
                  <option value="">{options.length ? 'Choose an item…' : `Nothing in stock at ${nameOf(fromId)}`}</option>
                  {options.map(i => (
                    <option key={i.id} value={i.id}>
                      {i.name} — {(availHere.get(i.id) ?? 0).toLocaleString()} {i.unit ?? ''} here
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid-2">
              <div className="form-group">
                <label>Quantity {chosen?.unit ? `(${chosen.unit})` : ''}</label>
                <NumberInput value={qty} onChange={setQty} />
                {productId && (
                  <small style={{ color: '#94a3b8', fontSize: '0.75rem' }}>
                    {available.toLocaleString()} {chosen?.unit ?? ''} available at {nameOf(fromId)}
                  </small>
                )}
              </div>
              <div className="form-group">
                <label>Note (optional)</label>
                <input value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. weekly restock, waybill #…" />
              </div>
            </div>

            <button className="btn-primary" type="submit" disabled={sendMut.pending || !!problem}>
              {sendMut.pending ? 'Sending…' : <><Send size={15} /> Send stock</>}
            </button>
            {problem && productId && <span style={{ marginLeft: 12, color: '#b45309', fontSize: '0.85rem' }}>{problem}</span>}
          </form>
        )}
      </div>

      {listQ.error ? <ErrorState message={listQ.error} onRetry={listQ.refetch} /> : (
        <DataTable
          columns={columns}
          rows={listQ.data ?? []}
          getRowKey={t => t.id}
          loading={listQ.loading}
          searchKeys={[t => itemName.get(t.product_id)?.name ?? '', t => nameOf(t.from_branch_id), t => nameOf(t.to_branch_id), t => t.note ?? '']}
          searchPlaceholder="Search by item, branch or note…"
          exportName="stock-transfers"
          exportTitle="Stock Transfers"
          emptyMessage="No transfers yet."
        />
      )}
    </div>
  );
}
