-- ============================================================
-- ProfixBook — "Pay by transfer" at the till, confirmed by the provider.
--
-- The problem: a cashier taps "Transfer" and the sale counts as paid on
-- the strength of a screenshot. Fake transfer alerts are the most common
-- shop fraud in Nigeria. Now:
--
--   1. The till asks the business's provider (Moniepoint/Monnify,
--      Paystack or OPay) for a one-time payment: an account number for
--      that exact amount (Monnify), or a QR code / link (Paystack, OPay).
--      That's a till_payments row, created by the till-payment-create
--      Edge Function.
--   2. The customer pays. The provider's notification (payments-webhook)
--      or the till's own check (till-payment-status) confirms it with the
--      provider and calls record_till_payment(): money in, row 'paid'.
--   3. Only then does the till call complete_till_sale(), which creates
--      the sale through the normal create_sale() and ties its payment to
--      the confirmed money. One confirmed payment pays one sale.
--
-- Plus a switch per business: tenants.require_confirmed_transfer. When on,
-- a CASHIER can't record a plain "Transfer" payment any more; only a
-- confirmed one (enforced on sale_payments, so the offline queue can't
-- sneak one through either).
--
-- And the Z report's per-provider split: shift_confirmed_payments().
--
-- Run AFTER 0001-0057. Then deploy till-payment-create and
-- till-payment-status, and redeploy payments-webhook.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Payments requested at the till
-- ------------------------------------------------------------
create table if not exists till_payments (
  id                  uuid primary key default gen_random_uuid(),
  tenant_id           uuid not null references tenants(id) on delete cascade,
  branch_id           uuid not null references branches(id),
  shift_id            uuid references shifts(id),
  created_by          uuid not null references auth.users(id),
  provider            text not null check (provider in ('paystack', 'monnify', 'opay')),
  provider_ref        text not null,
  amount              numeric(14,2) not null check (amount > 0),
  account_number      text,
  account_name        text,
  bank_name           text,
  pay_url             text,
  expires_at          timestamptz,
  status              text not null default 'pending'
                        check (status in ('pending', 'paid', 'cancelled', 'expired', 'used')),
  incoming_payment_id uuid references incoming_payments(id),
  sales_order_id      uuid references sales_orders(id),
  paid_at             timestamptz,
  created_at          timestamptz not null default now(),
  unique (provider, provider_ref)
);
create index if not exists idx_till_payments_tenant on till_payments (tenant_id, created_at desc);

alter table till_payments enable row level security;
drop policy if exists till_payments_read on till_payments;
create policy till_payments_read on till_payments for select
  using (tenant_id = public.current_tenant_id()
         and (created_by = auth.uid() or public.has_role('accounts')));
-- No write policies: the Edge Functions (service role) insert, and the
-- RPCs below are the only way to change one.

alter table incoming_payments add column if not exists till_payment_id uuid references till_payments(id);

-- ------------------------------------------------------------
-- 2. The switch: cashiers must use confirmed transfers
-- ------------------------------------------------------------
alter table tenants add column if not exists require_confirmed_transfer boolean not null default false;

create or replace function public.guard_confirmed_transfer()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_group text;
begin
  if NEW.incoming_payment_id is not null then return NEW; end if;          -- already confirmed
  if public.real_role() is distinct from 'cashier' then return NEW; end if;
  if coalesce(current_setting('app.confirmed_transfer', true), '') = 'on' then return NEW; end if;
  if not coalesce((select require_confirmed_transfer from tenants where id = NEW.tenant_id), false) then return NEW; end if;
  select method_group into v_group from payment_types where id = NEW.payment_type_id;
  if v_group = 'transfer' then
    raise exception 'Transfers here have to be confirmed. Use "Pay by transfer" so the till checks the money arrived.'
      using errcode = 'check_violation';
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_confirmed_transfer on sale_payments;
create trigger trg_guard_confirmed_transfer before insert on sale_payments
  for each row execute function public.guard_confirmed_transfer();

-- ------------------------------------------------------------
-- 3. Money arrived (service role only: webhook / status check)
-- ------------------------------------------------------------
create or replace function public.record_till_payment(
  p_provider text, p_provider_ref text, p_amount numeric,
  p_payer_name text default null, p_payer_account text default null,
  p_channel text default null, p_raw jsonb default null
) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_tp record;
  v_inc uuid;
