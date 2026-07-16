// ============================================================
// StockFlow — Paystack payment verification (Supabase Edge Function)
//
// Deploy from the Supabase dashboard (Edge Functions → New function
// → name it "paystack-verify" → paste this) OR via CLI:
//   supabase functions deploy paystack-verify --no-verify-jwt=false
//
// Set the secret (Project Settings → Edge Functions → Secrets):
//   PAYSTACK_SECRET_KEY = sk_test_...   (NEVER put this in the app)
//
// Flow: frontend pays via Paystack Popup → gets a `reference` →
// calls this function → we verify with Paystack using the secret key →
// on success we call activate_subscription() as the logged-in user.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const PLAN_PRICES: Record<string, number> = {
  starter: 7500,
  growth: 20000,
  business: 45000,
};

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { reference, plan } = await req.json();
    if (!reference || !plan || !PLAN_PRICES[plan]) {
      return json({ error: 'Missing or invalid reference/plan' }, 400);
    }

    const secret = Deno.env.get('PAYSTACK_SECRET_KEY');
    if (!secret) return json({ error: 'Server not configured' }, 500);

    // 1) verify the transaction with Paystack
    const vr = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    const v = await vr.json();
    if (!v.status || v.data?.status !== 'success') {
      return json({ error: 'Payment not successful' }, 400);
    }

    // 2) amount must match the plan (Paystack amounts are in kobo)
    const expectedKobo = PLAN_PRICES[plan] * 100;
    if (Number(v.data.amount) < expectedKobo) {
      return json({ error: 'Amount does not match plan' }, 400);
    }

    // 3) activate the plan AS the logged-in user (their JWT → tenant scope)
    const authHeader = req.headers.get('Authorization') ?? '';
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    const { error } = await supabase.rpc('activate_subscription', {
      p_plan: plan,
      p_reference: reference,
      p_amount: PLAN_PRICES[plan],
      p_period_end: periodEnd.toISOString(),
    });
    if (error) return json({ error: error.message }, 400);

    return json({ success: true, plan, expires: periodEnd.toISOString() });
  } catch (e) {
    return json({ error: String(e?.message ?? e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });
}
