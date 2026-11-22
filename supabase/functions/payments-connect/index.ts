// ============================================================
// ProfixBook — connect a business's OWN payment account
// (Supabase Edge Function). Deploy: Edge Functions → payments-connect →
// replace the code → Deploy (keep JWT verification ON).
//
// Providers (migration 0057 allows several per business):
//   paystack  { secretKey: 'sk_…', publicKey: 'pk_…' }
//   monnify   { apiKey: 'MK_…', secretKey: '…', contractCode: '…' }
//             (Moniepoint's gateway; MK_TEST_ keys = sandbox, others = live)
//   opay      { publicKey, secretKey, merchantId, environment: 'sandbox'|'live' }
//
// The key is checked against the provider once, then stored ONLY in
// Supabase Vault (store_tenant_payment_secret, service role). The app can
// never read it back. Business plan and above.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

export const monnifyBase = (apiKey: string) =>
  apiKey.startsWith('MK_TEST') ? 'https://sandbox.monnify.com' : 'https://api.monnify.com';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });

  try {
    const body = await req.json();
    const provider: string = body.provider ?? 'paystack';
    if (!['paystack', 'monnify', 'opay'].includes(provider)) return json({ error: 'That payment provider is not supported yet.' });

    // 1) The caller must be a signed-in admin (checked with their own JWT).
    const authHeader = req.headers.get('Authorization') ?? '';
    const callerClient = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_ANON_KEY')!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: userData, error: userErr } = await callerClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: 'Please sign in again.' });

    const { data: profile } = await callerClient
      .from('profiles').select('role, tenant_id').eq('id', userData.user.id).single();
    if (!profile || profile.role !== 'admin' || !profile.tenant_id) {
      return json({ error: 'Only an admin can connect a payment account.' });
    }

    // 1b) Business plan and above.
    const { error: featErr } = await callerClient.rpc('require_feature', {
      p_feature: 'auto_payments', p_label: 'Automatic payment confirmation',
    });
    if (featErr) return json({ error: featErr.message });

    // 2) Check the keys work with the provider before storing anything.
    let secret = '';
    let publicKey = '';
    let settings: Record<string, unknown> = {};

    if (provider === 'paystack') {
      const { secretKey, publicKey: pk } = body;
      if (!secretKey?.startsWith('sk_') || !pk?.startsWith('pk_')) {
        return json({ error: "That doesn't look like a Paystack secret and public key." });
      }
      const vr = await fetch('https://api.paystack.co/transaction?perPage=1', { headers: { Authorization: `Bearer ${secretKey}` } });
      const v = await vr.json().catch(() => ({}));
      if (!vr.ok || v.status !== true) return json({ error: 'Paystack rejected that secret key. Check it and try again.' });
      secret = secretKey; publicKey = pk;
    } else if (provider === 'opay') {
      const pk = String(body.publicKey ?? '').trim();
      const sk = String(body.secretKey ?? '').trim();
      const merchantId = String(body.merchantId ?? '').trim();
      const environment = body.environment === 'live' ? 'live' : 'sandbox';
      if (!pk || !sk || !/^\d{6,20}$/.test(merchantId)) {
        return json({ error: 'Enter the public key, secret key and merchant ID from your OPay Business dashboard (API Keys & Webhooks).' });
      }
      // A status lookup for a reference that can't exist: OPay answers
      // "not found" (02006) for good keys and "authentication failed"
      // (02000) for bad ones, without creating anything.
      const base = environment === 'live' ? 'https://api.opaycheckout.com' : 'https://sandboxapi.opaycheckout.com';
      const probe = JSON.stringify({ country: 'NG', reference: `PROFIXBOOK-KEYCHECK-${crypto.randomUUID()}` });
      const vr = await fetch(`${base}/api/v1/international/cashier/status`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await hmacSha512Hex(sk, probe)}`, MerchantId: merchantId, 'Content-Type': 'application/json' },
        body: probe,
      });
      const v = await vr.json().catch(() => ({}));
      if (v.code !== '02006' && v.code !== '00000') {
        return json({ error: v.code === '02000'
          ? 'OPay rejected those keys. Check the secret key and merchant ID, and that Test/Live matches the keys.'
          : `OPay said: ${v.message ?? 'could not check the keys'}.` });
      }
      secret = sk; publicKey = pk;
      settings = { merchant_id: merchantId, environment };
    } else {
      const apiKey = String(body.apiKey ?? '').trim();
      const secretKey = String(body.secretKey ?? '').trim();
      const contractCode = String(body.contractCode ?? '').trim();
      if (!apiKey.startsWith('MK_') || !secretKey || !/^\d{6,20}$/.test(contractCode)) {
        return json({ error: 'Enter the API key (starts with MK_), the secret key and the contract code from your Monnify dashboard.' });
      }
      const base = monnifyBase(apiKey);
      const lr = await fetch(`${base}/api/v1/auth/login`, {
        method: 'POST',
        headers: { Authorization: `Basic ${btoa(`${apiKey}:${secretKey}`)}` },
      });
      const l = await lr.json().catch(() => ({}));
      if (!lr.ok || l.requestSuccessful !== true || !l.responseBody?.accessToken) {
        return json({ error: 'Monnify rejected those keys. Check the API key and secret key (test keys only work in sandbox).' });
      }
      secret = secretKey; publicKey = apiKey;
      settings = { contract_code: contractCode, environment: apiKey.startsWith('MK_TEST') ? 'sandbox' : 'live' };
    }

    // 3) Store in Vault and record the connection (service role only).
    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const { error: storeErr } = await admin.rpc('store_tenant_payment_secret', {
      p_tenant: profile.tenant_id, p_provider: provider, p_secret: secret, p_public_key: publicKey, p_settings: settings,
    });
    if (storeErr) return json({ error: `Could not save the connection: ${storeErr.message}` });

    return json({ success: true, provider });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) });
  }
});

async function hmacSha512Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 200 with {error} so the app shows the real message.
function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } });
}
