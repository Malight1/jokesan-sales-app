import React, { useEffect, useRef, useState } from 'react';
import { Paperclip, Send, X } from 'lucide-react';
import { SupportTicketMessage } from '../lib/api';
import { useToast } from '../lib/ToastContext';
import TicketAttachment from './TicketAttachment';
import '../pages/Support.scss';

// The two halves of a support conversation, shared by the customer's
// ticket page and the admin's, so both sides read and write the same way.

const MAX_FILE_BYTES = 8 * 1024 * 1024;

export const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// "5m ago", "3h ago", "2d ago": how long someone has been waiting.
export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export function MessageList({ messages, isMine, nameOf }: {
  messages: SupportTicketMessage[];
  isMine: (m: SupportTicketMessage) => boolean;
  nameOf: (m: SupportTicketMessage) => string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // Land on the newest message, which is the one anyone opening a
  // ticket actually wants to read.
  useEffect(() => { endRef.current?.scrollIntoView({ block: 'nearest' }); }, [messages.length]);

  if (messages.length === 0) return <p className="sp-empty-thread">No messages yet.</p>;
  return (
    <div className="sp-thread" role="log" aria-label="Conversation">
      {messages.map(m => {
        const mine = isMine(m);
        return (
          <div key={m.id} className={`sp-msg ${mine ? 'is-mine' : 'is-theirs'}${m.sender_type === 'admin' ? ' is-support' : ''}`}>
            <div className="sp-msg-head">
              <strong>{nameOf(m)}</strong>
              <time dateTime={m.created_at}>{fmtWhen(m.created_at)}</time>
            </div>
            <div className="sp-msg-body">{m.body}</div>
            {(m.attachments ?? []).length > 0 && (
              <div className="sp-attachments">
                {m.attachments!.map(a => <TicketAttachment key={a.id} file={a} />)}
              </div>
            )}
          </div>
        );
      })}
      <div ref={endRef} />
    </div>
  );
}

export function Composer({ placeholder, pending, onSend, hint, extraActions, value, onChange }: {
  placeholder: string;
  pending: boolean;
  // Resolves true when the message went out, so the box can clear.
  onSend: (body: string, files: File[]) => Promise<boolean>;
  hint?: React.ReactNode;
  // Extra buttons beside Send (e.g. "Send and resolve" for support).
  extraActions?: (body: string, files: File[], reset: () => void) => React.ReactNode;
  // Optional control from outside, for inserting a quick reply.
  value?: string;
  onChange?: (v: string) => void;
}) {
  const toast = useToast();
  const [ownBody, setOwnBody] = useState('');
  const body = value ?? ownBody;
  const setBody = onChange ?? setOwnBody;
  const [files, setFiles] = useState<File[]>([]);
  const reset = () => { setBody(''); setFiles([]); };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const picked = Array.from(list).filter(f => {
      if (f.size > MAX_FILE_BYTES) { toast.error(`${f.name} is over 8MB, so it was left out.`); return false; }
      return true;
    });
    setFiles(prev => [...prev, ...picked]);
  };

  const send = async () => {
    if (!body.trim() || pending) return;
    if (await onSend(body.trim(), files)) reset();
  };

  return (
    <div className="sp-composer">
      <label htmlFor="sp-reply" className="sp-composer-label">Reply</label>
      <textarea
        id="sp-reply" rows={4} value={body} placeholder={placeholder}
        onChange={e => setBody(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } }}
      />
      {files.length > 0 && (
        <ul className="sp-files">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`}>
              <Paperclip size={12} /> <span>{f.name}</span>
              <button type="button" onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))} aria-label={`Remove ${f.name}`}>
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="sp-composer-actions">
        <label className="btn-secondary btn-sm sp-attach">
          <Paperclip size={14} /> Attach
          <input type="file" multiple accept="image/*,application/pdf" onChange={e => { addFiles(e.target.files); e.target.value = ''; }} />
        </label>
        <span className="sp-composer-hint">{hint ?? <>Ctrl + Enter to send</>}</span>
        {extraActions?.(body.trim(), files, reset)}
        <button type="button" className="btn-primary btn-sm" onClick={send} disabled={pending || !body.trim()}>
          <Send size={14} /> {pending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
