// ============================================================
// StockFlow — Paystack webhook: a transfer confirms itself (Phase 5a)
//
// Deploy from the Supabase dashboard (Edge Functions → New function
// → name it "payments-webhook") OR via CLI, WITHOUT JWT verification —
// Paystack can't send a Supabase auth token, only its own signature:
//   supabase functions deploy payments-webhook --no-verify-jwt
//
// Then paste this function's URL into the business's own Paystack
// dashboard (Settings → API Keys & Webhooks → Webhook URL), or automate
// that step later via Paystack's "update integration" API from
// payments-connect. Each business points ITS OWN Paystack account at
// this one shared URL; the event's metadata says which tenant it's for.
//
// Security: the signature is HMAC-SHA512 of the RAW request body, keyed
// with the tenant's own secret (fetched from Vault by their tenant_id in
// the payload's metadata) — never trust the body until that matches.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();
  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }

  const tenantId = event?.data?.metadata?.tenant_id;
  const saleId = event?.data?.metadata?.sales_order_id;
  const signature = req.headers.get('x-paystack-signature') ?? '';
  if (!tenantId || !signature) return new Response('ok', { status: 200 }); // nothing we can verify — ignore, don't 500

  const admin = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: secretKey } = await admin.rpc('get_tenant_paystack_secret', { p_tenant: tenantId });
  if (!secretKey) return new Response('ok', { status: 200 }); // unknown tenant — ignore

  const expected = await hmacSha512Hex(secretKey, raw);
  if (!timingSafeEqual(expected, signature)) {
    return new Response('Invalid signature', { status: 401 });
  }

  if (event.event !== 'charge.success') return new Response('ok', { status: 200 });

  const amountNaira = Number(event.data.amount) / 100;
  const customer = event.data.customer ?? {};
  const payerName = [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.email || null;

  // Idempotent: (provider, provider_ref) is unique, so a replayed webhook
  // (Paystack retries on any non-2xx) just no-ops on the second insert.
  const { data: inserted, error: insertErr } = await admin
    .from('incoming_payments')
    .insert({
      tenant_id: tenantId,
      provider: 'paystack',
      provider_ref: event.data.reference,
      amount: amountNaira,
      payer_name: payerName,
      channel: event.data.channel ?? null,
      raw: event,
      sales_order_id: saleId ?? null,
    })
    .select('id')
    .maybeSingle();

  if (!insertErr && inserted) {
    await admin.rpc('apply_incoming_payment', { p_incoming: inserted.id });
  }
  // A duplicate insert (insertErr with a unique-violation code) means this
  // exact payment was already recorded — nothing left to do.

  await admin.from('payment_links').update({ status: 'paid' }).eq('provider_ref', event.data.reference);

  return new Response('ok', { status: 200 });
});

async function hmacSha512Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
