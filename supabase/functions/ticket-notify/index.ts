// ============================================================
// ProfixBook — support ticket email notifications (Resend)
//
// Deploy from the Supabase dashboard (Edge Functions → New function
// → name it exactly "ticket-notify" → paste this) OR via CLI:
//   supabase functions deploy ticket-notify
//
// Secrets to set (Project Settings → Edge Functions → Secrets):
//   RESEND_API_KEY  — required. From resend.com (free tier is enough
//                     to start). Without it, this function no-ops —
//                     every caller treats it as best-effort and ignores
//                     the result, so a missing key never breaks a reply.
//   RESEND_FROM     — optional. Defaults to "ProfixBook Support
//                     <info@profixbook.com>", which only actually sends
//                     once profixbook.com is verified as a sending
//                     domain in the SAME Resend account as RESEND_API_KEY
//                     — until then, override this with Resend's own
//                     sandbox sender (onboarding@resend.dev), which only
//                     delivers to the Resend account's own email, enough
//                     to test the admin-side notification.
//   APP_URL         — optional. Defaults to https://www.profixbook.com.
//
// This is called fire-and-forget (.catch(() => {})) right after a
// ticket is opened or replied to — see support.create/reply and
// platform.replyTicket/openTicket in src/lib/api.ts. A failure here
// never blocks the reply itself from going through.
//
// Who gets emailed:
//   trigger 'ticket_opened' / 'tenant_reply' (the CUSTOMER wrote) →
//     every platform admin (platform_admins), so support hears about it
//     even if nobody has the app open.
//   trigger 'admin_reply' (SUPPORT wrote) →
//     the customer who filed the ticket (support_tickets.created_by),
//     falling back to that business's own admin if the filer's profile
//     is gone (e.g. deactivated).
//
// Authorization: the caller must be signed in AND either a member of
// the ticket's own business (for ticket_opened/tenant_reply) or a
// platform admin (for admin_reply) — checked with the caller's own JWT
// before any service-role lookup, so one tenant can't trigger emails
// about another tenant's ticket by guessing a ticket id.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

