// ============================================================
// ProfixBook — payment confirmations from Paystack and Moniepoint
// (Monnify). Supabase Edge Function. Deploy: Edge Functions →
// payments-webhook → replace → Deploy with JWT verification OFF
// (providers call it with no Supabase login).
//
// Each business pastes this URL into its own provider dashboard:
//   Paystack: Settings → API Keys & Webhooks → Webhook URL
//   Monnify:  Developer → Webhook URLs → Transaction Completion
//
// Paystack: trusted only if x-paystack-signature (HMAC-SHA512 of the body
//   with the business's secret key) matches.
// Monnify: the monnify-signature header (HMAC-SHA512 of the body with the
//   client secret) must match WHEN PRESENT. Monnify leaves it off sandbox
//   notifications, so every Monnify payment is ALSO checked by asking
//   Monnify's verify endpoint with the business's own keys: only PAID or
//   OVERPAID, for the amount Monnify reports, is ever recorded.
// Recording is idempotent: incoming_payments is unique on
// (provider, provider_ref), so a retried notification does nothing twice.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const monnifyBase = (apiKey: string) =>
  apiKey.startsWith('MK_TEST') ? 'https://sandbox.monnify.com' : 'https://api.monnify.com';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();
  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (typeof event?.eventType === 'string') return handleMonnify(req, raw, event, admin);
  return handlePaystack(req, raw, event, admin);
});

async function handlePaystack(req: Request, raw: string, event: any, admin: any): Promise<Response> {
  const tenantId = event?.data?.metadata?.tenant_id;
  const saleId = event?.data?.metadata?.sales_order_id;
  const signature = req.headers.get('x-paystack-signature') ?? '';
  if (!tenantId || !signature) return ok(); // nothing we can verify: ignore, don't 500

  const { data: secretKey } = await admin.rpc('get_tenant_payment_secret', { p_tenant: tenantId, p_provider: 'paystack' });
  if (!secretKey) return ok();

  const expected = await hmacSha512Hex(secretKey, raw);
  if (!timingSafeEqual(expected, signature)) return new Response('Invalid signature', { status: 401 });
  if (event.event !== 'charge.success') return ok();

  const customer = event.data.customer ?? {};
  await record(admin, {
    tenant_id: tenantId,
    provider: 'paystack',
    provider_ref: event.data.reference,
    amount: Number(event.data.amount) / 100,
    payer_name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || customer.email || null,
    channel: event.data.channel ?? null,
    raw: event,
    sales_order_id: saleId ?? null,
  });
  return ok();
}

async function handleMonnify(req: Request, raw: string, event: any, admin: any): Promise<Response> {
  if (event.eventType !== 'SUCCESSFUL_TRANSACTION') return ok();
  const data = event.eventData ?? {};
  const paymentReference: string | undefined = data.paymentReference;
  if (!paymentReference) return ok();

  // Which business: the link we created carries our own reference.
  const { data: link } = await admin.from('payment_links')
    .select('tenant_id, sales_order_id, amount').eq('provider', 'monnify').eq('provider_ref', paymentReference).maybeSingle();
  if (!link) return ok(); // not one of ours (e.g. a payment made outside ProfixBook)

  const { data: provRows } = await admin.rpc('tenant_payment_provider', { p_tenant: link.tenant_id, p_provider: 'monnify' });
  const prov = Array.isArray(provRows) ? provRows[0] : provRows;
  const { data: secretKey } = await admin.rpc('get_tenant_payment_secret', { p_tenant: link.tenant_id, p_provider: 'monnify' });
  if (!prov || !secretKey) return ok();

  const signature = req.headers.get('monnify-signature');
  if (signature) {
    const expected = await hmacSha512Hex(secretKey, raw);
    if (!timingSafeEqual(expected, signature.toLowerCase())) return new Response('Invalid signature', { status: 401 });
  }

  // Ask Monnify directly. Never trust the notification's own numbers.
  const base = monnifyBase(prov.public_key);
  const token = await monnifyToken(base, prov.public_key, secretKey);
  if (!token) return new Response('Could not verify', { status: 502 }); // Monnify retries later
  const vr = await fetch(`${base}/api/v2/merchant/transactions/query?paymentReference=${encodeURIComponent(paymentReference)}`,
    { headers: { Authorization: `Bearer ${token}` } });
  const v = await vr.json().catch(() => ({}));
  const tx = v?.responseBody;
  if (!vr.ok || v.requestSuccessful !== true || !tx) return new Response('Could not verify', { status: 502 });
  if (!['PAID', 'OVERPAID'].includes(tx.paymentStatus) || tx.paymentReference !== paymentReference) return ok();

  const source = Array.isArray(tx.paymentSourceInformation) ? tx.paymentSourceInformation[0] : null;
  await record(admin, {
    tenant_id: link.tenant_id,
    provider: 'monnify',
    provider_ref: paymentReference,
    amount: Number(tx.amountPaid),
    payer_name: source?.accountName ?? tx.customerDTO?.name ?? null,
    payer_account: source?.accountNumber ?? null,
    channel: tx.paymentMethod ?? null,
    raw: { notification: event, verified: tx },
    sales_order_id: link.sales_order_id,
  });
  return ok();
}

async function record(admin: any, row: Record<string, unknown>) {
  const { data: inserted, error } = await admin.from('incoming_payments').insert(row).select('id').maybeSingle();
  if (!error && inserted) await admin.rpc('apply_incoming_payment', { p_incoming: inserted.id });
  // A unique-violation means this exact payment was already recorded.
  await admin.from('payment_links').update({ status: 'paid' })
    .eq('provider', row.provider).eq('provider_ref', row.provider_ref);
}

async function monnifyToken(base: string, apiKey: string, secretKey: string): Promise<string | null> {
  const r = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { Authorization: `Basic ${btoa(`${apiKey}:${secretKey}`)}` },
  });
  const j = await r.json().catch(() => ({}));
  return r.ok && j.requestSuccessful === true ? j.responseBody?.accessToken ?? null : null;
}

const ok = () => new Response('ok', { status: 200 });

async function hmacSha512Hex(key: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
