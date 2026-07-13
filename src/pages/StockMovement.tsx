import React from 'react';
import { stock, materials as materialsApi, finishedGoods as goodsApi, StockMovement as Movement, Material, FinishedGood } from '../lib/api';
import { useQuery } from '../lib/hooks';
import DataTable, { Column } from '../components/DataTable';

const typeClass = (t: string) =>
  t === 'SALE' ? 'badge-danger' : t === 'PRODUCTION' ? 'badge-success' : t === 'PURCHASE' ? 'badge-primary' : 'badge-gray';

export default function StockMovement() {
  const { data: rows, loading, error, refetch } = useQuery<Movement[]>(() => stock.movements(500), []);
  const { data: materials } = useQuery<Material[]>(() => materialsApi.list(), []);
  const { data: goods } = useQuery<FinishedGood[]>(() => goodsApi.list(), []);

  const productName = (kind: string, id: string) =>
    kind === 'material' ? (materials?.find(m => m.id === id)?.name ?? 'Material') : (goods?.find(g => g.id === id)?.name ?? 'Product');

  const fmtDate = (s: string) => new Date(s).toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  const columns: Column<Movement>[] = [
    { key: 'created_at', header: 'Date', value: m => m.created_at, render: m => fmtDate(m.created_at) },
    { key: 'item', header: 'Item', value: m => productName(m.product_kind, m.product_id), render: m => <strong>{productName(m.product_kind, m.product_id)}</strong> },
    { key: 'kind', header: 'Kind', value: m => m.product_kind === 'material' ? 'Raw Material' : 'Finished Good' },
    { key: 'movement_type', header: 'Type', value: m => m.movement_type, render: m => <span className={typeClass(m.movement_type)}>{m.movement_type}</span> },
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
        searchKeys={[m => productName(m.product_kind, m.product_id), m => m.movement_type]}
        searchPlaceholder="Search movements…"
        exportName="stock-movements"
        exportTitle="Stock Movement Ledger"
        emptyMessage="No stock movements yet. They appear as you record purchases, production, and sales."
        pageSize={20}
      />
    </div>
  );
}
