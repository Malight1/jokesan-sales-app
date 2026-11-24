// ============================================================
// ProfixBook — payment confirmations from Paystack, Moniepoint (Monnify)
// and OPay. Supabase Edge Function. Deploy: Edge Functions →
// payments-webhook → replace → Deploy with JWT verification OFF
// (providers call it with no Supabase login).
//
// Where each business points its provider:
//   Paystack: Settings → API Keys & Webhooks → Webhook URL
//   Monnify:  Developer → Webhook URLs → Transaction Completion
//   OPay:     nothing to set; ProfixBook sends this URL with every payment
//
// Trust rules:
//   Paystack  x-paystack-signature (HMAC-SHA512 of the body, secret key)
//             must match.
//   Monnify   monnify-signature must match when present (Monnify leaves it
//             off sandbox), AND the payment is re-checked with Monnify.
//   OPay      its signature uses SHA3-512, which this runtime can't do
//             natively, so every OPay notification is re-checked with
//             OPay's signed status API instead. Only SUCCESS counts.
// The amount recorded is always the provider's own verified figure.
//
// Two kinds of payment:
//   invoice pay links  (payment_links)  → incoming_payments + apply to the sale
//   till transfers     (till_payments)  → record_till_payment(); the till
//                                         then completes the sale itself
// Both idempotent: a retried notification never records money twice.
// A verified notification also stamps webhook_seen_at (migration 0059) so
// the Payments screen can tell the owner the setup works.
// ============================================================
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const raw = await req.text();
  let event: any;
  try { event = JSON.parse(raw); } catch { return new Response('Bad JSON', { status: 400 }); }

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  if (typeof event?.eventType === 'string') return handleMonnify(req, raw, event, admin);
  if (event?.type === 'transaction-status' && event?.payload) return handleOpay(event, admin);
  return handlePaystack(req, raw, event, admin);
});

// ---------------- Paystack ----------------
async function handlePaystack(req: Request, raw: string, event: any, admin: any): Promise<Response> {
  const tenantId = event?.data?.metadata?.tenant_id;
  const signature = req.headers.get('x-paystack-signature') ?? '';
  if (!tenantId || !signature) return ok();

  const { data: secretKey } = await admin.rpc('get_tenant_payment_secret', { p_tenant: tenantId, p_provider: 'paystack' });
  if (!secretKey) return ok();
  if (!timingSafeEqual(await hmacSha512Hex(secretKey, raw), signature)) return new Response('Invalid signature', { status: 401 });
  await admin.rpc('mark_payment_webhook_seen', { p_tenant: tenantId, p_provider: 'paystack' }); // setup tick (0059)
  if (event.event !== 'charge.success') return ok();

  const reference = event.data.reference;
  const amount = Number(event.data.amount) / 100;
  const c = event.data.customer ?? {};
  const payerName = [c.first_name, c.last_name].filter(Boolean).join(' ') || null;

  const fee = Number(event.data.fees ?? 0) / 100;
  if (event.data.metadata?.till) {
    await admin.rpc('record_till_payment', { p_provider: 'paystack', p_provider_ref: reference, p_amount: amount, p_payer_name: payerName, p_channel: event.data.channel ?? null, p_raw: event });
    await recordFee(admin, { kind: 'till', tenant_id: tenantId }, 'paystack', reference, fee);
    return ok();
  }
  await recordInvoice(admin, {
    tenant_id: tenantId, provider: 'paystack', provider_ref: reference, amount, payer_name: payerName,
    channel: event.data.channel ?? null, raw: event, sales_order_id: event.data.metadata?.sales_order_id ?? null,
  });
  await recordFee(admin, { kind: 'link', tenant_id: tenantId, sales_order_id: event.data.metadata?.sales_order_id ?? null }, 'paystack', reference, fee);
  return ok();
}

// ---------------- Moniepoint (Monnify) ----------------
async function handleMonnify(req: Request, raw: string, event: any, admin: any): Promise<Response> {
  if (event.eventType !== 'SUCCESSFUL_TRANSACTION') return ok();
  const reference: string | undefined = event.eventData?.paymentReference;
  if (!reference) return ok();

  const target = await findTarget(admin, 'monnify', reference);
  if (!target) return ok(); // not a ProfixBook payment

  const creds = await credentials(admin, target.tenant_id, 'monnify');
  if (!creds) return ok();
  const signature = req.headers.get('monnify-signature');
  if (signature && !timingSafeEqual(await hmacSha512Hex(creds.secret, raw), signature.toLowerCase())) {
    return new Response('Invalid signature', { status: 401 });
  }
  return settle(admin, target, await verify('monnify', reference, creds.prov, creds.secret), event);
}

// ---------------- OPay ----------------
async function handleOpay(event: any, admin: any): Promise<Response> {
  const reference: string | undefined = event.payload?.reference;
  if (!reference) return ok();
  const target = await findTarget(admin, 'opay', reference);
  if (!target) return ok();
  const creds = await credentials(admin, target.tenant_id, 'opay');
  if (!creds) return ok();
  return settle(admin, target, await verify('opay', reference, creds.prov, creds.secret), event);
}

// ---------------- shared ----------------
interface Target { kind: 'link' | 'till'; tenant_id: string; sales_order_id?: string | null }

