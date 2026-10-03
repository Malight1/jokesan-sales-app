import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CheckCircle2, Clock, Reply } from 'lucide-react';
import { platform, SupportTicket, SUPPORT_CATEGORIES } from '../../lib/api';
import { useQuery } from '../../lib/hooks';
import { Loading, ErrorState } from '../../components/DataStates';
import PlatformGate from '../../components/PlatformGate';
import { ago } from '../../components/SupportConversation';
import '../Support.scss';

const statusBadge: Record<string, string> = {
  open: 'badge-warning', in_progress: 'badge-primary', resolved: 'badge-success', closed: 'badge-gray',
};
const statusLabel: Record<string, string> = {
  open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed',
};
const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find(x => x.id === c)?.label ?? c;

type View = 'waiting' | 'active' | 'resolved' | 'all';

export default function PlatformSupport() {
  return <PlatformGate><SupportPanel /></PlatformGate>;
}

function SupportPanel() {
  // One fetch for every view: the counts on the tabs need all of them
  // anyway, and the queue is small enough that filtering here is instant.
  const { data: rows, loading, error, refetch } = useQuery<SupportTicket[]>(() => platform.tickets(), []);
  const [view, setView] = useState<View>('waiting');
  const [q, setQ] = useState('');

  const groups = useMemo(() => {
    const all = rows ?? [];
    return {
      waiting: all.filter(t => t.awaiting_reply),
      active: all.filter(t => t.status === 'open' || t.status === 'in_progress'),
      resolved: all.filter(t => t.status === 'resolved' || t.status === 'closed'),
      all,
    };
  }, [rows]);

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = groups[view];
    if (!needle) return list;
    return list.filter(t => [t.subject, t.tenant_name, t.created_by_name, t.created_by_email]
      .some(v => (v ?? '').toLowerCase().includes(needle)));
  }, [groups, view, q]);

  const tabs: { id: View; label: string }[] = [
    { id: 'waiting', label: 'Waiting on you' },
    { id: 'active', label: 'All open' },
    { id: 'resolved', label: 'Resolved' },
    { id: 'all', label: 'Everything' },
  ];

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <h1>Support</h1>
          <p>
            {rows
              ? groups.waiting.length === 0
                ? 'Nobody is waiting on you.'
                : `${groups.waiting.length} ${groups.waiting.length === 1 ? 'business is' : 'businesses are'} waiting on a reply.`
              : ' '}
          </p>
        </div>
      </div>

      {loading && <Loading label="Loading tickets…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}

      {!loading && !error && rows && (
        <>
          <div className="sp-toolbar">
            <div className="sp-tabs" role="tablist" aria-label="Which tickets">
              {tabs.map(t => (
                <button key={t.id} role="tab" aria-selected={view === t.id} className={view === t.id ? 'is-on' : ''} onClick={() => setView(t.id)}>
                  {t.label} <span className="sp-count">{groups[t.id].length}</span>
                </button>
              ))}
            </div>
            <input className="sp-search" type="search" value={q} onChange={e => setQ(e.target.value)}
                   placeholder="Search subject, business or person…" aria-label="Search tickets" />
          </div>

          <div className="sp-inbox">
            {shown.length === 0 ? (
              <div className="sp-inbox-empty">
                {view === 'waiting' && !q ? (
                  <><CheckCircle2 size={28} /><strong>All caught up</strong>Every customer has had a reply.</>
                ) : (
                  <>{q ? 'No tickets match your search.' : 'No tickets here.'}</>
                )}
              </div>
            ) : shown.map(t => (
              <Link key={t.id} to={`/platform/support/${t.id}`} className={`sp-row${t.unread ? ' is-unread' : ''}`}>
                <span className={`sp-dot${t.unread ? ' is-on' : ''}`} aria-label={t.unread ? 'Unread' : undefined} />
                <span className="sp-row-main">
                  <span className="sp-row-top">
                    <span className="sp-row-subject">{t.subject}</span>
                  </span>
                  <span className="sp-row-sub">
                    {t.tenant_name}
                    {t.created_by_name ? ` · ${t.created_by_name}` : t.created_by ? '' : ' · started by support'}
                    {` · ${categoryLabel(t.category)}`}
                  </span>
                </span>
                <span className="sp-row-side">
                  <span className={statusBadge[t.status]}>{statusLabel[t.status] ?? t.status}</span>
                  {t.awaiting_reply ? (
                    <span className="sp-turn is-you"><Clock size={12} /> Waiting {ago(t.last_message_at)}</span>
                  ) : t.last_sender === 'admin' && (t.status === 'open' || t.status === 'in_progress') ? (
                    <span className="sp-turn is-them"><Reply size={12} /> You replied {ago(t.last_message_at)}</span>
                  ) : (
                    <span>{ago(t.last_message_at ?? t.updated_at)}</span>
                  )}
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
