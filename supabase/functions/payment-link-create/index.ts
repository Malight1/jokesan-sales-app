// ============================================================
// ProfixBook — a pay link for an unpaid invoice (Supabase Edge Function)
// Deploy: Edge Functions → payment-link-create → replace → Deploy
// (keep JWT verification ON).
//
// Uses the business's DEFAULT provider unless the app asks for one
// (migration 0057): Paystack, or Moniepoint through Monnify. Money goes
// straight into the business's own account; ProfixBook never holds it.
// payments-webhook confirms the payment and marks the invoice paid.
//
// Monnify checkout links work for 40 minutes and OPay's for 30; the
// response says when it stops working so the message to the customer can
// say so. OPay is told where to send its confirmation with each payment.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const monnifyBase = (apiKey: string) =>
  apiKey.startsWith('MK_TEST') ? 'https://sandbox.monnify.com' : 'https://api.monnify.com';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const { saleId, provider: wanted } = await req.json();
    if (!saleId) return json({ error: 'Missing sale.' });

    // 1) As the caller: normal RLS decides whether they can see this sale.
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Please sign in again.' });

    const { data: profile } = await callerClient
      .from('profiles').select('tenant_id').eq('id', userData.user.id).single();
    if (!profile?.tenant_id) return json({ error: 'No business found for this account.' });

    const { data: sale, error: saleErr } = await callerClient
      .from('sales_orders').select('id, tenant_id, doc_no, balance, voided, customers(first_name, last_name, company_store, email)')
      .eq('id', saleId).single();
    if (saleErr || !sale) return json({ error: 'Sale not found.' });
    if (sale.voided) return json({ error: 'This sale has been voided.' });
    if (!sale.balance || sale.balance <= 0) return json({ error: 'This sale has nothing left to pay.' });

    // 2) Which provider, and its secret (service role only).
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: provRows } = await admin.rpc('tenant_payment_provider', { p_tenant: profile.tenant_id, p_provider: wanted ?? null });
    const prov = Array.isArray(provRows) ? provRows[0] : provRows;
    if (!prov) return json({ error: 'No payment account is connected yet. An admin can connect one under Settings → Payments.' });
    const { data: secret } = await admin.rpc('get_tenant_payment_secret', { p_tenant: profile.tenant_id, p_provider: prov.provider });
    if (!secret) return json({ error: 'The payment connection needs to be set up again under Settings → Payments.' });

    const customer = Array.isArray(sale.customers) ? sale.customers[0] : sale.customers;
    const customerName = customer
      ? (`${customer.first_name ?? ''} ${customer.last_name ?? ''}`.trim() || customer.company_store || 'Customer')
      : 'Customer';
    const email = customer?.email || `customer+${saleId}@profixbook.invoice`;
    const docNo = sale.doc_no ?? `INV-${String(sale.id).slice(0, 8).toUpperCase()}`;
    const appUrl = (Deno.env.get('APP_URL') ?? 'https://www.profixbook.com').replace(/\/$/, '');

    let url = '';
    let reference = '';
    let meta: Record<string, unknown> = {};
    let expiresAt: string | null = null;

    if (prov.provider === 'paystack') {
      const initRes = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          amount: Math.round(sale.balance * 100), // kobo
          metadata: { tenant_id: sale.tenant_id, sales_order_id: sale.id },
        }),
      });
      const init = await initRes.json().catch(() => ({}));
      if (!initRes.ok || !init.status) return json({ error: init.message || 'Paystack could not create the payment link.' });
      url = init.data.authorization_url;
      reference = init.data.reference;
    } else if (prov.provider === 'monnify') {
      const apiKey: string = prov.public_key;
      const contractCode: string = prov.settings?.contract_code;
      const base = monnifyBase(apiKey);
      const token = await monnifyToken(base, apiKey, secret);
      if (!token) return json({ error: 'Monnify did not accept the saved keys. Reconnect under Settings → Payments.' });

      reference = `PFB-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      const initRes = await fetch(`${base}/api/v1/merchant/transactions/init-transaction`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: Number(sale.balance),
          customerName,
          customerEmail: email,
          paymentReference: reference,
          paymentDescription: `Payment for ${docNo}`,
          currencyCode: 'NGN',
          contractCode,
          redirectUrl: `${appUrl}/paid`,
          paymentMethods: ['ACCOUNT_TRANSFER', 'CARD', 'USSD'],
          metaData: { tenant_id: sale.tenant_id, sales_order_id: sale.id },
        }),
      });
      const init = await initRes.json().catch(() => ({}));
      const b = init?.responseBody;
      if (!initRes.ok || init.requestSuccessful !== true || !b?.checkoutUrl) {
        return json({ error: init?.responseMessage || 'Monnify could not create the payment link.' });
      }
      // Monnify's own advice: check what came back is what we asked for.
      if (b.paymentReference !== reference) return json({ error: 'Monnify returned a different reference. Try again.' });
      url = b.checkoutUrl;
      meta = { transactionReference: b.transactionReference };
      expiresAt = new Date(Date.now() + 40 * 60_000).toISOString();
    } else if (prov.provider === 'opay') {
      const base = prov.settings?.environment === 'live' ? 'https://api.opaycheckout.com' : 'https://sandboxapi.opaycheckout.com';
      const kobo = Math.round(Number(sale.balance) * 100);
      reference = `PFB-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
      const initRes = await fetch(`${base}/api/v1/international/cashier/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${prov.public_key}`, MerchantId: prov.settings?.merchant_id, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country: 'NG', reference, amount: { total: kobo, currency: 'NGN' },
          returnUrl: `${appUrl}/paid`, cancelUrl: `${appUrl}/paid`,
          callbackUrl: `${Deno.env.get('SUPABASE_URL')}/functions/v1/payments-webhook`,
          expireAt: 30,
          userInfo: { userName: customerName, userEmail: email },
          productList: [{ productId: String(sale.id), name: `Invoice ${docNo}`, description: `Payment for ${docNo}`, price: kobo, quantity: 1 }],
        }),
      });
      const init = await initRes.json().catch(() => ({}));
      if (!initRes.ok || init.code !== '00000' || !init.data?.cashierUrl) return json({ error: init.message || 'OPay could not create the payment link.' });
      if (init.data.reference !== reference) return json({ error: 'OPay returned a different reference. Try again.' });
      url = init.data.cashierUrl;
      meta = { orderNo: init.data.orderNo };
      expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
    } else {
      return json({ error: 'That payment provider is not supported yet.' });
    }

    // 3) Record it as the caller, through the normal RLS insert policy.
    const { error: insertErr } = await callerClient.from('payment_links').insert({
      tenant_id: sale.tenant_id,
      sales_order_id: sale.id,
      provider: prov.provider,
      provider_ref: reference,
      url,
      amount: sale.balance,
      meta,
      expires_at: expiresAt,
    });
    if (insertErr) return json({ error: insertErr.message });

    return json({ success: true, url, reference, provider: prov.provider, expiresAt });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
});

async function monnifyToken(base: string, apiKey: string, secretKey: string): Promise<string | null> {
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${apiKey}:${secretKey}`)}` },
  });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.requestSuccessful === true ? j.responseBody?.accessToken ?? null : null;
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
}
