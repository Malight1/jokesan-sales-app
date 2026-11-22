// ============================================================
// ProfixBook — has the till transfer arrived? (Supabase Edge Function)
// Deploy: Edge Functions → New function → "till-payment-status" →
// paste → Deploy (JWT verification ON). Needs migration 0058.
//
// The till calls this every few seconds while the customer pays. It asks
// the provider directly (never trusts the browser), so a till payment is
// confirmed even if the business never pasted the webhook URL into its
// provider dashboard. payments-webhook does the same job from the other
// side; whichever arrives first wins, record_till_payment() is idempotent.
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
    const { id } = await req.json();
    if (!id) return json({ error: 'Missing payment.' });

    // As the caller: RLS only shows their own till payments.
    const authHeader = req.headers.get('Authorization') ?? '';
    const caller = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } });
    const { data: tp } = await caller.from('till_payments').select('*').eq('id', id).maybeSingle();
    if (!tp) return json({ error: 'Payment not found.' });
    if (tp.status !== 'pending' && tp.status !== 'expired') return json({ status: tp.status, payment: tp });

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { data: provRows } = await admin.rpc('tenant_payment_provider', { p_tenant: tp.tenant_id, p_provider: tp.provider });
    const prov = Array.isArray(provRows) ? provRows[0] : provRows;
    const { data: secret } = await admin.rpc('get_tenant_payment_secret', { p_tenant: tp.tenant_id, p_provider: tp.provider });
    if (!prov || !secret) return json({ status: tp.status, payment: tp });

    const v = await verify(tp.provider, tp.provider_ref, prov, secret);
    if (v && v.paid) {
      const { data: res } = await admin.rpc('record_till_payment', {
        p_provider: tp.provider, p_provider_ref: tp.provider_ref, p_amount: v.amount,
        p_payer_name: v.payerName ?? null, p_payer_account: v.payerAccount ?? null, p_channel: v.channel ?? null, p_raw: v.raw ?? null,
      });
      const { data: fresh } = await caller.from('till_payments').select('*').eq('id', id).maybeSingle();
      return json({ status: fresh?.status ?? res, payment: fresh ?? tp, shortBy: v.amount < Number(tp.amount) ? Number(tp.amount) - v.amount : 0 });
    }

    if (tp.status === 'pending' && tp.expires_at && new Date(tp.expires_at).getTime() < Date.now()) {
      await admin.from('till_payments').update({ status: 'expired' }).eq('id', id).eq('status', 'pending');
      return json({ status: 'expired', payment: { ...tp, status: 'expired' } });
    }
    return json({ status: tp.status, payment: tp });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
});

interface Verified { paid: boolean; amount: number; payerName?: string | null; payerAccount?: string | null; channel?: string | null; raw?: unknown }

// The provider's own answer for one reference. null = couldn't ask.
async function verify(provider: string, reference: string, prov: any, secret: string): Promise<Verified | null> {
  if (provider === 'monnify') {
    const base = prov.public_key.startsWith('MK_TEST') ? 'https://sandbox.monnify.com' : 'https://api.monnify.com';
    const lr = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { Authorization: `Basic ${btoa(`${prov.public_key}:${secret}`)}` } });
    const l = await lr.json().catch(() => ({}));
    const token = lr.ok && l.requestSuccessful === true ? l.responseBody?.accessToken : null;
    if (!token) return null;
    const r = await fetch(`${base}/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${token}` } });
    const j = await r.json().catch(() => ({}));
    const tx = j?.responseBody;
    if (!r.ok || j.requestSuccessful !== true || !tx || tx.paymentReference !== reference) return null;
    const src = Array.isArray(tx.paymentSourceInformation) ? tx.paymentSourceInformation[0] : null;
    return { paid: ['PAID', 'OVERPAID'].includes(tx.paymentStatus), amount: Number(tx.amountPaid), payerName: src?.accountName ?? null, payerAccount: src?.accountNumber ?? null, channel: tx.paymentMethod ?? null, raw: tx };
  }
  if (provider === 'paystack') {
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${secret}` } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.status || j.data?.reference !== reference) return null;
    const c = j.data.customer ?? {};
    return { paid: j.data.status === 'success', amount: Number(j.data.amount) / 100, payerName: [c.first_name, c.last_name].filter(Boolean).join(' ') || null, channel: j.data.channel ?? null, raw: j.data };
  }
  if (provider === 'opay') {
    const base = prov.settings?.environment === 'live' ? 'https://api.opaycheckout.com' : 'https://sandboxapi.opaycheckout.com';
    const body = JSON.stringify({ country: 'NG', reference }); // keys already in alphabetical order, as OPay signs them
    const r = await fetch(`${base}/api/v1/international/cashier/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await hmacSha512Hex(secret, body)}`, MerchantId: prov.settings?.merchant_id, 'Content-Type': 'application/json' },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code !== '00000' || j.data?.reference !== reference) return null;
    return { paid: j.data.status === 'SUCCESS', amount: Number(j.data.amount?.total ?? 0) / 100, channel: 'OPay', raw: j.data };
  }
  return null;
}

async function hmacSha512Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
}
