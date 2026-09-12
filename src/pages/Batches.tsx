import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { X, Search, Trash2, PauseCircle, AlertOctagon, PlayCircle, MessageCircle } from 'lucide-react';
import {
  batches as batchesApi, finishedGoods as goodsApi,
  FgBatch, FinishedGood, BatchStatus, BatchTrace,
} from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { useBranches } from '../lib/useBranches';
import { hasFeature, planFor } from '../lib/features';
import { expiryState, expiryLabel, longDate, BATCH_STATUS } from '../lib/batches';
import { whatsappLink } from '../lib/whatsapp';
import DataTable, { Column, RowAction } from '../components/DataTable';
import { Loading, ErrorState } from '../components/DataStates';
import Modal from '../components/Modal';

// Every finished-goods batch the business holds (migration 0022): its
// number, when it was made, when it expires, and whether it may be sold.
// From here a batch can be traced, held, recalled or written off.

type View = 'stock' | 'soon' | 'expired' | 'held' | 'all';

const num = (n: number) => Number(n || 0).toLocaleString();

const ORIGIN_LABEL: Record<string, string> = {
  production: 'Made before batch numbers',
  opening: 'Opening stock',
  adjustment: 'Added by adjustment',
  transfer: 'Transferred in',
};

const STATUS_BADGE: Record<BatchStatus, string> = {
  available: 'badge-success',
  quarantine: 'badge-warning',
  recalled: 'badge-danger',
};

