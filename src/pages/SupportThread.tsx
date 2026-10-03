import React, { useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { support, SupportTicket, SupportTicketMessage, SUPPORT_CATEGORIES } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useQuery, useMutation } from '../lib/hooks';
import { useToast } from '../lib/ToastContext';
import { Loading, ErrorState } from '../components/DataStates';
import { MessageList, Composer } from '../components/SupportConversation';
import './Support.scss';

const statusBadge: Record<string, string> = {
  open: 'badge-warning', in_progress: 'badge-primary', resolved: 'badge-success', closed: 'badge-gray',
};
const statusLabel: Record<string, string> = {
  open: 'Open', in_progress: 'In progress', resolved: 'Resolved', closed: 'Closed',
};
const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find(x => x.id === c)?.label ?? c;

export default function SupportThread() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { tenant, profile } = useAuth();
  const ticketQ = useQuery<SupportTicket>(() => support.ticket(id!), [id]);
  const messagesQ = useQuery<SupportTicketMessage[]>(() => support.myThread(id!), [id]);
  const replyMut = useMutation((body: string) => support.reply(id!, body));

  // Opening the ticket is reading the reply: clears the sidebar badge.
  useEffect(() => {
    if (ticketQ.data?.tenant_unread) support.markSeen(ticketQ.data.id);
  }, [ticketQ.data?.id, ticketQ.data?.tenant_unread]);

  // Support's answer shows up without a refresh.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') { messagesQ.refetch(); ticketQ.refetch(); }
    }, 30000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const send = async (body: string, files: File[]): Promise<boolean> => {
    if (!tenant) return false;
    const messageId = await replyMut.mutate(body);
    if (messageId === null) { toast.error(replyMut.error ?? 'Could not send your reply.'); return false; }
    for (const file of files) {
      try { await support.uploadAttachment(tenant.id, id!, messageId, file); }
      catch { toast.error(`Your message was sent, but ${file.name} couldn't be attached.`); }
    }
    messagesQ.refetch();
    ticketQ.refetch();
    return true;
  };

  if (ticketQ.loading || messagesQ.loading) return <Loading label="Loading ticket…" />;
  if (ticketQ.error) return <ErrorState message={ticketQ.error} onRetry={ticketQ.refetch} />;
  if (messagesQ.error) return <ErrorState message={messagesQ.error} onRetry={messagesQ.refetch} />;
  const ticket = ticketQ.data;
  if (!ticket) return null;
  const finished = ticket.status === 'resolved' || ticket.status === 'closed';
  const theirTurn = ticket.last_sender === 'tenant' && !finished;

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <Link to="/support" className="sp-back"><ArrowLeft size={14} /> All tickets</Link>
          <h1>{ticket.subject}</h1>
          <div className="sp-meta">
            <span className={statusBadge[ticket.status]}>{statusLabel[ticket.status] ?? ticket.status}</span>
            <span>{categoryLabel(ticket.category)}</span>
            {theirTurn && <span className="sp-turn is-them">· We'll reply here soon</span>}
          </div>
        </div>
      </div>

      <div className="sp-main" style={{ maxWidth: '52rem' }}>
        <MessageList
          messages={messagesQ.data ?? []}
          isMine={m => m.sender_type === 'tenant'}
          nameOf={m => m.sender_type === 'admin' ? 'ProfixBook Support'
            // A teammate can reply on the same ticket; only your own say "You".
            : (m as any).sender_id && (m as any).sender_id !== profile?.id ? 'A teammate' : 'You'}
        />
        <Composer
          placeholder={finished ? 'Still having trouble? Reply and this ticket reopens.' : 'Add more detail, or reply to support…'}
          pending={replyMut.pending}
          onSend={send}
          hint={finished ? <>Replying reopens this ticket</> : undefined}
        />
      </div>
    </div>
  );
}
