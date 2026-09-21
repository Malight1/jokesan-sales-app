import React from 'react';
import { stock, materials as materialsApi, finishedGoods as goodsApi, StockMovement as Movement, Material, FinishedGood } from '../lib/api';
import { useQuery } from '../lib/hooks';
import DataTable, { Column } from '../components/DataTable';
import { useBranches } from '../lib/useBranches';
import { useAuth } from '../lib/AuthContext';
import { isRetail, label } from '../retail';

const typeClass = (t: string) =>
  t === 'SALE' ? 'badge-danger' : t === 'PRODUCTION' ? 'badge-success' : t === 'PURCHASE' ? 'badge-primary'
  : t === 'TRANSFER' ? 'badge-warning' : 'badge-gray';

const typeLabel: Record<string, string> = {
  PURCHASE: 'Purchase', PRODUCTION: 'Production', SALE: 'Sale', ADJUSTMENT: 'Adjustment', TRANSFER: 'Transfer',
};

export default function StockMovement() {
  const { data: rows, loading, error, refetch } = useQuery<Movement[]>(() => stock.movements(500), []);
  // Staff only receive their own branch's rows (RLS, migration 0020); admin
  // and accounts see every branch, so label them.
  const { multi, nameOf } = useBranches();
  const { tenant } = useAuth();
  const retail = isRetail(tenant);
  const { data: materials } = useQuery<Material[]>(() => materialsApi.list(), []);
  const { data: goods } = useQuery<FinishedGood[]>(() => goodsApi.list(), []);

  const productName = (kind: string, id: string) =>
    kind === 'material' ? (materials?.find(m => m.id === id)?.name ?? 'Material') : (goods?.find(g => g.id === id)?.name ?? 'Product');

  const fmtDate = (s: string) => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const columns: Column<Movement>[] = [
    { key: 'created_at', header: 'Date', value: m => m.created_at, render: m => fmtDate(m.created_at) },
    { key: 'item', header: 'Item', value: m => productName(m.product_kind, m.product_id), render: m => <strong>{productName(m.product_kind, m.product_id)}</strong> },
    { key: 'kind', header: 'Kind', value: m => m.product_kind === 'material' ? 'Raw Material' : label(retail, 'Finished Good', 'Product') },
    { key: 'movement_type', header: 'Type', value: m => typeLabel[m.movement_type] ?? m.movement_type,
      render: m => <span className={typeClass(m.movement_type)}>{typeLabel[m.movement_type] ?? m.movement_type}</span> },
    ...(multi ? [{ key: 'branch', header: 'Branch', value: (m: Movement) => nameOf(m.branch_id) } as Column<Movement>] : []),
    { key: 'quantity', header: 'Qty', align: 'right', value: m => m.quantity,
      render: m => <span style={{ fontWeight: 600, color: m.quantity < 0 ? '#dc2626' : '#16a34a' }}>{m.quantity > 0 ? '+' : ''}{m.quantity.toLocaleString()}</span> },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Stock Movement</h1><p>Audit trail of all inventory changes</p></div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={m => m.id}
        searchKeys={[m => productName(m.product_kind, m.product_id), m => typeLabel[m.movement_type] ?? m.movement_type, m => nameOf(m.branch_id)]}
        searchPlaceholder="Search movements…"
        exportName="stock-movements"
        exportTitle="Stock Movement Ledger"
        emptyMessage="No stock movements yet. They appear as you record purchases, production, sales, transfers and adjustments."
        pageSize={20}
      />
    </div>
  );
}