export default function Batches() {
  const toast = useToast();
  const { profile, tenant } = useAuth();
  const role = profile?.role;
  const isAdmin = role === 'admin';
  const canWriteOff = isAdmin || role === 'inventory';
  const tracking = hasFeature(tenant?.plan, 'batch_tracking');
  const warnDays = tenant?.expiry_warning_days ?? 60;
  const { multi, myBranchId, nameOf } = useBranches();

  const [view, setView] = useState<View>('stock');
  const includeEmpty = view === 'all';
  const q = useQuery<FgBatch[]>(() => batchesApi.list(includeEmpty), [includeEmpty]);
  const goodsQ = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const goodsById = useMemo(() => new Map((goodsQ.data ?? []).map(g => [g.id, g])), [goodsQ.data]);
  const productName = (id: string) => goodsById.get(id)?.name ?? '—';

  const [traceFor, setTraceFor] = useState<FgBatch | null>(null);
  const [statusFor, setStatusFor] = useState<{ batch: FgBatch; status: BatchStatus } | null>(null);
  const [writeOffFor, setWriteOffFor] = useState<FgBatch | null>(null);

  const state = (b: FgBatch) => expiryState(b.expiry_date, warnDays);
  const inStock = useMemo(() => (q.data ?? []).filter(b => Number(b.qty_remaining) > 0), [q.data]);
  const counts = {
    stock: inStock.length,
    soon: inStock.filter(b => b.status === 'available' && state(b) === 'soon').length,
    expired: inStock.filter(b => b.status === 'available' && state(b) === 'expired').length,
    held: inStock.filter(b => b.status !== 'available').length,
  };

  const rows = useMemo(() => {
    if (!q.data) return null;
    switch (view) {
      case 'soon': return inStock.filter(b => b.status === 'available' && state(b) === 'soon');
      case 'expired': return inStock.filter(b => b.status === 'available' && state(b) === 'expired');
      case 'held': return inStock.filter(b => b.status !== 'available');
      case 'all': return q.data;
      default: return inStock;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data, inStock, view, warnDays]);

  const reload = () => { q.refetch(); };

  const columns: Column<FgBatch>[] = [
    { key: 'product', header: 'Product', value: b => productName(b.finished_good_id),
      render: b => <strong>{productName(b.finished_good_id)}</strong> },
    { key: 'batch_no', header: 'Batch', value: b => b.batch_no ?? '',
      render: b => b.batch_no
        ? <span style={{ fontVariantNumeric: 'tabular-nums' }}>{b.batch_no}</span>
        : <span style={{ color: '#94a3b8' }}>{ORIGIN_LABEL[b.origin] ?? 'No number'}</span> },
    ...(multi ? [{ key: 'branch', header: 'Branch', value: (b: FgBatch) => nameOf(b.branch_id) }] : []),
    { key: 'qty_remaining', header: 'Left', align: 'right', value: b => Number(b.qty_remaining),
      render: b => <><strong>{num(b.qty_remaining)}</strong><span style={{ color: '#94a3b8' }}> of {num(b.qty)}</span></> },
    { key: 'mfg_date', header: 'Made', value: b => b.mfg_date ?? '', render: b => b.mfg_date ? longDate(b.mfg_date) : '—' },
    { key: 'expiry_date', header: 'Expires', value: b => b.expiry_date ?? '9999',
      render: b => {
        if (!b.expiry_date) return <span style={{ color: '#94a3b8' }}>No expiry</span>;
        const s = state(b);
        const cls = s === 'expired' ? 'badge-danger' : s === 'soon' ? 'badge-warning' : '';
        return cls
          ? <span className={cls} title={longDate(b.expiry_date)}>{expiryLabel(b.expiry_date)}</span>
          : <span title={expiryLabel(b.expiry_date)}>{longDate(b.expiry_date)}</span>;
      } },
    { key: 'status', header: 'Status', value: b => BATCH_STATUS[b.status],
      render: b => <span className={STATUS_BADGE[b.status]} title={b.status_reason ?? undefined}>{BATCH_STATUS[b.status]}</span> },
  ];

  const canTrace = tracking && role !== 'sales';
  const rowActions: RowAction<FgBatch>[] = [
    { icon: <Search size={15} />, label: 'Trace this batch', onClick: setTraceFor, show: b => canTrace && !!b.batch_no },
    { icon: <PauseCircle size={15} />, label: 'Put on hold', onClick: b => setStatusFor({ batch: b, status: 'quarantine' }),
      show: b => isAdmin && tracking && !!b.batch_no && b.status === 'available' },
    { icon: <PlayCircle size={15} />, label: 'Release for sale', onClick: b => setStatusFor({ batch: b, status: 'available' }),
      show: b => isAdmin && !!b.batch_no && b.status !== 'available' },
    { icon: <AlertOctagon size={15} />, label: 'Recall', onClick: b => setStatusFor({ batch: b, status: 'recalled' }),
      show: b => isAdmin && tracking && !!b.batch_no && b.status !== 'recalled', variant: 'danger' },
    { icon: <Trash2 size={15} />, label: 'Write off what is left', onClick: setWriteOffFor, variant: 'danger',
      show: b => canWriteOff && Number(b.qty_remaining) > 0 && (isAdmin || b.branch_id === myBranchId) },
  ];

  const chips: { id: View; label: string; n?: number }[] = [
    { id: 'stock', label: 'In stock', n: counts.stock },
    { id: 'soon', label: `Expiring within ${warnDays} days`, n: counts.soon },
    { id: 'expired', label: 'Expired', n: counts.expired },
    { id: 'held', label: 'On hold or recalled', n: counts.held },
    { id: 'all', label: 'All, including empty' },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Batches</h1>
          <p>{q.data
            ? `${num(counts.stock)} batches in stock · ${num(counts.soon)} expiring soon · ${num(counts.expired)} expired`
            : ' '}</p>
        </div>
      </div>

      {!tracking && (
        <div className="alert alert-info" style={{ fontSize: '0.85rem' }}>
          Every production run gets a batch number on every plan. Expiry alerts, hold, recall and trace are on
          the {planFor('batch_tracking')} plan and above.{isAdmin && <> <Link to="/settings">See plans</Link></>}
        </div>
      )}

      <div role="group" aria-label="Show batches" style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginBottom: '0.85rem' }}>
        {chips.map(c => (
          <button key={c.id} type="button" aria-pressed={view === c.id}
                  className={`${view === c.id ? 'btn-primary' : 'btn-secondary'} btn-sm`}
                  onClick={() => setView(c.id)}>
            {c.label}{c.n !== undefined && q.data ? ` (${num(c.n)})` : ''}
          </button>
        ))}
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={q.loading}
        error={q.error}
        onRetry={q.refetch}
        getRowKey={b => b.id}
        searchKeys={[b => productName(b.finished_good_id), b => b.batch_no ?? '', b => (multi ? nameOf(b.branch_id) : '')]}
        searchPlaceholder="Search product or batch number…"
        exportName="batches"
        exportTitle="Batches"
        rowActions={rowActions}
        emptyMessage={view === 'stock'
          ? 'No batches yet. Each production run creates one, with its own number and dates.'
          : 'Nothing here right now.'}
      />

      {traceFor && traceFor.batch_no && (
        <TraceModal productId={traceFor.finished_good_id} batchNo={traceFor.batch_no}
                    companyName={tenant?.name ?? 'us'} onClose={() => setTraceFor(null)} />
      )}

      {statusFor && (
        <StatusModal batch={statusFor.batch} status={statusFor.status} productName={productName(statusFor.batch.finished_good_id)}
                     onClose={() => setStatusFor(null)}
                     onDone={n => {
                       toast.success(statusFor.status === 'available' ? 'Batch released for sale.'
                         : statusFor.status === 'recalled' ? `Batch recalled at ${n} location${n !== 1 ? 's' : ''}.`
                         : 'Batch put on hold everywhere.');
                       setStatusFor(null);
                       reload();
                     }} />
      )}

      {writeOffFor && (
        <WriteOffModal batch={writeOffFor} productName={productName(writeOffFor.finished_good_id)}
                       unit={goodsById.get(writeOffFor.finished_good_id)?.unit ?? ''}
                       suggest={state(writeOffFor) === 'expired' ? 'Expired' : writeOffFor.status === 'recalled' ? 'Recalled' : 'Damaged'}
                       onClose={() => setWriteOffFor(null)}
                       onDone={() => { toast.success('Written off.'); setWriteOffFor(null); reload(); }} />
      )}
    </div>
  );
}

