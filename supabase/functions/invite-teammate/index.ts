// ============================================================
// ProfixBook — email a teammate their join link (Supabase Edge Function)
//
// Deploy from the Supabase dashboard (Edge Functions → invite-teammate →
// replace the code with this) or with the CLI:
//   supabase functions deploy invite-teammate
// Keep "Enforce JWT verification" ON: only a signed-in admin calls this.
//
// Secrets (Project Settings → Edge Functions → Secrets):
//   RESEND_API_KEY  required. From resend.com. The same key ticket-notify
//                   uses. Without it nothing is emailed and the app tells
//                   the admin to send the link on WhatsApp instead.
//   RESEND_FROM     optional. Defaults to "ProfixBook <info@profixbook.com>".
//                   That address only sends once profixbook.com is a
//                   verified domain in the same Resend account.
//   APP_URL         optional. Defaults to https://www.profixbook.com.
//
// Why not Supabase's own invite email: without custom SMTP, Supabase only
// delivers to addresses on the Supabase project's own team, at 2 emails
// an hour, so a real staff member's inbox never got anything. This sends
// the /join/<invite id> link (migration 0053) through Resend instead, and
// returns the real reason when it can't, so the app never pretends.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ROLE_NAME: Record<string, string> = { admin: 'Admin', sales: 'Sales', inventory: 'Inventory', accounts: 'Accounts' };

// Only ever link to ProfixBook itself (or a local dev server), whatever
// origin the browser sent.
function appUrl(requested: unknown): string {
  const fallback = (Deno.env.get('APP_URL') ?? 'https://www.profixbook.com').replace(/\/$/, '');
  const r = typeof requested === 'string' ? requested.replace(/\/$/, '') : '';
  if (/^https:\/\/(www\.)?profixbook\.com$/.test(r) || /^http:\/\/localhost(:\d+)?$/.test(r)) return r;
  return fallback;
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

export function inviteEmail(company: string, role: string, link: string, inviter: string | null) {
  const roleName = ROLE_NAME[role] ?? role;
  const subject = `Join ${company} on ProfixBook`;
  const text = [
    `Hello,`,
    ``,
    `${inviter ? `${inviter} has` : 'You have been'} added you to ${company} on ProfixBook as ${roleName}.`,
    ``,
    `Open this link to choose your password and join:`,
    link,
    ``,
    `The link works once. Please don't use "Create Account" on the sign-in page, that makes a separate business.`,
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;color:#0f172a">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="padding:32px 12px"><tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e2e8f0;border-radius:12px">
      <tr><td style="padding:28px 28px 8px;font-size:20px;font-weight:700">Join ${esc(company)}</td></tr>
      <tr><td style="padding:0 28px 20px;font-size:15px;line-height:1.6;color:#334155">
        ${inviter ? `${esc(inviter)} has` : 'You have been'} added you to <strong>${esc(company)}</strong> on ProfixBook as <strong>${esc(roleName)}</strong>.
        Tap the button, choose a password, and you're in.
      </td></tr>
      <tr><td style="padding:0 28px 24px"><a href="${esc(link)}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;padding:12px 22px;border-radius:8px">Join ${esc(company)}</a></td></tr>
      <tr><td style="padding:0 28px 24px;font-size:13px;line-height:1.6;color:#64748b">
        If the button doesn't work, copy this link into your browser:<br><a href="${esc(link)}" style="color:#2563eb;word-break:break-all">${esc(link)}</a><br><br>
        The link works once. Please don't use "Create Account" on the sign-in page, that makes a separate business.
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  return { subject, text, html };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { inviteId, appUrl: requestedUrl } = await req.json();
    if (!inviteId) return json({ error: 'Missing invite.' });

    // 1) The caller must be a signed-in admin. Checked with their own JWT.
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Please sign in again.' });

    const { data: me } = await callerClient
      .from('profiles').select('role, tenant_id, full_name').eq('id', userData.user.id).single();
    if (!me || me.role !== 'admin') return json({ error: 'Only an admin can invite teammates.' });

    // 2) The invite must belong to the caller's own business and still be open.
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: invite } = await admin
      .from('staff_invites').select('id, email, role, status, tenant_id, tenants(name)')
      .eq('id', inviteId).single();
    if (!invite || invite.tenant_id !== me.tenant_id) return json({ error: 'Invite not found.' });
    if (invite.status !== 'pending') return json({ error: 'This invite has already been used.' });

    // 3) Send it.
    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) {
      return json({ error: 'Email sending is not set up for ProfixBook yet.', code: 'no_email_provider' });
    }
    const company = (invite as any).tenants?.name ?? 'your company';
    const link = `${appUrl(requestedUrl)}/join/${invite.id}`;
    const { subject, text, html } = inviteEmail(company, invite.role, link, me.full_name ?? null);

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: Deno.env.get('RESEND_FROM') ?? 'ProfixBook <info@profixbook.com>',
        to: [invite.email],
        subject, text, html,
      }),
    });
    if (!res.ok) {
      let reason = `status ${res.status}`;
      try { const b = await res.json(); reason = b?.message ?? b?.error ?? reason; } catch { /* keep status */ }
      return json({ error: `The email service refused it: ${reason}`, code: 'provider_error' });
    }
    const sent = await res.json().catch(() => ({}));
    return json({ success: true, id: sent?.id ?? null, to: invite.email });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
});

// Always 200 with {error} on failure, so supabase.functions.invoke hands
// the real message to the app instead of a generic "non-2xx" error.
function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
}
