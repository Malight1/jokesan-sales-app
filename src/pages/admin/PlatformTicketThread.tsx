import React, { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, KeyRound, MailCheck, UserCheck, CalendarClock, RotateCcw, MessageCircle, Phone, AlertTriangle, Eye } from 'lucide-react';
import {
  platform, SupportTicket, SupportTicketMessage, SUPPORT_CATEGORIES,
  PlatformSnapshot, PlatformSnapshotUser, PlatformTenantDetail,
} from '../../lib/api';
import { useQuery, useMutation } from '../../lib/hooks';
import { useToast } from '../../lib/ToastContext';
import { whatsappLink } from '../../lib/whatsapp';
import { Loading, ErrorState } from '../../components/DataStates';
import PlatformGate from '../../components/PlatformGate';
import ConfirmDialog from '../../components/ConfirmDialog';
import { MessageList, Composer, ago } from '../../components/SupportConversation';
import '../Support.scss';

const statusOptions = [
  { id: 'open', label: 'Open' },
  { id: 'in_progress', label: 'In progress' },
  { id: 'resolved', label: 'Resolved' },
  { id: 'closed', label: 'Closed' },
] as const;
const categoryLabel = (c: string) => SUPPORT_CATEGORIES.find(x => x.id === c)?.label ?? c;
const fmtDate = (d: string | null | undefined) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never';

// The replies support sends over and over. Inserted into the box, never
// sent on their own, so each one can be adjusted first.
const QUICK_REPLIES: { label: string; text: string }[] = [
  { label: 'Looking into it', text: "Thanks for letting us know. I'm looking into this now and will get back to you shortly." },
  { label: 'Ask for a screenshot', text: "Could you send a screenshot of what you're seeing? Tap Attach under the reply box. It helps us find the problem much faster." },
  { label: 'Password reset sent', text: "I've just sent a password reset link to your email. Open it, choose a new password, and you'll be signed straight in. If it isn't there in a few minutes, check your spam folder." },
  { label: 'Confirmation resent', text: "I've sent you a fresh confirmation link. Click it, then sign in as normal. Check your spam folder if you can't see it." },
  { label: 'Trial extended', text: "I've extended your trial, so you can keep working and saving straight away." },
  { label: 'Fixed, please refresh', text: 'This is fixed on our side. Please refresh the page (or close and reopen the app) and try again, then let me know.' },
  { label: 'Closing', text: "Glad that's sorted. I'll mark this resolved, but just reply here if anything else comes up and it will reopen." },
];

const accessText: Record<string, string> = {
  suspended: 'This business is suspended. Nobody on the team can sign in.',
  trial_expired: 'Their trial has ended, so the app is read-only. They can look but not save.',
  plan_expired: 'Their plan has expired, so the app is read-only. They can look but not save.',
};

export default function PlatformTicketThread() {
  return <PlatformGate><ThreadPanel /></PlatformGate>;
}

