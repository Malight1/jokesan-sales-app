// ============================================================
// ProfixBook — "View as", for support: see the app exactly as one
// customer's team member sees it, without their password.
//
// Deploy from the Supabase dashboard (Edge Functions → New function
// → name it exactly "platform-impersonate") OR via CLI:
//   supabase functions deploy platform-impersonate
//
// No custom secret needed — same auto-injected vars as every other
// function here. SUPABASE_SERVICE_ROLE_KEY is what lets this mint a
// sign-in link for someone else's account; it never leaves this
// function.
//
// Safety, by design, not by convention:
//   - platform-admin only, checked against the CALLER's own JWT
//     (never a client-supplied flag) before anything else runs.
//   - every call is written to that business's OWN audit_logs as
//     'platform.impersonate' — visible on their Audit Log page, not
//     just the platform admin's side, so this is never a quiet action.
//   - Supabase's magic link is single-use and short-lived by design;
//     this hands back a URL, it never touches this browser's own
//     session, so the admin's own sign-in is untouched. The frontend
//     opens it in a NEW TAB for exactly that reason — see
//     platform.impersonate() in src/lib/api.ts.
//   - refuses a deactivated profile or one with no tenant (nothing to
//     view as) and a pure platform-admin account (nothing TO impersonate
//     into — it has no tenant of its own in the normal sense).
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
    const { profileId, reason } = await req.json() as { profileId?: string; reason?: string };
    if (!profileId) return json({ error: 'Missing profileId' }, 400);

    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Not authenticated' }, 401);

    const { data: isAdmin } = await callerClient.rpc('is_platform_admin');
    if (!isAdmin) return json({ error: 'Not authorised' }, 403);

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: target } = await admin.from('profiles')
      .select('id, tenant_id, full_name, email, is_active').eq('id', profileId).single();
    if (!target) return json({ error: 'Team member not found' }, 404);
    if (!target.tenant_id) return json({ error: 'This account has no business to view as' }, 400);
    if (!target.is_active) return json({ error: `${target.full_name || 'This team member'} is deactivated. Reactivate them first.` }, 400);
    if (!target.email) return json({ error: 'This team member has no email on file' }, 400);

    const { data: link, error: linkErr } = await admin.auth.admin.generateLink({
      type: 'magiclink',
      email: target.email,
    });
    if (linkErr || !link?.properties?.action_link) {
      return json({ error: linkErr?.message ?? 'Could not create a sign-in link.' }, 400);
    }

    // Left on the BUSINESS's own trail, not just the platform side — the
    // same reasoning every other platform.* action here follows.
    await admin.from('audit_logs').insert({
      tenant_id: target.tenant_id,
      user_id: userData.user.id,
      action: 'platform.impersonate',
      entity: 'profile',
      entity_id: target.id,
      meta: { viewed_as: target.full_name || target.email, reason: reason?.trim() || null },
    });

    return json({ url: link.properties.action_link, viewedAs: target.full_name || target.email });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
