import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Send, FileText } from 'lucide-react';
import { platform, support, SupportTicket, SupportTicketMessage, SUPPORT_CATEGORIES } from '../../lib/api';
import { useQuery, useMutation } from '../../lib/hooks';
import { useToast } from '../../lib/ToastContext';
import { Loading, ErrorState } from '../../components/DataStates';
import PlatformGate from '../../components/PlatformGate';

const statusOptions = ['open', 'in_progress', 'resolved', 'closed'] as const;
const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find(x => x.id === c)?.label ?? c;

function AttachmentLink({ path, name }: { path: string; name: string }) {
  const [loading, setLoading] = useState(false);
  const open = async () => {
    setLoading(true);
    try { window.open(await support.attachmentUrl(path), '_blank'); }
    finally { setLoading(false); }
  };
  return (
    <button type="button" onClick={open} disabled={loading}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.78rem', color: '#2563eb', background: 'none', border: '1px solid #dbeafe', borderRadius: 6, padding: '0.2rem 0.5rem', cursor: 'pointer' }}>
      <FileText size={12} /> {loading ? 'Opening…' : name}
    </button>
  );
}

export default function PlatformTicketThread() {
  return <PlatformGate><ThreadPanel /></PlatformGate>;
}

function ThreadPanel() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { data: tickets, loading: ticketsLoading, error: ticketsError } = useQuery<SupportTicket[]>(() => platform.tickets(), []);
  const { data: messages, loading, error, refetch } = useQuery<SupportTicketMessage[]>(() => platform.ticketMessages(id!), [id]);
  const replyMut = useMutation((body: string) => platform.replyTicket(id!, body));
  const statusMut = useMutation((status: string) => platform.updateTicketStatus(id!, status));
  const [body, setBody] = useState('');
  const [localStatus, setLocalStatus] = useState<string | null>(null);

  const ticket = tickets?.find(t => t.id === id);
  const status = localStatus ?? ticket?.status;

  const send = async () => {
    if (!body.trim()) return;
    const res = await replyMut.mutate(body.trim());
    if (res !== null) {
      setBody('');
      setLocalStatus(s => (s ?? ticket?.status) === 'open' ? 'in_progress' : (s ?? ticket?.status ?? null));
      refetch();
    } else toast.error(replyMut.error ?? 'Could not send reply.');
  };

  const changeStatus = async (next: string) => {
    const res = await statusMut.mutate(next);
    if (res !== null) setLocalStatus(next);
    else toast.error(statusMut.error ?? 'Could not update status.');
  };

  if (ticketsLoading || loading) return <Loading label="Loading ticket…" />;
  if (ticketsError) return <ErrorState message={ticketsError} />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  if (!ticket) return <ErrorState message="Ticket not found." />;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <Link to="/platform/support" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8rem', color: '#64748b', textDecoration: 'none', marginBottom: 6 }}>
            <ArrowLeft size={14} /> Back to support tickets
          </Link>
          <h1>{ticket.subject}</h1>
          <p>{ticket.tenant_name} · {categoryLabel(ticket.category)}</p>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <select value={status} onChange={e => changeStatus(e.target.value)} disabled={statusMut.pending}>
            {statusOptions.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
          {(messages ?? []).map(m => (
            <div key={m.id} style={{
              alignSelf: m.sender_type === 'admin' ? 'flex-end' : 'flex-start',
              maxWidth: '75%',
              background: m.sender_type === 'admin' ? '#eff6ff' : '#f8fafc',
              border: '1px solid ' + (m.sender_type === 'admin' ? '#dbeafe' : '#f1f5f9'),
              borderRadius: 10, padding: '0.7rem 0.85rem',
            }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 600, color: '#64748b', marginBottom: 2 }}>{m.sender_name}</div>
              <div style={{ fontSize: '0.9rem', whiteSpace: 'pre-wrap' }}>{m.body}</div>
              {(m.attachments ?? []).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem', marginTop: '0.5rem' }}>
                  {m.attachments!.map(a => <AttachmentLink key={a.id} path={a.storage_path} name={a.file_name} />)}
                </div>
              )}
              <div style={{ fontSize: '0.68rem', color: '#94a3b8', marginTop: 4 }}>{new Date(m.created_at).toLocaleString()}</div>
            </div>
          ))}
        </div>

        <div className="form-group">
          <label>Reply</label>
          <textarea rows={3} value={body} onChange={e => setBody(e.target.value)} placeholder="Type your reply…" />
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn-primary" onClick={send} disabled={replyMut.pending || !body.trim()}>
            <Send size={14} /> {replyMut.pending ? 'Sending…' : 'Send Reply'}
          </button>
        </div>
      </div>
    </div>
  );
}