function ThreadPanel() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const ticketQ = useQuery<SupportTicket | null>(() => platform.ticket(id!), [id]);
  const messagesQ = useQuery<SupportTicketMessage[]>(() => platform.ticketMessages(id!), [id]);
  const ticket = ticketQ.data;
  const tenantId = ticket?.tenant_id;

  const replyMut = useMutation((body: string) => platform.replyTicket(id!, body));
  const statusMut = useMutation((status: string) => platform.updateTicketStatus(id!, status));
  const [draft, setDraft] = useState('');

  // Mark it read once it's actually been opened.
  useEffect(() => {
    if (ticket?.unread) platform.markTicketSeen(ticket.id).catch(() => {});
  }, [ticket?.id, ticket?.unread]);

  // New messages arrive without anyone refreshing: check every 30s while
  // the tab is in view.
  useEffect(() => {
    const t = window.setInterval(() => {
      if (document.visibilityState === 'visible') { messagesQ.refetch(); ticketQ.refetch(); }
    }, 30000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const send = async (body: string, files: File[], resolveAfter = false): Promise<boolean> => {
    const messageId = await replyMut.mutate(body);
    if (messageId === null || !ticket) { toast.error(replyMut.error ?? 'Could not send the reply.'); return false; }
    for (const file of files) {
      try { await platform.uploadTicketAttachment(ticket.tenant_id, ticket.id, messageId, file); }
      catch (e: any) { toast.error(`Sent, but ${file.name} couldn't be attached: ${e?.message ?? 'unknown error'}`); }
    }
    if (resolveAfter) await statusMut.mutate('resolved');
    toast.success(resolveAfter ? 'Reply sent and ticket resolved.' : 'Reply sent.');
    messagesQ.refetch();
    ticketQ.refetch();
    return true;
  };

  const changeStatus = async (next: string) => {
    const res = await statusMut.mutate(next);
    if (res !== null) { ticketQ.refetch(); toast.success(`Marked ${statusOptions.find(s => s.id === next)?.label.toLowerCase()}.`); }
    else toast.error(statusMut.error ?? 'Could not update the status.');
  };

  if (ticketQ.loading || messagesQ.loading) return <Loading label="Loading ticket…" />;
  if (ticketQ.error) return <ErrorState message={ticketQ.error} onRetry={ticketQ.refetch} />;
  if (messagesQ.error) return <ErrorState message={messagesQ.error} onRetry={messagesQ.refetch} />;
  if (!ticket) return <ErrorState message="This ticket doesn't exist, or was deleted with its business." />;

  const finished = ticket.status === 'resolved' || ticket.status === 'closed';

  return (
    <div>
      <div className="page-header">
        <div className="page-title">
          <Link to="/platform/support" className="sp-back"><ArrowLeft size={14} /> All tickets</Link>
          <h1>{ticket.subject}</h1>
          <div className="sp-meta">
            <Link to={`/platform/tenants/${ticket.tenant_id}`}>{ticket.tenant_name}</Link>
            <span>· {categoryLabel(ticket.category)}</span>
            <span>· opened {fmtDate(ticket.created_at)}</span>
            {ticket.awaiting_reply && <span className="sp-turn is-you">· Waiting on you {ago(ticket.last_message_at)}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexWrap: 'wrap' }}>
          <select aria-label="Ticket status" value={ticket.status} onChange={e => changeStatus(e.target.value)} disabled={statusMut.pending}
                  style={{ padding: '0.45rem 0.6rem', border: '1px solid #cbd5e1', borderRadius: 8, fontSize: '0.875rem', fontFamily: 'inherit' }}>
            {statusOptions.map(s => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
          {!finished && (
            <button className="btn-secondary btn-sm" onClick={() => changeStatus('resolved')} disabled={statusMut.pending}>
              <CheckCircle2 size={14} /> Mark resolved
            </button>
          )}
        </div>
      </div>

      <div className="sp-layout">
        <div className="sp-main">
          <MessageList
            messages={messagesQ.data ?? []}
            isMine={m => m.sender_type === 'admin'}
            nameOf={m => m.sender_type === 'admin' ? 'You (ProfixBook Support)' : (m.sender_name ?? 'Customer')}
          />
          <Composer
            placeholder={finished ? 'Write a reply. The customer will still see it on their ticket.' : 'Write your reply…'}
            pending={replyMut.pending || statusMut.pending}
            value={draft}
            onChange={setDraft}
            onSend={(body, files) => send(body, files)}
            hint={
              <span className="sp-quick">
                <select aria-label="Insert a quick reply" value=""
                        onChange={e => {
                          const q = QUICK_REPLIES.find(r => r.label === e.target.value);
                          if (q) setDraft(d => (d.trim() ? `${d.trim()}\n\n${q.text}` : q.text));
                        }}>
                  <option value="">Quick reply…</option>
                  {QUICK_REPLIES.map(r => <option key={r.label} value={r.label}>{r.label}</option>)}
                </select>
              </span>
            }
            extraActions={(body, files, reset) => !finished && (
              <button type="button" className="btn-secondary btn-sm" disabled={!body || replyMut.pending || statusMut.pending}
                      onClick={async () => { if (await send(body, files, true)) reset(); }}>
                <CheckCircle2 size={14} /> Send and resolve
              </button>
            )}
          />
        </div>

        {tenantId && <BusinessPanel tenantId={tenantId} ticket={ticket} />}
      </div>
    </div>
  );
}

// ---- Everything about the business, and the fixes, beside the conversation ----
function BusinessPanel({ tenantId, ticket }: { tenantId: string; ticket: SupportTicket }) {
  const toast = useToast();
  const detailQ = useQuery<PlatformTenantDetail>(() => platform.tenantDetail(tenantId), [tenantId]);
  const snapQ = useQuery<PlatformSnapshot>(() => platform.snapshot(tenantId), [tenantId]);
  const othersQ = useQuery<SupportTicket[]>(() => platform.tickets(undefined, tenantId), [tenantId]);

  const extendMut = useMutation((days: number) => platform.extendTrial(tenantId, days));
  const activeMut = useMutation(() => platform.setActive(tenantId, true));
  const profileMut = useMutation((profileId: string) => platform.setProfileActive(profileId, true));
  const [busy, setBusy] = useState<string | null>(null);
  const [viewAsTarget, setViewAsTarget] = useState<PlatformSnapshotUser | null>(null);
  const impersonateMut = useMutation((profileId: string) => platform.impersonate(profileId));

  const refresh = () => { detailQ.refetch(); snapQ.refetch(); };

  const confirmViewAs = async () => {
    if (!viewAsTarget) return;
    const res = await impersonateMut.mutate(viewAsTarget.id);
    setViewAsTarget(null);
    if (res) {
      // A new tab, never this one — the admin's own session must stay theirs.
      window.open(res.url, '_blank', 'noopener');
      toast.success(`Opened a new tab signed in as ${res.viewedAs}. Logged on their Audit Log.`);
    } else {
      toast.error(impersonateMut.error ?? 'Could not create a sign-in link.');
    }
  };

  const run = async (key: string, fn: () => Promise<any>, ok: string) => {
    setBusy(key);
    try {
      const res = await fn();
      if (res === null) throw new Error();
      toast.success(ok);
      refresh();
    } catch (e: any) {
      toast.error(e?.message || 'That didn\'t work. Try again.');
    } finally { setBusy(null); }
  };

  const sendReset = (u: PlatformSnapshotUser) => u.email && run(`reset:${u.id}`,
    () => platform.sendPasswordReset(tenantId, u.email!), `Password reset link sent to ${u.email}.`);
  const resendConfirm = (u: PlatformSnapshotUser) => u.email && run(`confirm:${u.id}`,
    async () => { await platform.resendConfirmation(u.email!); await platform.logConfirmationResent(tenantId, u.email!); },
    `New confirmation link sent to ${u.email}.`);

  if (detailQ.loading || snapQ.loading) {
    return <aside className="sp-side"><div className="sp-panel"><Loading label="Loading business…" /></div></aside>;
  }
  if (detailQ.error || snapQ.error) {
    return (
      <aside className="sp-side">
        <div className="sp-panel">
          <ErrorState message={detailQ.error ?? snapQ.error ?? 'Could not load this business.'} onRetry={refresh} />
        </div>
      </aside>
    );
  }
  const t = detailQ.data?.tenant ?? {};
  const snap = snapQ.data!;
  const filer = snap.users.find(u => u.id === ticket.created_by);
  const others = (othersQ.data ?? []).filter(o => o.id !== ticket.id).slice(0, 5);
  const issues = snap.stock_issues.length;

  const Person = ({ u, highlight }: { u: PlatformSnapshotUser; highlight?: boolean }) => (
    <div className="sp-person">
      <div className="sp-person-name">
        <span>{u.full_name || u.email || 'Unnamed'}{highlight ? ' (filed this)' : ''}</span>
        <span className="badge-gray" style={{ textTransform: 'capitalize' }}>{u.role}</span>
      </div>
      <div className="sp-person-sub">
        {u.email && <a href={`mailto:${u.email}`}>{u.email}</a>}
        {u.phone && <> · {u.phone}</>}
      </div>
      <div className="sp-person-flags">
        {!u.is_active && <span className="badge-danger">Deactivated</span>}
        {!u.email_confirmed_at && <span className="badge-warning">Email not confirmed</span>}
        <span className="badge-gray">{u.last_sign_in_at ? `Signed in ${ago(u.last_sign_in_at)}` : 'Never signed in'}</span>
      </div>
      <div className="sp-person-actions">
        {u.email && (
          <button className="sp-mini-btn" onClick={() => sendReset(u)} disabled={!!busy}>
            <KeyRound size={12} /> {busy === `reset:${u.id}` ? 'Sending…' : 'Send password reset'}
          </button>
        )}
        {u.email && !u.email_confirmed_at && (
          <button className="sp-mini-btn" onClick={() => resendConfirm(u)} disabled={!!busy}>
            <MailCheck size={12} /> {busy === `confirm:${u.id}` ? 'Sending…' : 'Resend confirmation'}
          </button>
        )}
        {!u.is_active && (
          <button className="sp-mini-btn" disabled={!!busy}
                  onClick={() => run(`active:${u.id}`, () => profileMut.mutate(u.id), `${u.full_name || u.email} can sign in again.`)}>
            <UserCheck size={12} /> Reactivate
          </button>
        )}
        {u.phone && (
          <a className="sp-mini-btn" href={whatsappLink(u.phone, `Hi ${u.full_name?.split(' ')[0] ?? ''}, this is ProfixBook Support about "${ticket.subject}".`)}
             target="_blank" rel="noopener noreferrer">
            <MessageCircle size={12} /> WhatsApp
          </a>
        )}
        {u.phone && <a className="sp-mini-btn" href={`tel:${u.phone.replace(/\s+/g, '')}`}><Phone size={12} /> Call</a>}
        {u.is_active && u.email && (
          <button className="sp-mini-btn" onClick={() => setViewAsTarget(u)} disabled={!!busy || impersonateMut.pending}>
            <Eye size={12} /> View as
          </button>
        )}
      </div>
    </div>
  );

  return (
    <aside className="sp-side" aria-label="About this business">
      <div className="sp-panel">
        <h3>Business <Link to={`/platform/tenants/${tenantId}`}>Open</Link></h3>
        {snap.access.can_write ? (
          <div className="sp-alert is-good"><span>Account is live. They can sign in and save.</span></div>
        ) : (
          <div className={`sp-alert ${snap.access.reason === 'suspended' ? 'is-bad' : 'is-warn'}`}>
            <span><strong>Can't save:</strong> {accessText[snap.access.reason ?? ''] ?? 'Their account is read-only.'}</span>
            {snap.access.reason === 'suspended' && (
              <button className="sp-mini-btn is-primary" disabled={!!busy}
                      onClick={() => run('activate', () => activeMut.mutate(), `${t.name} is active again.`)}>
                <RotateCcw size={12} /> Reactivate business
              </button>
            )}
            {snap.access.reason === 'trial_expired' && (
              <button className="sp-mini-btn is-primary" disabled={!!busy}
                      onClick={() => run('extend', () => extendMut.mutate(7), 'Trial extended by 7 days.')}>
                <CalendarClock size={12} /> Extend trial 7 days
              </button>
            )}
            {snap.access.reason === 'plan_expired' && (
              <Link className="sp-mini-btn is-primary" to={`/platform/tenants/${tenantId}`}>Change their plan</Link>
            )}
          </div>
        )}
        <dl className="sp-kv">
          <dt>Plan</dt><dd style={{ textTransform: 'capitalize' }}>{t.plan}</dd>
          <dt>{t.plan === 'trial' ? 'Trial ends' : 'Renews'}</dt>
          <dd>{fmtDate(t.plan === 'trial' ? t.trial_ends_at : t.plan_expires_at)}</dd>
          <dt>Type</dt><dd style={{ textTransform: 'capitalize' }}>{t.business_type ?? 'manufacturing'}</dd>
          <dt>Branches</dt><dd>{snap.counts.branches}</dd>
          <dt>Products</dt><dd>{snap.counts.products}{snap.counts.materials ? ` + ${snap.counts.materials} materials` : ''}</dd>
          <dt>Sales</dt><dd>{snap.counts.sales.toLocaleString()}</dd>
          <dt>Last sale</dt><dd>{snap.last_sale_at ? ago(snap.last_sale_at) : 'None yet'}</dd>
          <dt>Last active</dt><dd>{snap.last_activity_at ? ago(snap.last_activity_at) : 'Unknown'}</dd>
        </dl>
        {issues > 0 && (
          <div className="sp-alert is-bad" style={{ marginTop: '0.75rem', marginBottom: 0 }}>
            <span><AlertTriangle size={13} style={{ verticalAlign: '-2px' }} /> <strong>{issues} {issues === 1 ? 'product has' : 'products have'} stock that doesn't add up.</strong></span>
            <Link className="sp-mini-btn" to={`/platform/tenants/${tenantId}#diagnostics`}>See which</Link>
          </div>
        )}
      </div>

      <div className="sp-panel">
        <h3>{filer ? 'Who filed it' : 'Team'}</h3>
        {filer && <Person u={filer} highlight />}
        {!filer && ticket.created_by == null && (
          <p style={{ fontSize: '0.78rem', color: '#64748b', marginBottom: '0.5rem' }}>Support started this conversation.</p>
        )}
        {snap.users.filter(u => u.id !== filer?.id).slice(0, filer ? 3 : 6).map(u => <Person key={u.id} u={u} />)}
      </div>

      {viewAsTarget && (
        <ConfirmDialog
          title="View as this team member"
          danger={false}
          message={
            <>
              Opens a new tab signed in as <strong>{viewAsTarget.full_name || viewAsTarget.email}</strong>, so you see exactly
              what they see. Your own tab stays signed in as you. This is recorded on {t.name ?? 'their'}'s own Audit Log,
              visible to them.
            </>
          }
          confirmLabel="Open in a new tab"
          pending={impersonateMut.pending}
          onConfirm={confirmViewAs}
          onCancel={() => setViewAsTarget(null)}
        />
      )}

      {others.length > 0 && (
        <div className="sp-panel">
          <h3>Their other tickets</h3>
          <div className="sp-links">
            {others.map(o => (
              <Link key={o.id} to={`/platform/support/${o.id}`}>
                <strong>{o.subject}</strong>
                <span>{o.status.replace('_', ' ')} · {ago(o.last_message_at ?? o.updated_at)}{o.awaiting_reply ? ' · waiting on you' : ''}</span>
              </Link>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
