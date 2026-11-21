// ============================================================
// ProfixBook — join a team from an invite link (Supabase Edge Function)
//
// Deploy from the Supabase dashboard (Edge Functions → New function →
// name it exactly "accept-invite" → paste this), or with the CLI:
//   supabase functions deploy accept-invite --no-verify-jwt
// It must accept calls WITHOUT a signed-in user (the invitee has no
// account yet), so turn OFF "Enforce JWT verification" for it.
//
// No custom secret: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are
// injected automatically. Needs migration 0053 (invite_claim_existing).
//
// Flow: the invitee opens /join/<invite id>, types their name and a
// password, and the page calls this. We create an account that is
// already email-confirmed, so nothing depends on an email arriving.
// handle_new_user() attaches the account to the business, same as a
// normal invited sign-up. The page then signs them in with the password.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { inviteId, fullName, password } = await req.json();
    if (!inviteId || !UUID.test(String(inviteId))) return json({ error: 'This invite link is not valid.' });
    if (!password || String(password).length < 6) return json({ error: 'Password must be at least 6 characters.' });
    const name = String(fullName ?? '').trim().slice(0, 120);
    if (!name) return json({ error: 'Enter your name.' });

    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
      { auth: { persistSession: false } },
    );

    const { data: claim, error: claimErr } = await admin.rpc('invite_claim_existing', { p_invite: inviteId });
    if (claimErr) return json({ error: 'Could not check this invite. Please try again.' });

    const state = claim?.state as string | undefined;

    if (state === 'no_invite') {
      return json({ error: 'This invite has been used or cancelled. Ask whoever invited you to send a new link.', code: 'no_invite' });
    }
    if (state === 'other_tenant') {
      return json({ error: 'This email already belongs to another business on ProfixBook. Ask your admin to invite a different email.', code: 'other_tenant' });
    }
    if (state === 'has_password') {
      return json({ error: 'You already have a password for this account. Sign in instead, or use "Forgot password".', code: 'has_password' });
    }

    if (state === 'no_user') {
      const { error } = await admin.auth.admin.createUser({
        email: claim.email,
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (error) return json({ error: error.message });
      return json({ success: true, email: claim.email });
    }

    if (state === 'attached' || state === 'same_tenant') {
      const userId = claim.user_id as string;
      const { data: updated, error } = await admin.auth.admin.updateUserById(userId, {
        password,
        email_confirm: true,
        user_metadata: { full_name: name },
      });
      if (error) return json({ error: error.message });
      await admin.from('profiles').update({ full_name: name }).eq('id', userId);
      return json({ success: true, email: updated.user?.email });
    }

    return json({ error: 'Could not join with this invite. Ask whoever invited you to send a new link.' });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
});

// Always 200 with {error} on failure, so supabase.functions.invoke hands
// the message to the page instead of a generic "non-2xx" error.
function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
}
