// ============================================================
// StockFlow — create a Paystack pay link for a sale (Phase 5a)
//
// Deploy from the Supabase dashboard (Edge Functions → New function
// → name it "payment-link-create" → paste this) OR via CLI:
//   supabase functions deploy payment-link-create
//
// No custom secret to set — SUPABASE_URL, SUPABASE_ANON_KEY, and
// SUPABASE_SERVICE_ROLE_KEY are auto-injected into every Edge Function.
//
// Flow: a cashier/admin taps "Pay now" on an unpaid invoice → this
// function reads the sale (as the caller — RLS applies, same as any
// other read) → fetches the tenant's OWN Paystack secret out of Vault
// (the app never sees it) → asks Paystack to initialize a transaction for
// the sale's balance, tagged with metadata the webhook will use to find
// this exact sale later → records the link (as the caller, through the
// normal payment_links insert policy) and returns the URL to share.
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
    const { saleId } = await req.json();
    if (!saleId) return json({ error: 'Missing saleId' }, 400);

    // 1) Act as the caller for everything that isn't the secret itself —
    //    normal RLS decides whether they can even see this sale.
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Not authenticated' }, 401);

    const { data: profile } = await callerClient
      .from('profiles').select('tenant_id').eq('id', userData.user.id).single();
    if (!profile?.tenant_id) return json({ error: 'No tenant context' }, 400);

    const { data: sale, error: saleErr } = await callerClient
      .from('sales_orders').select('id, tenant_id, balance, voided, customers(first_name, last_name, email)')
      .eq('id', saleId).single();
    if (saleErr || !sale) return json({ error: 'Sale not found' }, 404);
    if (sale.voided) return json({ error: 'This sale has been voided.' }, 400);
    if (!sale.balance || sale.balance <= 0) return json({ error: 'This sale has nothing left to pay.' }, 400);

    // 2) Get this tenant's own Paystack secret back out of Vault — the
    //    service role is the only thing that can call this function.
    const admin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    );
    const { data: secretKey, error: secretErr } = await admin.rpc('get_tenant_paystack_secret', { p_tenant: profile.tenant_id });
    if (secretErr || !secretKey) {
      return json({ error: 'This business hasn\'t connected a Paystack account yet — see Settings → Payments.' }, 400);
    }

    // 3) Ask Paystack to initialize the transaction on the BUSINESS'S OWN
    //    account. metadata carries what the webhook needs to auto-confirm.
    const customer = Array.isArray(sale.customers) ? sale.customers[0] : sale.customers;
    const email = customer?.email || `customer+${saleId}@stockflow.invoice`;
    const initRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        amount: Math.round(sale.balance * 100), // kobo
        metadata: { tenant_id: sale.tenant_id, sales_order_id: sale.id },
      }),
    });
    const init = await initRes.json();
    if (!initRes.ok || !init.status) {
      return json({ error: init.message || 'Paystack could not create the payment link.' }, 400);
    }

    // 4) Record it as the caller, through the normal RLS insert policy.
    const { error: insertErr } = await callerClient.from('payment_links').insert({
      tenant_id: sale.tenant_id,
      sales_order_id: sale.id,
      provider_ref: init.data.reference,
      url: init.data.authorization_url,
      amount: sale.balance,
    });
    if (insertErr) return json({ error: insertErr.message }, 400);

    return json({ success: true, url: init.data.authorization_url, reference: init.data.reference });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
