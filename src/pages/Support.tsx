import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, X, Paperclip } from 'lucide-react';
import { support, SupportTicket, SUPPORT_CATEGORIES, SupportCategory } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState, Empty } from '../components/DataStates';
import Modal from '../components/Modal';

const statusBadge: Record<string, string> = {
  open: 'badge-warning', in_progress: 'badge-primary', resolved: 'badge-success', closed: 'badge-gray',
};
const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find(x => x.id === c)?.label ?? c;

export default function Support() {
  const navigate = useNavigate();
  const toast = useToast();
  const { data: tickets, loading, error, refetch } = useQuery<SupportTicket[]>(() => support.myTickets(), []);
  const [creating, setCreating] = useState(false);

  return (
    <div>
      <div className="page-header">
        <div className="page-title"><h1>Support</h1><p>Something not working? Tell us and we'll help.</p></div>
        <button className="btn-primary" onClick={() => setCreating(true)}><Plus size={16} /> New Ticket</button>
      </div>

      {loading && <Loading label="Loading your tickets…" />}
      {error && <ErrorState message={error} onRetry={refetch} />}

      {!loading && !error && tickets && (
        tickets.length === 0 ? <Empty message="No support tickets yet. Filed one? It'll show up here." /> : (
          <div className="table-wrapper">
            <table>
              <thead><tr><th>Subject</th><th>Category</th><th>Status</th><th>Last Activity</th></tr></thead>
              <tbody>
                {tickets.map(t => (
                  <tr key={t.id} onClick={() => navigate(`/support/${t.id}`)} style={{ cursor: 'pointer' }}>
                    <td data-label="Subject"><strong>{t.subject}</strong></td>
                    <td data-label="Category">{categoryLabel(t.category)}</td>
                    <td data-label="Status"><span className={statusBadge[t.status]}>{t.status.replace('_', ' ')}</span></td>
                    <td data-label="Last Activity">{new Date(t.updated_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {creating && (
        <NewTicketModal
          onClose={() => setCreating(false)}
          onCreated={(id) => { setCreating(false); refetch(); toast.success('Ticket sent. We will get back to you soon.'); navigate(`/support/${id}`); }}
        />
      )}
    </div>
  );
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;

function NewTicketModal({ onClose, onCreated }: { onClose: () => void; onCreated: (ticketId: string) => void }) {
  const toast = useToast();
  const { tenant } = useAuth();
  const [subject, setSubject] = useState('');
  const [category, setCategory] = useState<SupportCategory>(SUPPORT_CATEGORIES[0].id);
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const createMut = useMutation((s: string, c: SupportCategory, b: string) => support.create(s, c, b));

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const picked = Array.from(list).filter(f => {
      if (f.size > MAX_FILE_BYTES) { toast.error(`${f.name} is over 8MB, skipped.`); return false; }
      return true;
    });
    setFiles(prev => [...prev, ...picked]);
  };

  const submit = async () => {
    if (!subject.trim() || !body.trim() || !tenant) return;
    const res = await createMut.mutate(subject.trim(), category, body.trim());
    if (res === null) { toast.error(createMut.error ?? 'Could not send your ticket.'); return; }
    for (const file of files) {
      try { await support.uploadAttachment(tenant.id, res.ticket.id, res.messageId, file); }
      catch { toast.error(`Could not attach ${file.name}.`); }
    }
    onCreated(res.ticket.id);
  };

  return (
    <Modal onClose={onClose} maxWidth={480}>
      <div className="modal-header">
        <h2>New Support Ticket</h2>
        <button className="close-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
      </div>
      <div className="modal-body">
        <div className="form-group">
          <label>What kind of issue is this?</label>
          <select value={category} onChange={e => setCategory(e.target.value as SupportCategory)}>
            {SUPPORT_CATEGORIES.map(c => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
        </div>
        <div className="form-group">
          <label>Short summary</label>
          <input value={subject} onChange={e => setSubject(e.target.value)} placeholder="What's the issue?" />
        </div>
        <div className="form-group">
          <label>Details</label>
          <textarea rows={4} value={body} onChange={e => setBody(e.target.value)} placeholder="Tell us what happened, and what you expected instead." />
        </div>
        <div className="form-group">
          <label>Attachments (optional, screenshots help)</label>
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
      </div>
      <div className="modal-footer">
        <button className="btn-secondary" onClick={onClose} disabled={createMut.pending}>Cancel</button>
        <button className="btn-primary" onClick={submit} disabled={createMut.pending || !subject.trim() || !body.trim()}>
          {createMut.pending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </Modal>
  );
}
