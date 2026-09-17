import React, { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { auditLog, team, AuditLogEntry, TeamMember } from '../lib/api';
import { useQuery } from '../lib/hooks';
import DataTable, { Column } from '../components/DataTable';

const startOfYear = (y: number) => `${y}-01-01`;
const endOfYear = (y: number) => `${y}-12-31`;
const todayStr = () => new Date().toISOString().split('T')[0];
const daysAgoStr = (n: number) => new Date(Date.now() - n * 86400000).toISOString().split('T')[0];

function formatMeta(meta: Record<string, any> | null): string {
  if (!meta || Object.keys(meta).length === 0) return '—';
  return Object.entries(meta).map(([k, v]) => {
    const label = k.replace(/_/g, ' ');
    if (v && typeof v === 'object' && !Array.isArray(v) && ('from' in v || 'to' in v)) {
      const show = (x: any) => x === null || x === undefined ? '—' : (typeof x === 'object' ? JSON.stringify(x) : String(x));
      return `${label}: ${show(v.from)} → ${show(v.to)}`;
    }
    return `${label}: ${typeof v === 'object' ? JSON.stringify(v) : v}`;
  }).join(' · ');
}

const prettyEntity = (e: string | null) => e ? e.replace(/_/g, ' ') : '—';
const prettyAction = (a: string) => a.replace(/_/g, ' ');

export default function Audit() {
  const year = new Date().getFullYear();
  const [from, setFrom] = useState(startOfYear(year));
  const [to, setTo] = useState(todayStr());

  const { data: rows, loading, error, refetch } = useQuery<AuditLogEntry[]>(
    () => auditLog.list({ from: `${from}T00:00:00`, to: `${to}T23:59:59` }),
    [from, to],
  );
  const { data: people } = useQuery<TeamMember[]>(() => team.members(), []);

  const userName = useMemo(() => {
    const m = new Map((people ?? []).map(p => [p.id, p.full_name || p.email || 'Unknown']));
    return (id: string | null) => id ? (m.get(id) ?? 'Deleted user') : 'System';
  }, [people]);

  const columns: Column<AuditLogEntry>[] = [
    { key: 'created_at', header: 'Date', value: r => r.created_at,
      render: r => <span style={{ whiteSpace: 'nowrap' }}>{new Date(r.created_at).toLocaleString()}</span> },
    { key: 'user', header: 'User', value: r => userName(r.user_id) },
    { key: 'action', header: 'Action', value: r => prettyAction(r.action),
      render: r => <span className="badge-gray">{prettyAction(r.action)}</span> },
    { key: 'entity', header: 'Entity', value: r => prettyEntity(r.entity) },
    { key: 'entity_id', header: 'Reference', value: r => r.entity_id ?? '',
      render: r => <code style={{ fontSize: '0.78rem' }}>{r.entity_id ?? '—'}</code> },
    { key: 'meta', header: 'Details', value: r => formatMeta(r.meta), sortable: false },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Audit Log</h1>
          <p>{rows ? `${rows.length} events between ${from} and ${to}` : ' '}</p>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '1.25rem', display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
        <ShieldCheck size={16} color="#2563eb" style={{ flexShrink: 0 }} />
        <p style={{ fontSize: '0.82rem', color: '#64748b', margin: 0 }}>
          Every void, return, discount override, shift variance, batch write-off/recall, role change, business
          setting, branch, lookup and price edit is recorded here automatically. Records are never deleted —
          this satisfies the six-year statutory record-keeping requirement.
        </p>
      </div>

      <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'flex-end', marginBottom: '1.25rem', flexWrap: 'wrap' }}>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>From</label>
          <input type="date" value={from} onChange={e => setFrom(e.target.value)} />
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label>To</label>
          <input type="date" value={to} onChange={e => setTo(e.target.value)} />
        </div>
        <div style={{ display: 'flex', gap: '0.4rem' }}>
          <button type="button" className="btn-secondary btn-sm" onClick={() => { setFrom(daysAgoStr(30)); setTo(todayStr()); }}>Last 30 days</button>
          <button type="button" className="btn-secondary btn-sm" onClick={() => { setFrom(startOfYear(year)); setTo(todayStr()); }}>This year</button>
          <button type="button" className="btn-secondary btn-sm" onClick={() => { setFrom(startOfYear(year - 1)); setTo(endOfYear(year - 1)); }}>{year - 1}</button>
          <button type="button" className="btn-secondary btn-sm" onClick={() => { setFrom('2000-01-01'); setTo(todayStr()); }}>All time</button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        error={error}
        onRetry={refetch}
        getRowKey={r => r.id}
        searchKeys={[r => prettyAction(r.action), r => prettyEntity(r.entity), r => r.entity_id ?? '', r => userName(r.user_id), r => formatMeta(r.meta)]}
        searchPlaceholder="Search the audit log…"
        exportName={`audit-log-${from}-to-${to}`}
        exportTitle="Audit Log"
        emptyMessage="No audit events in this range."
      />
    </div>
  );
}
