// ============================================================
// StockFlow — connect a tenant's own Paystack account (Phase 5a)
//
// Deploy from the Supabase dashboard (Edge Functions → New function
// → name it "payments-connect" → paste this) OR via CLI:
//   supabase functions deploy payments-connect
//
// No custom secret to set — SUPABASE_URL, SUPABASE_ANON_KEY, and
// SUPABASE_SERVICE_ROLE_KEY are auto-injected into every Edge Function.
//
// Flow: admin pastes their business's OWN Paystack secret + public key
// (Settings → Payments) → this function checks the secret actually works
// against Paystack's API → stores it in Supabase Vault (never in a plain
// table, never returned to the app) via store_tenant_paystack_secret(),
// which only exists once the `vault` extension is enabled on this project
// (Database → Extensions → supabase_vault).
//
// Money never passes through StockFlow — each business's own Paystack
// account collects it directly. This function only ever sees the secret
// key once, to verify it, then hands it straight to Vault.
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
    const { secretKey, publicKey } = await req.json();
    if (!secretKey?.startsWith('sk_') || !publicKey?.startsWith('pk_')) {
      return json({ error: 'That doesn\'t look like a Paystack secret/public key pair.' }, 400);
    }

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
      .from('profiles').select('role, tenant_id').eq('id', userData.user.id).single();
    if (profErr || !profile || profile.role !== 'admin' || !profile.tenant_id) {
      return json({ error: 'Only an admin can connect a payment account' }, 403);
    }

    // 2) Check the secret key actually works. Listing transactions is a
    //    harmless, always-available endpoint that any valid secret key can
    //    call — a bad key comes back 401 here before we ever store it.
    const vr = await fetch('https://api.paystack.co/transaction?perPage=1', {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    const v = await vr.json();
    if (!vr.ok || v.status !== true) {
      return json({ error: 'Paystack rejected that secret key — double-check it and try again.' }, 400);
    }

    // 3) Store it in Vault and record the connection, as the service role
    //    (payment_integrations has no policy the app could use directly).
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { error: storeErr } = await admin.rpc('store_tenant_paystack_secret', {
      p_tenant: profile.tenant_id, p_secret: secretKey, p_public_key: publicKey,
    });
    if (storeErr) {
      // Most likely cause: the `vault` extension isn't enabled yet on this
      // project (Database → Extensions → supabase_vault).
      return json({ error: `Could not save the connection: ${storeErr.message}` }, 500);
    }

    return json({ success: true });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