begin
  select * into v_tp from till_payments where provider = p_provider and provider_ref = p_provider_ref for update;
  if not found then return 'unknown'; end if;

  -- Idempotent: a second notification for the same payment changes nothing.
  insert into incoming_payments (tenant_id, provider, provider_ref, amount, payer_name, payer_account, channel, raw, match_status, till_payment_id)
  values (v_tp.tenant_id, p_provider, p_provider_ref, p_amount, p_payer_name, p_payer_account, p_channel, p_raw,
          case when p_amount >= v_tp.amount and v_tp.status in ('pending', 'expired') then 'auto' else 'unmatched' end, v_tp.id)
  on conflict (provider, provider_ref) do nothing
  returning id into v_inc;
  if v_inc is null then return v_tp.status; end if;

  -- Paid in full while still waiting (or just after the account expired):
  -- the till can now complete the sale. A short payment, or money for a
  -- request the cashier cancelled, stays on the "Money received" list for
  -- the owner to sort out.
  if p_amount >= v_tp.amount and v_tp.status in ('pending', 'expired') then
    update till_payments set status = 'paid', incoming_payment_id = v_inc, paid_at = now() where id = v_tp.id;
    return 'paid';
  end if;
  return v_tp.status;
end $$;
revoke execute on function public.record_till_payment(text, text, numeric, text, text, text, jsonb) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 4. The till completes the sale against the confirmed money
-- ------------------------------------------------------------
create or replace function public.complete_till_sale(
  p_till_payment   uuid,
  p_customer       uuid,
  p_items          jsonb,
  p_branch         uuid default null,
  p_order_discount numeric default 0,
  p_approval       jsonb default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tp    record;
  v_pt    uuid;
  v_sale  uuid;
  v_total numeric;
begin
  select * into v_tp from till_payments
   where id = p_till_payment and tenant_id = public.current_tenant_id() for update;
  if not found then raise exception 'Payment not found.'; end if;
  if v_tp.created_by <> auth.uid() then raise exception 'This payment was started on someone else''s till.'; end if;
  if v_tp.status = 'used' then raise exception 'This payment has already been used for a sale.'; end if;
  if v_tp.status <> 'paid' then raise exception 'The money has not arrived yet.'; end if;

  select id into v_pt from payment_types
   where tenant_id = v_tp.tenant_id and method_group = 'transfer' order by name limit 1;

  perform set_config('app.confirmed_transfer', 'on', true);
  v_sale := public.create_sale(p_customer, current_date, v_pt, v_tp.amount, p_items, 0,
                               coalesce(p_branch, v_tp.branch_id), coalesce(p_order_discount, 0), p_approval);
  perform set_config('app.confirmed_transfer', '', true);

  select total_amount into v_total from sales_orders where id = v_sale;
  if abs(v_total - v_tp.amount) > 0.009 then
    raise exception 'The sale total (₦%) no longer matches the transfer (₦%). Put the cart back as it was, or start a new transfer.',
      to_char(v_total, 'FM999,999,999,990.00'), to_char(v_tp.amount, 'FM999,999,999,990.00');
  end if;

  update sale_payments
     set incoming_payment_id = v_tp.incoming_payment_id, reference = v_tp.provider_ref,
         notes = 'Confirmed by ' || case v_tp.provider when 'monnify' then 'Moniepoint' when 'opay' then 'OPay' else 'Paystack' end
   where sales_order_id = v_sale;
  update incoming_payments set sales_order_id = v_sale, match_status = 'auto' where id = v_tp.incoming_payment_id;
  update till_payments set status = 'used', sales_order_id = v_sale where id = v_tp.id;
  perform public.log_audit('till_confirmed_transfer', 'sales_orders', v_sale::text,
    jsonb_build_object('provider', v_tp.provider, 'amount', v_tp.amount, 'reference', v_tp.provider_ref));
  return v_sale;
end $$;
grant execute on function public.complete_till_sale(uuid, uuid, jsonb, uuid, numeric, jsonb) to authenticated;

create or replace function public.cancel_till_payment(p_till_payment uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  update till_payments set status = 'cancelled'
   where id = p_till_payment and tenant_id = public.current_tenant_id()
     and created_by = auth.uid() and status = 'pending';
end $$;
grant execute on function public.cancel_till_payment(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. Z report: confirmed money on this till, by provider
-- ------------------------------------------------------------
create or replace function public.shift_confirmed_payments(p_shift uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('provider', provider, 'total', total, 'count', n) order by provider), '[]'::jsonb)
    from (
      select ip.provider, sum(sp.amount_paid) as total, count(*) as n
        from sale_payments sp
        join incoming_payments ip on ip.id = sp.incoming_payment_id
       where sp.shift_id = p_shift and sp.tenant_id = public.current_tenant_id() and sp.sale_return_id is null
       group by ip.provider
    ) t
$$;
grant execute on function public.shift_confirmed_payments(uuid) to authenticated;
