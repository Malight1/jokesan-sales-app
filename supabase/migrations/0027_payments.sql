-- ============================================================
-- StockFlow — Automatic payment confirmation, part 1: pay links (Phase 5a)
--
-- Until now every transfer needed someone to read a bank alert and match
-- it by hand (MatchPayment.tsx). This migration adds the plumbing for a
-- transfer to confirm itself: each business connects its OWN Paystack
-- account (money never passes through StockFlow), an invoice gets a
-- "Pay now" link, and a webhook records the payment the moment it lands.
--
-- Scope: 5a (pay links) only, as FEATURE_PLAN.md's Phase 5 recommends
-- building first — it needs no special approval from Paystack, unlike
-- 5b (dedicated virtual accounts per customer). 5b and 5c (a bank-feed
-- provider) are deliberately not started; see HANDOVER.md.
--
-- payment_integrations stores each tenant's Paystack SECRET key only as a
-- Supabase Vault reference (secret_vault_id) — the table itself has no RLS
-- policy at all, so the app can never read it, not even the tenant's own
-- admin. integration_status() is the one window into it, and it returns
-- only the status and the PUBLIC key.
--
-- apply_incoming_payment() is the one thing that actually records money —
-- SECURITY DEFINER, revoked from every client role. It is only ever called
-- by the payments-webhook Edge Function, which authenticates as Supabase's
-- service_role (already granted access to every public-schema function by
-- Supabase's own project defaults, same as every other revoked-from-client
-- helper in this codebase — next_doc_no, log_audit, resolve_price, etc.).
--
-- What this migration can't verify: Vault itself (pgsodium/supabase_vault
-- aren't available in the PGlite test harness) and the real Paystack API
-- round trip. Both are exercised only by the Edge Functions themselves,
-- which — like paystack-verify and invite-teammate before them — are
-- deployed manually via the Supabase dashboard and are not part of the
-- frontend build or the DB test suite. Everything else here (the tables,
-- their RLS, integration_status(), and apply_incoming_payment()'s money
-- logic) is fully covered by supabase/tests/tests.sql.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Schema
-- ------------------------------------------------------------

create table if not exists payment_integrations (
  tenant_id        uuid primary key references tenants(id) on delete cascade,
  provider         text not null default 'paystack',
  status           text not null default 'pending' check (status in ('pending', 'live', 'error')),
  public_key       text,
  secret_vault_id  uuid,     -- id of the row in vault.secrets; never selectable by the app
  last_verified_at timestamptz,
  last_error       text,
  settings         jsonb not null default '{}'::jsonb,
  created_at       timestamptz not null default now()
);

create table if not exists payment_links (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  sales_order_id uuid not null references sales_orders(id) on delete cascade,
  provider       text not null default 'paystack',
  provider_ref   text not null,
  url            text not null,
  amount         numeric(14,2) not null,
  status         text not null default 'pending' check (status in ('pending', 'paid', 'expired', 'cancelled')),
  created_by     uuid references auth.users(id),
  created_at     timestamptz not null default now(),
  unique (provider, provider_ref)
);
create index if not exists idx_payment_links_sale on payment_links (sales_order_id);

create table if not exists incoming_payments (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  provider       text not null default 'paystack',
  provider_ref   text not null,
  amount         numeric(14,2) not null,
  payer_name     text,
  payer_account  text,
  channel        text,
  received_at    timestamptz not null default now(),
  raw            jsonb,
  sales_order_id uuid references sales_orders(id),
  customer_id    uuid references customers(id),
  match_status   text not null default 'unmatched'
    check (match_status in ('auto', 'suggested', 'manual', 'unmatched', 'ignored')),
  applied_payment_id uuid,
  unique (provider, provider_ref)     -- a replayed webhook is a no-op, not a double-credit
);
create index if not exists idx_incoming_payments_tenant on incoming_payments (tenant_id, received_at desc);

alter table sale_payments add column if not exists incoming_payment_id uuid references incoming_payments(id);


-- ------------------------------------------------------------
-- 2. RLS
-- ------------------------------------------------------------

alter table payment_integrations enable row level security;
-- Deliberately no policies at all — nobody using the anon/authenticated
-- role can select, insert, update or delete a single row here, ever.
-- Only integration_status() (below) and the service-role Edge Functions
-- touch this table.

alter table payment_links enable row level security;
drop policy if exists payment_links_read on payment_links;
create policy payment_links_read on payment_links for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales', 'accounts')
         and exists (select 1 from sales_orders so where so.id = sales_order_id and public.can_see_branch(so.branch_id)));
