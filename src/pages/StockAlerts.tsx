import React, { useMemo, useState } from 'react';
import { AlertTriangle, XCircle, ShoppingCart, FlaskConical, X, Edit2, Search, Repeat } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { materials as materialsApi, finishedGoods as goodsApi, stock, StockLevel } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { useAuth } from '../lib/AuthContext';
import { useBranches } from '../lib/useBranches';
import { canAccess } from '../lib/permissions';
import { Loading, ErrorState } from '../components/DataStates';
import NumberInput from '../components/NumberInput';
import './StockAlerts.scss';
import Modal from '../components/Modal';

type EditTarget = { kind: 'material' | 'finished_good'; id: string; name: string; value: number };

const num = (n: number) => Number(n || 0).toLocaleString();
const pct = (qty: number, min: number) => Math.min(100, Math.round((qty / (min || 1)) * 100));

// Alerts are per branch now: 40 bottles in the company means nothing to the
// Abuja shop if all 40 are in Lagos. Staff see their own branch; admin and
// accounts see every branch, labelled.
export default function StockAlerts() {
  const navigate = useNavigate();
  const toast = useToast();
  const { profile } = useAuth();
  const role = profile?.role;
  // Everyone can see what's short; only admin/inventory may change a
  // reorder level, matching the stock-table write policy.
  const canEditStock = role === 'admin' || role === 'inventory';
  const seeAll = role === 'admin' || role === 'accounts';
  const { multi, myBranchId, myBranchName } = useBranches();

  const levelsQ = useQuery<StockLevel[]>(() => stock.levels(seeAll ? null : myBranchId), [seeAll, myBranchId]);
  const saveMat = useMutation(materialsApi.setMinLevel);
  const saveGood = useMutation(goodsApi.setMinLevel);

  const [editItem, setEditItem] = useState<EditTarget | null>(null);
  const [search, setSearch] = useState('');

  const showBranch = multi && seeAll;
  const q = search.trim().toLowerCase();
  const rows = useMemo(
    () => (levelsQ.data ?? []).filter(l =>
      !q || l.name.toLowerCase().includes(q) || (showBranch && l.branch_name.toLowerCase().includes(q))),
    [levelsQ.data, q, showBranch],
  );

  const isOut = (l: StockLevel) => Number(l.qty) <= 0;
  const isLow = (l: StockLevel) => Number(l.qty) > 0 && Number(l.qty) <= Number(l.min_level);
  const groups = [
    { key: 'out-fg', tone: 'danger',  title: 'Out of Stock — Finished Goods', items: rows.filter(l => l.product_kind === 'finished_good' && isOut(l)) },
    { key: 'low-fg', tone: 'warning', title: 'Low Stock — Finished Goods',    items: rows.filter(l => l.product_kind === 'finished_good' && isLow(l)) },
    { key: 'out-m',  tone: 'danger',  title: 'Out of Stock — Raw Materials',  items: rows.filter(l => l.product_kind === 'material' && isOut(l)) },
    { key: 'low-m',  tone: 'warning', title: 'Low Stock — Raw Materials',     items: rows.filter(l => l.product_kind === 'material' && isLow(l)) },
  ];
  const totalAlerts = groups.reduce((s, g) => s + g.items.length, 0);

  const scope = !multi ? '' : seeAll ? ' across all branches' : ` at ${myBranchName}`;

  const saveMinLevel = async () => {
    if (!editItem) return;
    const res = editItem.kind === 'material'
      ? await saveMat.mutate(editItem.id, editItem.value)
      : await saveGood.mutate(editItem.id, editItem.value);
    if (res !== null) {
      toast.success('Minimum stock level updated.');
      setEditItem(null);
      levelsQ.refetch();
    } else {
      toast.error('Could not update level.');
    }
  };

  const card = (l: StockLevel) => {
    const out = isOut(l);
    const unit = l.unit ?? '';
    return (
      <div className={`alert-card ${out ? 'out-of-stock' : 'low-stock'}`} key={`${l.branch_id}:${l.product_id}`}>
        <div className="alert-card-top">
          <div>
            <div className="item-name">{l.name}</div>
            <div className="item-meta">{showBranch ? `${l.branch_name} · ` : ''}Min level: {num(l.min_level)} {unit}</div>
          </div>
          <span className={out ? 'badge-danger' : 'badge-warning'}>{out ? 'Out of Stock' : 'Low Stock'}</span>
        </div>
        <div className="stock-bar-wrap">
          <div className="stock-bar-track">
            <div className={`stock-bar-fill ${out ? 'danger' : 'warning'}`} style={{ width: `${out ? 0 : pct(Number(l.qty), Number(l.min_level))}%` }} />
          </div>
          <span className="stock-qty">{num(l.qty)} / {num(l.min_level)} {unit}</span>
        </div>
        <div className="alert-actions">
          {l.product_kind === 'finished_good'
            ? canAccess(role, '/production') && (
                <button className="btn-primary btn-sm" onClick={() => navigate('/production')}><FlaskConical size={13} /> Start Production</button>)
            : canAccess(role, '/purchases') && (
                <button className="btn-primary btn-sm" onClick={() => navigate('/purchases')}><ShoppingCart size={13} /> Create Purchase</button>)}
          {multi && canAccess(role, '/transfers') && (
            <button className="btn-ghost btn-sm" onClick={() => navigate('/transfers')}><Repeat size={13} /> Transfer</button>
          )}
          {canEditStock && (
            <button className="btn-ghost btn-sm"
              onClick={() => setEditItem({ kind: l.product_kind, id: l.product_id, name: l.name, value: Number(l.min_level) })}>
              <Edit2 size={13} /> Set Min Level
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="stock-alerts-page">
      <div className="page-header">
        <div className="page-title">
          <h1>Stock Alerts</h1>
          <p>{levelsQ.loading ? ' ' : totalAlerts === 0
            ? `All stock levels are healthy${scope}`
            : `${totalAlerts} item${totalAlerts !== 1 ? 's' : ''} need attention${scope}`}</p>
        </div>
        <div className="dt-search" style={{ maxWidth: 260 }}>
          <Search size={15} />
          <input value={search} onChange={e => setSearch(e.target.value)}
                 placeholder={showBranch ? 'Search items or branches…' : 'Search items…'} />
        </div>
      </div>

      {levelsQ.loading && <Loading label="Checking stock levels…" />}
      {levelsQ.error && <ErrorState message={levelsQ.error} onRetry={levelsQ.refetch} />}

      {!levelsQ.loading && !levelsQ.error && totalAlerts === 0 && (
        <div className="all-clear">
          <div className="all-clear-icon">{q ? '🔍' : '✅'}</div>
          <h2>{q ? 'No matches' : 'All good!'}</h2>
          <p>{q
            ? <>Nothing matching “{search}” needs attention. <button className="btn-ghost btn-sm" onClick={() => setSearch('')}>Clear search</button></>
            : `No low stock or out-of-stock items${scope} at the moment.`}</p>
        </div>
      )}

      {groups.filter(g => g.items.length > 0).map(g => (
        <section className="alert-section" key={g.key}>
          <div className={`section-header ${g.tone}`}>
            {g.tone === 'danger' ? <XCircle size={16} /> : <AlertTriangle size={16} />}
            <h3>{g.title} ({g.items.length})</h3>
          </div>
          <div className="alert-cards">{g.items.map(card)}</div>
        </section>
      ))}

      {editItem && (
        <Modal onClose={() => setEditItem(null)} maxWidth={360}>
            <div className="modal-header">
              <h2>Minimum level — {editItem.name}</h2>
              <button className="close-btn" onClick={() => setEditItem(null)}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Minimum Quantity (reorder point)</label>
                <NumberInput value={editItem.value} onChange={v => setEditItem(ei => ei ? { ...ei, value: v } : ei)} />
                <small style={{ color: '#64748b', fontSize: '0.78rem', marginTop: '0.3rem', display: 'block' }}>
                  A stock alert triggers when quantity falls to or below this number{multi ? ' — at every branch' : ''}.
                </small>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setEditItem(null)}>Cancel</button>
              <button className="btn-primary" onClick={saveMinLevel} disabled={saveMat.pending || saveGood.pending}>
                {(saveMat.pending || saveGood.pending) ? 'Saving…' : 'Save'}
              </button>
            </div>
        </Modal>
      )}
    </div>
  );
}
