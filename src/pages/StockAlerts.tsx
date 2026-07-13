import React, { useState } from 'react';
import { AlertTriangle, XCircle, ShoppingCart, FlaskConical, X, Edit2 } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { materials as materialsApi, finishedGoods as goodsApi, Material, FinishedGood } from '../lib/api';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from '../components/DataStates';
import NumberInput from '../components/NumberInput';
import './StockAlerts.scss';

type EditTarget = { kind: 'material' | 'good'; id: string; value: number };

export default function StockAlerts() {
  const navigate = useNavigate();
  const toast = useToast();
  const matQ = useQuery<Material[]>(() => materialsApi.list(), []);
  const goodQ = useQuery<FinishedGood[]>(() => goodsApi.list(), []);
  const saveMat = useMutation(materialsApi.setMinLevel);
  const saveGood = useMutation(goodsApi.setMinLevel);

  const [editItem, setEditItem] = useState<EditTarget | null>(null);

  const loading = matQ.loading || goodQ.loading;
  const error = matQ.error || goodQ.error;
  const materials = matQ.data ?? [];
  const goods = goodQ.data ?? [];

  const outOfStockGoods     = goods.filter(g => g.qty_balance === 0);
  const lowStockGoods       = goods.filter(g => g.qty_balance > 0 && g.qty_balance <= g.min_stock_level);
  const outOfStockMaterials = materials.filter(m => m.qty_balance === 0);
  const lowStockMaterials   = materials.filter(m => m.qty_balance > 0 && m.qty_balance <= m.min_stock_level);

  const totalAlerts = outOfStockGoods.length + lowStockGoods.length + outOfStockMaterials.length + lowStockMaterials.length;

  const saveMinLevel = async () => {
    if (!editItem) return;
    const res = editItem.kind === 'material'
      ? await saveMat.mutate(editItem.id, editItem.value)
      : await saveGood.mutate(editItem.id, editItem.value);
    if (res !== null) {
      toast.success('Minimum stock level updated.');
      setEditItem(null);
      matQ.refetch();
      goodQ.refetch();
    } else {
      toast.error('Could not update level.');
    }
  };

  const pct = (qty: number, min: number) => Math.min(100, Math.round((qty / (min || 1)) * 100));

  return (
    <div className="stock-alerts-page">
      <div className="page-header">
        <div className="page-title">
          <h1>Stock Alerts</h1>
          <p>{loading ? ' ' : totalAlerts === 0 ? 'All stock levels are healthy' : `${totalAlerts} item${totalAlerts !== 1 ? 's' : ''} need attention`}</p>
        </div>
      </div>

      {loading && <Loading label="Checking stock levels…" />}
      {error && <ErrorState message={error} onRetry={() => { matQ.refetch(); goodQ.refetch(); }} />}

      {!loading && !error && totalAlerts === 0 && (
        <div className="all-clear">
          <div className="all-clear-icon">✅</div>
          <h2>All good!</h2>
          <p>No low stock or out-of-stock items at the moment.</p>
        </div>
      )}

      {/* Out of Stock — Finished Goods */}
      {outOfStockGoods.length > 0 && (
        <section className="alert-section">
          <div className="section-header danger"><XCircle size={16} /><h3>Out of Stock — Finished Goods ({outOfStockGoods.length})</h3></div>
          <div className="alert-cards">
            {outOfStockGoods.map(g => (
              <div className="alert-card out-of-stock" key={g.id}>
                <div className="alert-card-top">
                  <div><div className="item-name">{g.name}</div><div className="item-meta">Min level: {g.min_stock_level} {g.unit}</div></div>
                  <span className="badge-danger">Out of Stock</span>
                </div>
                <div className="stock-bar-wrap">
                  <div className="stock-bar-track"><div className="stock-bar-fill danger" style={{ width: '0%' }} /></div>
                  <span className="stock-qty">0 / {g.min_stock_level} {g.unit}</span>
                </div>
                <div className="alert-actions">
                  <button className="btn-primary btn-sm" onClick={() => navigate('/production')}><FlaskConical size={13} /> Start Production</button>
                  <button className="btn-ghost btn-sm" onClick={() => setEditItem({ kind: 'good', id: g.id, value: g.min_stock_level })}><Edit2 size={13} /> Set Min Level</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Low Stock — Finished Goods */}
      {lowStockGoods.length > 0 && (
        <section className="alert-section">
          <div className="section-header warning"><AlertTriangle size={16} /><h3>Low Stock — Finished Goods ({lowStockGoods.length})</h3></div>
          <div className="alert-cards">
            {lowStockGoods.map(g => (
              <div className="alert-card low-stock" key={g.id}>
                <div className="alert-card-top">
                  <div><div className="item-name">{g.name}</div><div className="item-meta">Min level: {g.min_stock_level} {g.unit}</div></div>
                  <span className="badge-warning">Low Stock</span>
                </div>
                <div className="stock-bar-wrap">
                  <div className="stock-bar-track"><div className="stock-bar-fill warning" style={{ width: `${pct(g.qty_balance, g.min_stock_level)}%` }} /></div>
                  <span className="stock-qty">{g.qty_balance} / {g.min_stock_level} {g.unit}</span>
                </div>
                <div className="alert-actions">
                  <button className="btn-primary btn-sm" onClick={() => navigate('/production')}><FlaskConical size={13} /> Start Production</button>
                  <button className="btn-ghost btn-sm" onClick={() => setEditItem({ kind: 'good', id: g.id, value: g.min_stock_level })}><Edit2 size={13} /> Set Min Level</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Out of Stock — Raw Materials */}
      {outOfStockMaterials.length > 0 && (
        <section className="alert-section">
          <div className="section-header danger"><XCircle size={16} /><h3>Out of Stock — Raw Materials ({outOfStockMaterials.length})</h3></div>
          <div className="alert-cards">
            {outOfStockMaterials.map(m => (
              <div className="alert-card out-of-stock" key={m.id}>
                <div className="alert-card-top">
                  <div><div className="item-name">{m.name}</div><div className="item-meta">{m.type_of_material} · Min: {m.min_stock_level} {m.unit}</div></div>
                  <span className="badge-danger">Out of Stock</span>
                </div>
                <div className="stock-bar-wrap">
                  <div className="stock-bar-track"><div className="stock-bar-fill danger" style={{ width: '0%' }} /></div>
                  <span className="stock-qty">0 / {m.min_stock_level} {m.unit}</span>
                </div>
                <div className="alert-actions">
                  <button className="btn-primary btn-sm" onClick={() => navigate('/purchases')}><ShoppingCart size={13} /> Create Purchase</button>
                  <button className="btn-ghost btn-sm" onClick={() => setEditItem({ kind: 'material', id: m.id, value: m.min_stock_level })}><Edit2 size={13} /> Set Min Level</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Low Stock — Raw Materials */}
      {lowStockMaterials.length > 0 && (
        <section className="alert-section">
          <div className="section-header warning"><AlertTriangle size={16} /><h3>Low Stock — Raw Materials ({lowStockMaterials.length})</h3></div>
          <div className="alert-cards">
            {lowStockMaterials.map(m => (
              <div className="alert-card low-stock" key={m.id}>
                <div className="alert-card-top">
                  <div><div className="item-name">{m.name}</div><div className="item-meta">{m.type_of_material} · Min: {m.min_stock_level} {m.unit}</div></div>
                  <span className="badge-warning">Low Stock</span>
                </div>
                <div className="stock-bar-wrap">
                  <div className="stock-bar-track"><div className="stock-bar-fill warning" style={{ width: `${pct(m.qty_balance, m.min_stock_level)}%` }} /></div>
                  <span className="stock-qty">{m.qty_balance} / {m.min_stock_level} {m.unit}</span>
                </div>
                <div className="alert-actions">
                  <button className="btn-primary btn-sm" onClick={() => navigate('/purchases')}><ShoppingCart size={13} /> Create Purchase</button>
                  <button className="btn-ghost btn-sm" onClick={() => setEditItem({ kind: 'material', id: m.id, value: m.min_stock_level })}><Edit2 size={13} /> Set Min Level</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Edit Min Level Modal */}
      {editItem && (
        <div className="modal-overlay" onClick={() => setEditItem(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} style={{ maxWidth: 360 }}>
            <div className="modal-header">
              <h2>Set Minimum Stock Level</h2>
              <button className="close-btn" onClick={() => setEditItem(null)}><X size={18} /></button>
            </div>
            <div className="modal-body">
              <div className="form-group">
                <label>Minimum Quantity (reorder point)</label>
                <NumberInput value={editItem.value} onChange={v => setEditItem(ei => ei ? { ...ei, value: v } : ei)} />
                <small style={{ color: '#64748b', fontSize: '0.78rem', marginTop: '0.3rem', display: 'block' }}>
                  A stock alert will trigger when quantity falls at or below this number.
                </small>
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn-secondary" onClick={() => setEditItem(null)}>Cancel</button>
              <button className="btn-primary" onClick={saveMinLevel} disabled={saveMat.pending || saveGood.pending}>
                {(saveMat.pending || saveGood.pending) ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
