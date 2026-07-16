// ============================================================
// StockFlow — real invite email (Supabase Edge Function)
//
// Deploy from the Supabase dashboard (Edge Functions → New function
// → name it "invite-teammate" → paste this) OR via CLI:
//   supabase functions deploy invite-teammate
//
// No custom secret to set — SUPABASE_URL, SUPABASE_ANON_KEY, and
// SUPABASE_SERVICE_ROLE_KEY are auto-injected into every Edge Function.
// The service-role key is what lets us call the privileged
// auth.admin.inviteUserByEmail — it must NEVER be used client-side.
//
// Flow: admin clicks "Invite User" in Settings → a staff_invites row
// is created (existing flow, unchanged) → this function is called
// best-effort to also send a real Supabase invite email. If it fails
// (rate limit, etc.) the invite still exists — the admin's
// "Copy Invite Message" button is the fallback so nothing is lost.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { email, redirectTo, role, tenantName } = await req.json();
    if (!email) return json({ error: 'Missing email' }, 400);

    // 1) Confirm the CALLER is an authenticated admin — never trust a
    //    client-supplied "I am admin" flag, check their JWT-scoped row.
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Not authenticated' }, 401);

    const { data: profile, error: profErr } = await callerClient
      .from('profiles').select('role').eq('id', userData.user.id).single();
    if (profErr || !profile || profile.role !== 'admin') {
      return json({ error: 'Only an admin can invite teammates' }, 403);
    }

    // 2) Send the real invite email via the privileged admin API
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectTo || undefined,
      data: { tenant_name: tenantName || 'your company', role: role || 'team member' },
    });
    if (inviteErr) return json({ error: inviteErr.message }, 400);

    return json({ success: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
