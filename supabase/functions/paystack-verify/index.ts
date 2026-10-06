// ============================================================
// ProfixBook — Paystack subscription payment verification
// (Supabase Edge Function)
//
// Deploy from the Supabase dashboard (Edge Functions → paystack-verify
// → replace the code with this) OR via CLI:
//   supabase functions deploy paystack-verify
//
// Secret (Project Settings → Edge Functions → Secrets):
//   PAYSTACK_SECRET_KEY = sk_live_... (or sk_test_... while testing)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are
// injected automatically.
//
// Flow: the billing screen pays through Paystack Popup and gets a
// `reference` → calls this function → we look the payment up with
// Paystack using the secret key → confirm_subscription_payment() (0050)
// does the rest in the database: checks the amount against the
// database's own price list (including founding prices), refuses a
// reference that was already used, extends rather than restarts an
// unexpired plan, and assigns a founding spot. That function is
// callable by the service role only, so a business can't skip this
// step and grant itself a plan from the browser.
//
// Every refusal comes back as HTTP 200 with {error}, like the other
// functions here: supabase.functions.invoke() throws away the body of a
// non-2xx response, and the customer needs to see the actual reason.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PLANS = ['starter', 'growth', 'business'];
const INTERVALS = ['monthly', 'annual'];

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { reference, plan, interval = 'monthly' } = await req.json() as
      { reference?: string; plan?: string; interval?: string };
    if (!reference || !plan || !PLANS.includes(plan) || !INTERVALS.includes(interval)) {
      return json({ error: 'Missing or invalid reference, plan or billing period.' });
    }

    const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secret) return json({ error: 'Server not configured' });

    // 1) Who is paying: the caller's own JWT, never a client-supplied id.
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Not authenticated' });

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: profile } = await admin.from('profiles')
      .select('tenant_id, role, is_active').eq('id', userData.user.id).single();
    if (!profile?.tenant_id || !profile.is_active) return json({ error: 'No business found for this account.' });
    if (profile.role !== 'admin') return json({ error: 'Only an admin can manage billing.' });

    // 2) The payment itself, straight from Paystack.
    const vr = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const v = await vr.json();
    if (!v.status || v.data?.status !== 'success') {
      return json({ error: 'Payment not successful' });
    }
    if (v.data.currency && v.data.currency !== 'NGN') {
      return json({ error: 'Payment was not in naira.' });
    }
    // The billing screen stamps the business on the payment, so a
    // reference from someone else's checkout can't be claimed here.
    const paidFor = v.data.metadata?.tenant_id ?? v.data.metadata?.tenant;
    if (paidFor && paidFor !== profile.tenant_id) {
      return json({ error: 'This payment belongs to a different business.' });
    }

    // 3) Price check, replay check, dates and founding spot: all in the
    // database, using the amount Paystack says was actually paid.
    const { data, error } = await admin.rpc('confirm_subscription_payment', {
      p_tenant: profile.tenant_id,
      p_plan: plan,
      p_interval: interval,
      p_reference: reference,
      p_amount_kobo: Number(v.data.amount),
    });
    if (error) return json({ error: error.message });

    return json({ success: true, ...data });
  } catch (e) {
    return json({ error: String(e?.message ?? e) });
  }
});

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
}