async function findTarget(admin: any, provider: string, reference: string): Promise<Target | null> {
  const { data: link } = await admin.from('payment_links').select('tenant_id, sales_order_id')
    .eq('provider', provider).eq('provider_ref', reference).maybeSingle();
  if (link) return { kind: 'link', tenant_id: link.tenant_id, sales_order_id: link.sales_order_id };
  const { data: till } = await admin.from('till_payments').select('tenant_id')
    .eq('provider', provider).eq('provider_ref', reference).maybeSingle();
  if (till) return { kind: 'till', tenant_id: till.tenant_id };
  return null;
}

async function credentials(admin: any, tenantId: string, provider: string) {
  const { data: provRows } = await admin.rpc('tenant_payment_provider', { p_tenant: tenantId, p_provider: provider });
  const prov = Array.isArray(provRows) ? provRows[0] : provRows;
  const { data: secret } = await admin.rpc('get_tenant_payment_secret', { p_tenant: tenantId, p_provider: provider });
  return prov && secret ? { prov, secret: secret as string } : null;
}

async function settle(admin: any, target: Target, v: Verified | null, notification: unknown): Promise<Response> {
  if (!v) return new Response('Could not verify', { status: 502 }); // the provider retries later
  // The provider reached us and the payment checked out: setup tick (0059).
  await admin.rpc('mark_payment_webhook_seen', { p_tenant: target.tenant_id, p_provider: v.provider });
  if (!v.paid) return ok();
  if (target.kind === 'till') {
    await admin.rpc('record_till_payment', {
      p_provider: v.provider, p_provider_ref: v.reference, p_amount: v.amount,
      p_payer_name: v.payerName ?? null, p_payer_account: v.payerAccount ?? null, p_channel: v.channel ?? null,
      p_raw: { notification, verified: v.raw },
    });
  } else {
    await recordInvoice(admin, {
      tenant_id: target.tenant_id, provider: v.provider, provider_ref: v.reference, amount: v.amount,
      payer_name: v.payerName ?? null, payer_account: v.payerAccount ?? null, channel: v.channel ?? null,
      raw: { notification, verified: v.raw }, sales_order_id: target.sales_order_id ?? null,
    });
  }
  await recordFee(admin, target, v.provider, v.reference, v.fee ?? 0);
  return ok();
}

// The provider keeps a charge and pays the shop the rest, so the bank sees
// less than the sale. The charge is recorded once as a "Payment charges"
// expense (migration 0060); a repeated notification adds nothing.
async function recordFee(admin: any, target: Target, provider: string, reference: string, fee: number) {
  if (!(fee > 0)) return;
  let branch: string | null = null;
  if (target.kind === 'till') {
    const { data } = await admin.from('till_payments').select('branch_id').eq('provider', provider).eq('provider_ref', reference).maybeSingle();
    branch = data?.branch_id ?? null;
  } else if (target.sales_order_id) {
    const { data } = await admin.from('sales_orders').select('branch_id').eq('id', target.sales_order_id).maybeSingle();
    branch = data?.branch_id ?? null;
  }
  await admin.rpc('record_payment_fee', { p_tenant: target.tenant_id, p_provider: provider, p_ref: reference, p_fee: Math.round(fee * 100) / 100, p_branch: branch });
}

async function recordInvoice(admin: any, row: Record<string, unknown>) {
  const { data: inserted, error } = await admin.from('incoming_payments').insert(row).select('id').maybeSingle();
  if (!error && inserted) await admin.rpc('apply_incoming_payment', { p_incoming: inserted.id });
  await admin.from('payment_links').update({ status: 'paid' }).eq('provider', row.provider).eq('provider_ref', row.provider_ref);
}

interface Verified { provider: string; reference: string; paid: boolean; amount: number; fee?: number; payerName?: string | null; payerAccount?: string | null; channel?: string | null; raw?: unknown }

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
    // Monnify reports what it settles to the shop; the difference is its charge.
    const settled = Number(tx.settlementAmount);
    const fee = Number.isFinite(settled) && settled > 0 ? Math.max(0, Number(tx.amountPaid) - settled) : 0;
    return { provider, reference, paid: ['PAID', 'OVERPAID'].includes(tx.paymentStatus), amount: Number(tx.amountPaid), fee,
      payerName: src?.accountName ?? tx.customerDTO?.name ?? null, payerAccount: src?.accountNumber ?? null, channel: tx.paymentMethod ?? null, raw: tx };
  }
  if (provider === 'opay') {
    const base = prov.settings?.environment === 'live' ? 'https://api.opaycheckout.com' : 'https://sandboxapi.opaycheckout.com';
    const body = JSON.stringify({ country: 'NG', reference }); // alphabetical, as OPay signs it
    const r = await fetch(`${base}/api/v1/international/cashier/status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await hmacSha512Hex(secret, body)}`, MerchantId: prov.settings?.merchant_id, 'Content-Type': 'application/json' },
      body,
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code !== '00000' || j.data?.reference !== reference) return null;
    const opayFee = Number(j.data.fee?.total ?? 0) / 100;
    return { provider, reference, paid: j.data.status === 'SUCCESS', amount: Number(j.data.amount?.total ?? 0) / 100,
      fee: Number.isFinite(opayFee) ? opayFee : 0, channel: 'OPay', raw: j.data };
  }
  return null;
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