-- Written by payment-link-create (the caller's own JWT, so this needs a
-- normal insert policy — unlike a money table, a link doesn't move stock
-- or cash by itself, only Paystack's webhook confirming it does that.
drop policy if exists payment_links_insert on payment_links;
create policy payment_links_insert on payment_links for insert
  with check (tenant_id = public.current_tenant_id() and public.has_role('sales', 'accounts')
              and exists (select 1 from sales_orders so where so.id = sales_order_id and public.can_see_branch(so.branch_id) and not so.voided));

alter table incoming_payments enable row level security;
drop policy if exists incoming_payments_read on incoming_payments;
create policy incoming_payments_read on incoming_payments for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales', 'accounts'));
-- No write policy — only the webhook (service_role) ever inserts here.


-- ------------------------------------------------------------
-- 3. The one window into payment_integrations
-- ------------------------------------------------------------

create or replace function public.integration_status()
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('connected', true, 'status', status, 'public_key', public_key, 'last_verified_at', last_verified_at)
       from payment_integrations where tenant_id = public.current_tenant_id()),
    jsonb_build_object('connected', false, 'status', 'not_connected', 'public_key', null, 'last_verified_at', null)
  )
$$;


-- ------------------------------------------------------------
-- 4. Recording a payment link (payment-link-create writes here directly,
--    as the calling user, via the insert policy above — no RPC needed for
--    that half). This RPC is for the other half: marking one paid, which
--    only the webhook does.
-- ------------------------------------------------------------

