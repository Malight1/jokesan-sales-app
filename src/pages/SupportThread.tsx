import React, { useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Send, Paperclip, X, FileText } from 'lucide-react';
import { support, SupportTicket, SupportTicketMessage, SUPPORT_CATEGORIES } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from '../components/DataStates';

const statusBadge: Record<string, string> = {
  open: 'badge-warning', in_progress: 'badge-primary', resolved: 'badge-success', closed: 'badge-gray',
};
const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find(x => x.id === c)?.label ?? c;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

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

export default function SupportThread() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { tenant } = useAuth();
  const ticketQ = useQuery<SupportTicket>(() => support.ticket(id!), [id]);
  const { data: messages, loading, error, refetch } = useQuery<SupportTicketMessage[]>(() => support.myThread(id!), [id]);
  const replyMut = useMutation((body: string) => support.reply(id!, body));
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const picked = Array.from(list).filter(f => {
      if (f.size > MAX_FILE_BYTES) { toast.error(`${f.name} is over 8MB, skipped.`); return false; }
      return true;
    });
    setFiles(prev => [...prev, ...picked]);
  };

  const send = async () => {
    if (!body.trim() || !tenant) return;
    const messageId = await replyMut.mutate(body.trim());
    if (messageId === null) { toast.error(replyMut.error ?? 'Could not send your reply.'); return; }
    for (const file of files) {
      try { await support.uploadAttachment(tenant.id, id!, messageId, file); }
      catch { toast.error(`Could not attach ${file.name}.`); }
    }
    setBody('');
    setFiles([]);
    refetch();
  };

  if (ticketQ.loading || loading) return <Loading label="Loading ticket…" />;
  if (ticketQ.error) return <ErrorState message={ticketQ.error} onRetry={ticketQ.refetch} />;
  if (error) return <ErrorState message={error} onRetry={refetch} />;
  const ticket = ticketQ.data;
  if (!ticket) return null;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <Link to="/support" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: '0.8rem', color: '#64748b', textDecoration: 'none', marginBottom: 6 }}>
            <ArrowLeft size={14} /> Back to support
          </Link>
          <h1>{ticket.subject}</h1>
          <p>{categoryLabel(ticket.category)} · <span className={statusBadge[ticket.status]}>{ticket.status.replace('_', ' ')}</span></p>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem', marginBottom: '1.25rem' }}>
          {(messages ?? []).map(m => (
            <div key={m.id} style={{
              alignSelf: m.sender_type === 'tenant' ? 'flex-end' : 'flex-start',
              maxWidth: '75%',
              background: m.sender_type === 'tenant' ? '#eff6ff' : '#f8fafc',
              border: '1px solid ' + (m.sender_type === 'tenant' ? '#dbeafe' : '#f1f5f9'),
              borderRadius: 10, padding: '0.7rem 0.85rem',
            }}>
              <div style={{ fontSize: '0.72rem', fontWeight: 600, color: '#64748b', marginBottom: 2 }}>
                {m.sender_type === 'admin' ? 'StockFlow Support' : 'You'}
              </div>
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
          <textarea rows={3} value={body} onChange={e => setBody(e.target.value)} placeholder="Add more detail…" />
        </div>
        <div className="form-group">
          <label className="btn-secondary btn-sm" style={{ display: 'inline-flex', width: 'fit-content', cursor: 'pointer' }}>
            <Paperclip size={14} /> Add files
            <input type="file" multiple accept="image/*,application/pdf" style={{ display: 'none' }}
              onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
          </label>
          {files.length > 0 && (
            <ul style={{ fontSize: '0.8rem', color: '#64748b', marginTop: '0.5rem', paddingLeft: '1.1rem' }}>
              {files.map((f, i) => (
                <li key={i} style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
                  {f.name}
                  <button type="button" onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}
                    style={{ border: 'none', background: 'none', color: '#dc2626', cursor: 'pointer', padding: 0 }}>
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn-primary" onClick={send} disabled={replyMut.pending || !body.trim()}>
            <Send size={14} /> {replyMut.pending ? 'Sending…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}
