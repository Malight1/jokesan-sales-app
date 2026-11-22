// ============================================================
// ProfixBook — start a confirmed "Pay by transfer" at the till
// (Supabase Edge Function). Deploy: Edge Functions → New function →
// name it "till-payment-create" → paste → Deploy (JWT verification ON).
// Needs migrations 0057 and 0058.
//
// Asks the business's provider for a one-time payment of the sale total:
//   monnify  (Moniepoint) a one-time account number, valid 40 minutes
//   paystack a checkout link (shown as a QR code): transfer, USSD, card
//   opay     an OPay checkout link (QR code), valid 30 minutes
// and records it in till_payments. The till then waits; payments-webhook
// or till-payment-status confirms the money with the provider.
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
    const { amount: rawAmount, provider: wanted } = await req.json();
    const amount = Math.round(Number(rawAmount) * 100) / 100;
    if (!(amount > 0)) return json({ error: 'Nothing to pay.' });

    const authHeader = req.headers.get('Authorization') ?? '';
    const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } });
    const { data: userData, error: userErr } = await caller.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Please sign in again.' });
    const userId = userData.user.id;

    const { data: profile } = await caller.from('profiles')
      .select('tenant_id, branch_id, role, is_active').eq('id', userId).single();
    if (!profile?.tenant_id || profile.is_active === false) return json({ error: 'No business found for this account.' });
    if (!['admin', 'sales', 'cashier'].includes(profile.role)) return json({ error: 'Your role cannot take payments at the till.' });

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: provRows } = await admin.rpc('tenant_payment_provider', { p_tenant: profile.tenant_id, p_provider: wanted ?? null });
    const prov = Array.isArray(provRows) ? provRows[0] : provRows;
    if (!prov) return json({ error: 'No payment account is connected. An admin can connect Moniepoint, Paystack or OPay under Settings → Payments.' });
    const { data: secret } = await admin.rpc('get_tenant_payment_secret', { p_tenant: profile.tenant_id, p_provider: prov.provider });
    if (!secret) return json({ error: 'The payment connection needs to be set up again under Settings → Payments.' });

    const { data: tenant } = await admin.from('tenants').select('name').eq('id', profile.tenant_id).single();
    const { data: shift } = await admin.from('shifts').select('id, branch_id')
      .eq('tenant_id', profile.tenant_id).eq('opened_by', userId).eq('status', 'open').maybeSingle();
    const branchId = shift?.branch_id ?? profile.branch_id;
    if (!branchId) return json({ error: 'Your account has no branch yet. Ask an admin.' });

    const business = tenant?.name ?? 'Shop';
    const appUrl = (Deno.env.get('APP_URL') ?? 'https://www.profixbook.com').replace(/\/$/, '');
    const webhookUrl = `${Deno.env.get('SUPABASE_URL')}/functions/v1/payments-webhook`;
    const reference = `TILL-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`.toUpperCase();
    const email = `till+${reference.toLowerCase()}@profixbook.invoice`;

    let row: Record<string, unknown> = {};

    if (prov.provider === 'monnify') {
      const base = monnifyBase(prov.public_key);
      const token = await monnifyToken(base, prov.public_key, secret);
      if (!token) return json({ error: 'Moniepoint did not accept the saved keys. An admin can reconnect under Settings → Payments.' });
      const init = await post(`${base}/api/v1/merchant/transactions/init-transaction`, token, {
        amount, customerName: 'Walk-in customer', customerEmail: email, paymentReference: reference,
        paymentDescription: `${business} till sale`, currencyCode: 'NGN', contractCode: prov.settings?.contract_code,
        redirectUrl: `${appUrl}/paid`, paymentMethods: ['ACCOUNT_TRANSFER'],
      });
      const ib = init.body?.responseBody;
      if (!init.ok || init.body?.requestSuccessful !== true || ib?.paymentReference !== reference) {
        return json({ error: init.body?.responseMessage || 'Moniepoint could not start the payment.' });
      }
      const acct = await post(`${base}/api/v1/merchant/bank-transfer/init-payment`, token, { transactionReference: ib.transactionReference });
      const ab = acct.body?.responseBody;
      if (!acct.ok || acct.body?.requestSuccessful !== true || !ab?.accountNumber) {
        return json({ error: acct.body?.responseMessage || 'Moniepoint could not give an account number.' });
      }
      if (Number(ab.totalPayable ?? ab.amount) !== amount) return json({ error: 'Moniepoint returned a different amount. Try again.' });
      row = {
        account_number: ab.accountNumber, account_name: ab.accountName, bank_name: ab.bankName,
        expires_at: new Date(Date.now() + Number(ab.accountDurationSeconds ?? 2400) * 1000).toISOString(),
      };
    } else if (prov.provider === 'paystack') {
      const r = await fetch('https://api.paystack.co/transaction/initialize', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email, amount: Math.round(amount * 100), reference,
          channels: ['bank_transfer', 'ussd', 'card', 'qr'],
          metadata: { tenant_id: profile.tenant_id, till: true },
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.status) return json({ error: j.message || 'Paystack could not start the payment.' });
      row = { pay_url: j.data.authorization_url, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };
    } else if (prov.provider === 'opay') {
      const base = opayBase(prov.settings?.environment);
      const kobo = Math.round(amount * 100);
      const r = await fetch(`${base}/api/v1/international/cashier/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${prov.public_key}`, MerchantId: prov.settings?.merchant_id, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          country: 'NG', reference, amount: { total: kobo, currency: 'NGN' },
          returnUrl: `${appUrl}/paid`, cancelUrl: `${appUrl}/paid`, callbackUrl: webhookUrl, expireAt: 30,
          userInfo: { userName: 'Walk-in customer', userEmail: email },
          productList: [{ productId: reference, name: `${business} till sale`, description: 'Goods bought at the till', price: kobo, quantity: 1 }],
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || j.code !== '00000' || !j.data?.cashierUrl) return json({ error: j.message || 'OPay could not start the payment.' });
      if (j.data.reference !== reference) return json({ error: 'OPay returned a different reference. Try again.' });
      row = { pay_url: j.data.cashierUrl, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };
    } else {
      return json({ error: 'That payment provider is not supported yet.' });
    }

    const { data: saved, error: saveErr } = await admin.from('till_payments').insert({
      tenant_id: profile.tenant_id, branch_id: branchId, shift_id: shift?.id ?? null, created_by: userId,
      provider: prov.provider, provider_ref: reference, amount, ...row,
    }).select('*').single();
    if (saveErr) return json({ error: saveErr.message });

    return json({ success: true, payment: saved });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
});

const monnifyBase = (apiKey: string) => apiKey.startsWith('MK_TEST') ? 'https://sandbox.monnify.com' : 'https://api.monnify.com';
const opayBase = (env?: string) => env === 'live' ? 'https://api.opaycheckout.com' : 'https://sandboxapi.opaycheckout.com';

async function monnifyToken(base: string, apiKey: string, secretKey: string): Promise<string | null> {
  const r = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { Authorization: `Basic ${btoa(`${apiKey}:${secretKey}`)}` } });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.requestSuccessful === true ? j.responseBody?.accessToken ?? null : null;
}

async function post(url: string, token: string, body: unknown) {
  const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { ok: r.ok, body: await r.json().catch(() => ({})) as any };
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
}
