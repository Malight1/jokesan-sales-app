import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { MessageSquare } from 'lucide-react';
import { platform, SupportTicket, SUPPORT_CATEGORIES } from '../../lib/api';
import { useQuery } from '../../lib/hooks';
import { Loading, ErrorState, Empty } from '../../components/DataStates';
import DataTable, { Column } from '../../components/DataTable';
import PlatformGate from '../../components/PlatformGate';

const statusBadge: Record<string, string> = {
  open: 'badge-warning', in_progress: 'badge-primary', resolved: 'badge-success', closed: 'badge-gray',
};
const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find(x => x.id === c)?.label ?? c;

export default function PlatformSupport() {
  return <PlatformGate><SupportPanel /></PlatformGate>;
}

function SupportPanel() {
  const navigate = useNavigate();
  const [statusFilter, setStatusFilter] = useState('');
  const { data: rows, loading, error, refetch } = useQuery<SupportTicket[]>(
    () => platform.tickets(statusFilter || undefined), [statusFilter]);

  const columns: Column<SupportTicket>[] = [
    { key: 'tenant_name', header: 'Business', value: t => t.tenant_name ?? '' },
    { key: 'subject', header: 'Subject', value: t => t.subject, render: t => <strong>{t.subject}</strong> },
    { key: 'category', header: 'Category', value: t => categoryLabel(t.category) },
    { key: 'status', header: 'Status', value: t => t.status,
      render: t => <span className={statusBadge[t.status]}>{t.status.replace('_', ' ')}</span> },
    { key: 'message_count', header: 'Messages', align: 'right', value: t => t.message_count ?? 0 },
    { key: 'updated_at', header: 'Last Activity', value: t => t.updated_at, render: t => new Date(t.updated_at).toLocaleString() },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Support Tickets</h1><p>Every conversation, across every tenant</p></div>
      </div>

      {loading && <Loading label="Loading tickets…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}

      {!loading && !error && rows && (
        rows.length === 0 && !statusFilter ? <Empty message="No support tickets yet." /> : (
          <DataTable
            columns={columns} rows={rows} getRowKey={t => t.id}
            searchKeys={[t => t.subject, t => t.tenant_name ?? '']} searchPlaceholder="Search tickets…"
            toolbarExtra={
              <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
                <option value="">All statuses</option>
                <option value="open">Open</option>
                <option value="in_progress">In progress</option>
                <option value="resolved">Resolved</option>
                <option value="closed">Closed</option>
              </select>
            }
            rowActions={[{ icon: <MessageSquare size={15} />, label: 'Open ticket', onClick: t => navigate(`/platform/support/${t.id}`) }]}
          />
        )
      )}
    </div>
  );
}