type Trigger = 'ticket_opened' | 'tenant_reply' | 'admin_reply';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { ticketId, trigger } = await req.json() as { ticketId?: string; trigger?: Trigger };
    if (!ticketId || !trigger) return json({ error: 'Missing ticketId or trigger' }, 400);
    if (!['ticket_opened', 'tenant_reply', 'admin_reply'].includes(trigger)) {
      return json({ error: 'Unknown trigger' }, 400);
    }

    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Not authenticated' }, 401);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: ticket } = await admin
      .from('support_tickets')
      .select('id, tenant_id, subject, created_by, tenants(name)')
      .eq('id', ticketId)
      .single();
    if (!ticket) return json({ error: 'Ticket not found' }, 404);

    if (trigger === 'admin_reply') {
      const { data: isAdmin } = await callerClient.rpc('is_platform_admin');
      if (!isAdmin) return json({ error: 'Not authorised' }, 403);
    } else {
      const { data: callerProfile } = await admin.from('profiles').select('tenant_id').eq('id', userData.user.id).single();
      if (!callerProfile || callerProfile.tenant_id !== ticket.tenant_id) return json({ error: 'Not authorised' }, 403);
    }

    const resendKey = Deno.env.get('RESEND_API_KEY');
    if (!resendKey) return json({ success: true, skipped: 'RESEND_API_KEY not set' });

    const from = Deno.env.get('RESEND_FROM') || 'ProfixBook Support <info@profixbook.com>';
    const appUrl = (Deno.env.get('APP_URL') || 'https://www.profixbook.com').replace(/\/$/, '');
    const tenantName = (ticket as any).tenants?.name ?? 'A business';

    const sendEmail = (to: string, subject: string, html: string) =>
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from, to, subject, html }),
      });

    // The message that triggered this, quoted in the email so the reader
    // can see what was said without opening the app first.
    const { data: latest } = await admin.from('support_ticket_messages')
      .select('body').eq('ticket_id', ticketId).order('created_at', { ascending: false }).limit(1).maybeSingle();
    const excerpt = (latest?.body ?? '').trim();
    const quote = excerpt
      ? `<div style="margin:0 0 24px; padding:14px 16px; background:#f8fafc; border-left:3px solid #2563eb; font-size:14px; line-height:1.6; color:#334155; white-space:pre-wrap;">${escapeHtml(excerpt.length > 600 ? excerpt.slice(0, 600) + '…' : excerpt)}</div>`
      : '';

    let sent = 0;
    if (trigger === 'admin_reply') {
      let email: string | null = null;
      if (ticket.created_by) {
        const { data: filer } = await admin.from('profiles').select('email').eq('id', ticket.created_by).single();
        email = filer?.email ?? null;
      }
      if (!email) {
        const { data: fallback } = await admin.from('profiles').select('email')
          .eq('tenant_id', ticket.tenant_id).eq('role', 'admin').limit(1).maybeSingle();
        email = fallback?.email ?? null;
      }
      if (email) {
        const res = await sendEmail(email, `ProfixBook Support replied: ${ticket.subject}`, emailShell({
          heading: 'Support replied to your ticket',
          intro: `On "<strong style="color:#0f172a;">${escapeHtml(ticket.subject)}</strong>":`,
          quote,
          href: `${appUrl}/support/${ticketId}`,
          cta: 'Reply in ProfixBook',
          footer: 'You get this because you opened a support ticket in ProfixBook.',
        }));
        if (res.ok) sent++;
      }
    } else {
      const { data: admins } = await admin.from('platform_admins').select('user_id');
      const verb = trigger === 'ticket_opened' ? 'opened a new ticket' : 'replied';
      for (const row of admins ?? []) {
        const { data: u } = await admin.auth.admin.getUserById(row.user_id);
        const email = u?.user?.email;
        if (!email) continue;
        const res = await sendEmail(email, `${tenantName} ${verb}: ${ticket.subject}`, emailShell({
          heading: trigger === 'ticket_opened' ? 'New support ticket' : 'A customer replied',
          intro: `<strong style="color:#0f172a;">${escapeHtml(tenantName)}</strong> ${verb} on "<strong style="color:#0f172a;">${escapeHtml(ticket.subject)}</strong>":`,
          quote,
          href: `${appUrl}/platform/support/${ticketId}`,
          cta: 'Open the ticket',
          footer: 'Sent to ProfixBook platform admins.',
        }));
        if (res.ok) sent++;
      }
    }

    return json({ success: true, sent });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

// Same layout as the auth emails in supabase/templates/ (dark header with
// the hosted logo PNG, white card, blue button), so every email from
// ProfixBook looks like it came from the same place.
function emailShell(o: { heading: string; intro: string; quote: string; href: string; cta: string; footer: string }): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9; padding:32px 16px; font-family:'Segoe UI', Arial, sans-serif;">
  <tr><td align="center">
    <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff; border-radius:12px; overflow:hidden;">
      <tr><td style="background:#0b1220; padding:28px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td style="width:34px; height:34px; vertical-align:middle;"><img src="https://www.profixbook.com/email-logo.png" width="34" height="34" alt="" style="display:block; border:0; border-radius:8px;"></td>
          <td style="padding-left:10px;"><span style="color:#ffffff; font-size:17px; font-weight:700; letter-spacing:-0.01em;">ProfixBook</span></td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:36px 32px 8px;">
        <h1 style="margin:0 0 12px; font-size:20px; font-weight:700; color:#0f172a;">${o.heading}</h1>
        <p style="margin:0 0 16px; font-size:14px; line-height:1.6; color:#475569;">${o.intro}</p>
        ${o.quote}
      </td></tr>
      <tr><td style="padding:0 32px 28px;">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="background:#2563eb; border-radius:8px;">
          <a href="${o.href}" style="display:inline-block; padding:12px 28px; font-size:14px; font-weight:600; color:#ffffff; text-decoration:none;">${o.cta}</a>
        </td></tr></table>
      </td></tr>
      <tr><td style="padding:20px 32px; border-top:1px solid #f1f5f9;">
        <p style="margin:0; font-size:12px; color:#94a3b8;">${o.footer}</p>
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