-- Applies an incoming payment to the sale it references. Refuses to guess:
-- a payment with no sale reference (or one that no longer resolves) is
-- left 'unmatched' for a human to sort out under Incoming Payments,
-- exactly like an unmatched bank-alert paste today.
create or replace function public.apply_incoming_payment(p_incoming uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_row      record;
  v_sale     record;
  v_transfer_pt uuid;
  v_shift    uuid;
  v_applied  numeric;
  v_paid     numeric;
  v_status   pay_status;
  v_pay_id   uuid;
begin
  select * into v_row from incoming_payments where id = p_incoming for update;
  if not found then raise exception 'Incoming payment not found.'; end if;
  if v_row.applied_payment_id is not null then return; end if;   -- already applied; a replay is a no-op

  if v_row.sales_order_id is null then
    update incoming_payments set match_status = 'unmatched' where id = p_incoming;
    return;
  end if;

  select * into v_sale from sales_orders
   where id = v_row.sales_order_id and tenant_id = v_row.tenant_id for update;
  if not found or v_sale.voided then
    update incoming_payments set match_status = 'unmatched' where id = p_incoming;
    return;
  end if;

  select id into v_transfer_pt from payment_types
   where tenant_id = v_row.tenant_id and method_group = 'transfer' limit 1;

  -- No caller identity here (a webhook has no auth.uid()), so this simply
  -- attaches to whatever till is open at the sale's branch, if any.
  select id into v_shift from shifts
   where tenant_id = v_row.tenant_id and branch_id = v_sale.branch_id and status = 'open'
   order by opened_at desc limit 1;

  v_applied := least(v_row.amount, v_sale.balance);

  insert into sale_payments (tenant_id, sales_order_id, amount_paid, payment_type_id, reference, notes, shift_id, incoming_payment_id)
  values (v_row.tenant_id, v_sale.id, v_applied, v_transfer_pt, v_row.provider_ref,
          'Confirmed automatically via ' || v_row.provider, v_shift, p_incoming)
  returning id into v_pay_id;

  -- An overpayment becomes store credit for a named customer, same as a
  -- return's leftover refund; for a walk-in it simply isn't collectable,
  -- same as a cash overpay today.
  if v_row.amount > v_applied and v_sale.customer_id is not null then
    update customers set credit_balance = credit_balance + (v_row.amount - v_applied) where id = v_sale.customer_id;
    insert into customer_credit_ledger (tenant_id, customer_id, amount, source_type, source_id)
    values (v_row.tenant_id, v_sale.customer_id, v_row.amount - v_applied, 'overpayment', p_incoming);
  end if;

  select coalesce(sum(amount_paid), 0) into v_paid from sale_payments where sales_order_id = v_sale.id;
  v_status := case when v_paid <= 0 then 'unpaid' when v_paid >= v_sale.total_amount then 'full' else 'part' end;
  update sales_orders set amount_paid = v_paid, balance = v_sale.total_amount - v_paid, payment_status = v_status
   where id = v_sale.id;

  update incoming_payments set match_status = 'auto', customer_id = v_sale.customer_id, applied_payment_id = v_pay_id
   where id = p_incoming;

  perform public.log_audit('payment_confirmed', 'sales_orders', v_sale.id::text,
    jsonb_build_object('amount', v_applied, 'provider', v_row.provider, 'provider_ref', v_row.provider_ref));
end $$;

revoke execute on function public.apply_incoming_payment(uuid) from public, anon, authenticated;


-- ------------------------------------------------------------
-- 5. A system context bypasses the money guard (0017)
-- ------------------------------------------------------------
-- apply_incoming_payment() is the first write in this app that reaches a
-- guarded table (sale_payments) with no signed-in user at all — the real
-- payments-webhook Edge Function calls it as Supabase's service_role, not
-- as any particular staff member. guard_money_write's tenant_is_live()/
-- has_role() checks both resolve through current_tenant_id()/current_role(),
-- which need auth.uid() — with none set, they'd wrongly read as "tenant
-- not live" and reject the insert.
--
-- current_role() returning null is safe to treat as a trusted system
-- write: a real authenticated/anon request can never reach this trigger
-- with no role, because that same null current_tenant_id() would already
-- have failed the table's own RLS policy before the trigger ever runs.
-- The only things that can reach guard_money_write with no role are the
-- table owner (migrations, this test suite) and a SECURITY DEFINER
-- function acting on the owner's authority — both already fully trusted.
create or replace function public.guard_money_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_allowed text[] := string_to_array(TG_ARGV[0], ',');
  v_action  text   := coalesce(TG_ARGV[1], 'write');
begin
  if public.current_role() is null then
    return NEW;
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — % is read-only until billing is sorted out.', v_action
      using errcode = 'check_violation';
  end if;
  if not public.has_role(variadic v_allowed) then
    raise exception 'Your role is not allowed to %.', v_action
      using errcode = 'insufficient_privilege';
  end if;
  return NEW;
end $$;


-- ------------------------------------------------------------
-- 6. Storing a tenant's Paystack secret in Supabase Vault
-- ------------------------------------------------------------
-- Only created when the `vault` schema exists — Supabase's own Vault
-- extension, present on the real project but NOT in the PGlite test
-- harness (a generic Postgres build with no Supabase platform schemas).
-- On the harness this whole block is a no-op, so the tests above simulate
-- what it does (insert a payment_integrations row directly) rather than
-- calling it — this is the one piece of 0027 genuinely untestable outside
-- the real project. If the real project's SQL editor reports the `vault`
-- schema doesn't exist, enable the Vault extension first (Database →
-- Extensions → supabase_vault) and re-run just this section.
--
-- The payments-connect Edge Function is the only caller of the first
-- (service role, after it has already verified the key against Paystack's
-- API); payment-link-create is the only caller of the second, to get the
-- secret back out when it needs to call Paystack on the tenant's behalf.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    execute $sql$
      create or replace function public.store_tenant_paystack_secret(p_tenant uuid, p_secret text, p_public_key text)
      returns void
      language plpgsql security definer set search_path = public, vault as $fn$
      declare
        v_vault_id uuid;
      begin
        v_vault_id := vault.create_secret(p_secret, 'paystack_secret_' || p_tenant::text);
        insert into payment_integrations (tenant_id, status, public_key, secret_vault_id, last_verified_at)
        values (p_tenant, 'live', p_public_key, v_vault_id, now())
        on conflict (tenant_id) do update
          set status = 'live', public_key = excluded.public_key, secret_vault_id = excluded.secret_vault_id,
              last_verified_at = now(), last_error = null;
      end $fn$;
    $sql$;
    execute 'revoke execute on function public.store_tenant_paystack_secret(uuid, text, text) from public, anon, authenticated';

    execute $sql$
      create or replace function public.get_tenant_paystack_secret(p_tenant uuid)
      returns text
      language plpgsql security definer set search_path = public, vault as $fn$
      declare
        v_vault_id uuid;
        v_secret   text;
      begin
        select secret_vault_id into v_vault_id from payment_integrations where tenant_id = p_tenant;
        if v_vault_id is null then return null; end if;
        select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_vault_id;
        return v_secret;
      end $fn$;
    $sql$;
    execute 'revoke execute on function public.get_tenant_paystack_secret(uuid) from public, anon, authenticated';
  end if;
end $$;