// ---- Hold / recall / release ------------------------------------------------
function StatusModal({ batch, status, productName, onClose, onDone }: {
  batch: FgBatch; status: BatchStatus; productName: string; onClose: () => void; onDone: (layers: number) => void;
}) {
  const [reason, setReason] = useState('');
  const mut = useMutation(batchesApi.setStatus);
  const needsReason = status !== 'available';

  const copy = {
    recalled: {
      title: `Recall batch ${batch.batch_no}`,
      body: <>Sales of <strong>{productName}</strong> batch <strong>{batch.batch_no}</strong> stop at every branch straight away, and the recall is kept in the audit log. Afterwards, trace the batch to reach the customers who bought it.</>,
      button: 'Recall batch', cls: 'btn-danger',
    },
    quarantine: {
      title: `Put batch ${batch.batch_no} on hold`,
      body: <>Nobody can sell <strong>{productName}</strong> batch <strong>{batch.batch_no}</strong> at any branch until an admin releases it. Use this while you check a complaint or a quality problem.</>,
      button: 'Put on hold', cls: 'btn-primary',
    },
    available: {
      title: `Release batch ${batch.batch_no}`,
      body: <><strong>{productName}</strong> batch <strong>{batch.batch_no}</strong> can be sold again at every branch (unless it has expired).</>,
      button: 'Release batch', cls: 'btn-primary',
    },
  }[status];

  const submit = async () => {
    if (needsReason && !reason.trim()) return;
    const n = await mut.mutate(batch.finished_good_id, batch.batch_no!, status, reason.trim() || null);
    if (n !== null) onDone(Number(n));
  };

  return (
    <Modal onClose={onClose} maxWidth={440}>
      <div className="modal-header">
        <h2>{copy.title}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {mut.error && <ErrorState message={mut.error} />}
        <p style={{ fontSize: '0.88rem', color: '#475569', marginBottom: '1rem' }}>{copy.body}</p>
        {needsReason && (
          <div className="form-group">
            <label htmlFor="batch-reason">Reason</label>
            <textarea id="batch-reason" rows={3} value={reason} onChange={e => setReason(e.target.value)}
                      placeholder={status === 'recalled' ? 'e.g. Customer reports of skin irritation' : 'e.g. Waiting for lab result'} />
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className={copy.cls} onClick={submit} disabled={mut.pending || (needsReason && !reason.trim())}>
          {mut.pending ? 'Saving…' : copy.button}
        </button>
      </div>
    </Modal>
  );
}

// ---- Write off one batch ------------------------------------------------------
function WriteOffModal({ batch, productName, unit, suggest, onClose, onDone }: {
  batch: FgBatch; productName: string; unit: string; suggest: string; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState(suggest);
  const [note, setNote] = useState('');
  const mut = useMutation(batchesApi.writeOff);
  const u = unit ? ` ${unit}` : '';

  const submit = async () => {
    if (reason === 'Other' && !note.trim()) return;
    const full = note.trim() ? `${reason} — ${note.trim()}` : reason;
    const res = await mut.mutate('finished_good', batch.id, full);
    if (res !== null) onDone();
  };

  return (
    <Modal onClose={onClose} maxWidth={420}>
      <div className="modal-header">
        <h2>Write off batch</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {mut.error && <ErrorState message={mut.error} />}
        <p style={{ fontSize: '0.88rem', color: '#475569', marginBottom: '1rem' }}>
          Remove the last <strong>{num(batch.qty_remaining)}{u}</strong> of <strong>{productName}</strong>
          {batch.batch_no ? <> batch <strong>{batch.batch_no}</strong></> : null} from stock. Its cost is recorded
          against the write-off, and it can't be undone.
        </p>
        <div className="form-group">
          <label htmlFor="wo-reason">Reason</label>
          <select id="wo-reason" value={reason} onChange={e => setReason(e.target.value)}>
            {['Expired', 'Damaged', 'Recalled', 'Other'].map(r => <option key={r}>{r}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label htmlFor="wo-note">Note {reason === 'Other' ? '' : '(optional)'}</label>
          <input id="wo-note" value={note} onChange={e => setNote(e.target.value)} placeholder="e.g. destroyed on 12 Sept" />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Cancel</button>
        <button type="button" className="btn-danger" onClick={submit} disabled={mut.pending || (reason === 'Other' && !note.trim())}>
          {mut.pending ? 'Writing off…' : 'Write off'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Trace: what went in, where it went -------------------------------------
function TraceModal({ productId, batchNo, companyName, onClose }: {
  productId: string; batchNo: string; companyName: string; onClose: () => void;
}) {
  const { data, loading, error } = useQuery<BatchTrace>(() => batchesApi.trace(productId, batchNo), [productId, batchNo]);
  const cell: React.CSSProperties = { padding: '0.45rem 0.5rem 0.45rem 0', borderTop: '1px solid #f1f5f9', verticalAlign: 'top' };
  const head: React.CSSProperties = { textAlign: 'left', color: '#64748b', fontWeight: 600, fontSize: '0.78rem', padding: '0 0.5rem 0.35rem 0' };
  const u = data?.unit ? ` ${data.unit}` : '';

  const recallText = (s: BatchTrace['sales'][number]) => [
    `Hello ${s.customer ?? 'there'},`, '',
    `This is ${companyName}. We are recalling *${data?.product}*, batch *${data?.batch_no}*${s.doc_no ? ` (your invoice ${s.doc_no})` : ''}.`,
    'Please stop selling or using it, and contact us for a replacement or a refund.',
    '', 'We are sorry for the trouble.',
  ].join('\n');

  return (
    <Modal onClose={onClose} maxWidth={720}>
      <div className="modal-header">
        <h2>Trace batch {batchNo}</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        {loading && <Loading label="Tracing the batch…" />}
        {error && <ErrorState message={error} />}
        {data && (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: '0.75rem', marginBottom: '1.1rem', fontSize: '0.85rem' }}>
              <div><span style={{ color: '#94a3b8' }}>Product</span><br /><strong>{data.product}</strong></div>
              <div><span style={{ color: '#94a3b8' }}>Made</span><br /><strong>{data.mfg_date ? longDate(data.mfg_date) : '—'}</strong></div>
              <div><span style={{ color: '#94a3b8' }}>Expires</span><br /><strong>{data.expiry_date ? longDate(data.expiry_date) : 'No expiry'}</strong></div>
              <div><span style={{ color: '#94a3b8' }}>Status</span><br />
                <span className={STATUS_BADGE[data.status]}>{BATCH_STATUS[data.status]}</span></div>
              {data.nafdac_no && <div><span style={{ color: '#94a3b8' }}>NAFDAC</span><br /><strong>{data.nafdac_no}</strong></div>}
              <div><span style={{ color: '#94a3b8' }}>Made / sold</span><br /><strong>{num(data.made)}{u} / {num(data.sold_qty)}{u}</strong></div>
            </div>
            {data.status_reason && (
              <div className="alert alert-warning" style={{ fontSize: '0.82rem' }}>{data.status_reason}</div>
            )}

            <h3 style={{ fontSize: '0.9rem', margin: '0 0 0.4rem' }}>Made from</h3>
            {data.sources.length === 0
              ? <p style={{ fontSize: '0.82rem', color: '#94a3b8', marginBottom: '1rem' }}>No production record: this stock was added as opening stock or by adjustment.</p>
              : (
                <div style={{ overflowX: 'auto', marginBottom: '1.1rem' }}>
                  <table style={{ width: '100%', fontSize: '0.82rem', borderCollapse: 'collapse' }}>
                    <thead><tr><th style={head}>Material</th><th style={head}>Used</th><th style={head}>Supplier</th><th style={head}>Supplier batch</th><th style={head}>Material expiry</th></tr></thead>
                    <tbody>
                      {data.sources.map((s, i) => (
                        <tr key={i}>
                          <td style={cell}>{s.material}</td>
                          <td style={cell}>{num(s.qty)}{s.unit ? ` ${s.unit}` : ''}</td>
                          <td style={cell}>{s.supplier ?? '—'}</td>
                          <td style={cell}>{s.supplier_batch_no ?? '—'}</td>
                          <td style={cell}>{s.material_expiry ? longDate(s.material_expiry) : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

            <h3 style={{ fontSize: '0.9rem', margin: '0 0 0.4rem' }}>Still in stock</h3>
            <p style={{ fontSize: '0.84rem', marginBottom: '1.1rem' }}>
              {data.stock.length === 0 ? 'None left anywhere.' : data.stock.map(s => `${s.branch}: ${num(s.qty)}${u}`).join(' · ')}
            </p>

            <h3 style={{ fontSize: '0.9rem', margin: '0 0 0.4rem' }}>Sold to</h3>
            {data.sales.length === 0
              ? <p style={{ fontSize: '0.82rem', color: '#94a3b8' }}>None of this batch has been sold.</p>
              : (
                <div style={{ overflowX: 'auto' }}>
                  {!data.shows_customers && (
                    <p style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: '0.4rem' }}>
                      Customer names and phone numbers are visible to the owner and accounts.
                    </p>
                  )}
                  <table style={{ width: '100%', fontSize: '0.82rem', borderCollapse: 'collapse' }}>
                    <thead><tr>
                      <th style={head}>Date</th><th style={head}>Invoice</th>
                      {data.shows_customers && <th style={head}>Customer</th>}
                      <th style={head}>Branch</th><th style={head}>Qty</th>
                      {data.shows_customers && <th style={head}><span className="sr-only">Contact</span></th>}
                    </tr></thead>
                    <tbody>
                      {data.sales.map(s => (
                        <tr key={s.sale_id}>
                          <td style={cell}>{longDate(s.date)}</td>
                          <td style={cell}>{s.doc_no ?? '—'}</td>
                          {data.shows_customers && <td style={cell}>{s.customer}{s.phone ? <><br /><span style={{ color: '#94a3b8' }}>{s.phone}</span></> : null}</td>}
                          <td style={cell}>{s.branch}</td>
                          <td style={cell}>{num(s.qty)}{u}</td>
                          {data.shows_customers && (
                            <td style={cell}>
                              {s.phone && (
                                <a className="btn-ghost btn-sm" href={whatsappLink(s.phone, recallText(s))} target="_blank" rel="noreferrer">
                                  <MessageCircle size={14} /> Message
                                </a>
                              )}
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn-secondary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}
