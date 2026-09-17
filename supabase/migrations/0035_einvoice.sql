-- ============================================================
-- StockFlow — E-invoicing (NRS) readiness (Phase 7c)
--
-- Nigeria's e-invoicing mandate isn't enforced yet (₦1–5bn turnover:
-- January 2027; everyone else, which is most StockFlow customers: live
-- July 2027, enforced January 2028) and needs an accredited access-point
-- provider StockFlow hasn't chosen — the plan's own words are "start
-- talks with one or two accredited providers... get the current field
-- specification from them." That's the user's own action, not something
-- to build now.
--
-- What IS worth building now, so connecting a provider later is just an
-- adapter: the master data the tax authority will want (business TIN/RC
-- number/address — already have TIN; customer TIN and B2B-vs-B2C; a
-- product's tax category and classification code), a readiness score so
-- an admin can see what's missing well before the deadline, and a real
-- database-level guarantee that an issued invoice's value never changes
-- after the fact (corrections are returns/credit notes only — Phase 2 —
-- never an edit). Submission tracking and the actual provider adapter are
-- deliberately NOT built — there's no provider yet to submit to.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Master data the tax authority wants
-- ------------------------------------------------------------

alter table tenants add column if not exists rc_number text;   -- CAC registration number
alter table tenants add column if not exists address    text;
-- tin already exists on tenants (0008_vat.sql).

alter table customers add column if not exists tin text;
alter table customers add column if not exists customer_kind text not null default 'b2c'
  check (customer_kind in ('b2b', 'b2c'));
-- address already exists on customers (0001_init.sql).

alter table finished_goods add column if not exists tax_category      text;
alter table finished_goods add column if not exists classification_code text;


-- ------------------------------------------------------------
-- 2. An issued invoice's value can't change — corrections are a return
--    or credit note (Phase 2), never an edit. sales_orders already has
--    no direct write policy at all (RPC-only, 0017), so this is defence
--    in depth against a future RPC bug rather than closing an open door
--    that exists today — but it's the real, enforced guarantee the plan
--    asks for, not just an absence of a write policy.
-- ------------------------------------------------------------

create or replace function public.enforce_invoice_immutability()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- create_sale itself inserts a placeholder row, then updates it once
  -- FIFO/COGS are computed, setting processed = true as its very last
  -- act — that's still "being created," not "being edited," so the
  -- guard only engages once a sale was ALREADY processed beforehand.
  --
  -- doc_no has its own, older immutability trigger (assign_doc_no(),
  -- 0021) — not repeated here. transaction_date is deliberately NOT
  -- protected: correcting a mis-keyed date is a normal admin fix, not a
  -- change to the invoice's commercial value, which is what this guards.
  if not OLD.processed then
    return NEW;
  end if;
  if NEW.customer_id is distinct from OLD.customer_id
     or NEW.branch_id is distinct from OLD.branch_id
     or NEW.subtotal is distinct from OLD.subtotal
     or NEW.vat_amount is distinct from OLD.vat_amount
     or NEW.vat_rate is distinct from OLD.vat_rate
     or NEW.total_amount is distinct from OLD.total_amount
     or NEW.cogs is distinct from OLD.cogs
     or NEW.gross_profit is distinct from OLD.gross_profit
  then
    raise exception 'An issued invoice''s value can''t be edited — record a return or credit note instead.'
      using errcode = 'check_violation';
  end if;
  return NEW;
end $$;

drop trigger if exists trg_invoice_immutability on sales_orders;
create trigger trg_invoice_immutability before update on sales_orders
  for each row execute function public.enforce_invoice_immutability();


-- ------------------------------------------------------------
-- 3. Submission tracking — the shape a future provider adapter will
--    write to (an Edge Function, service-role only, same pattern as
--    incoming_payments in 0027). Nothing in this migration writes it yet.
-- ------------------------------------------------------------

create table if not exists einvoice_submissions (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  doc_type     text not null check (doc_type in ('sale', 'sale_return')),
  doc_id       uuid not null,
  provider     text,
  irn          text,
  qr_payload   text,
  status       text not null default 'pending' check (status in ('pending', 'submitted', 'failed')),
  request      jsonb,
  response     jsonb,
  submitted_at timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_einvoice_submissions_doc on einvoice_submissions (tenant_id, doc_type, doc_id);

alter table einvoice_submissions enable row level security;
drop policy if exists einvoice_submissions_read on einvoice_submissions;
create policy einvoice_submissions_read on einvoice_submissions for select
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts'));
-- No write policy: only a future service-role Edge Function writes this,
-- the same shape as incoming_payments (0027).


-- ------------------------------------------------------------
-- 4. Readiness score — plain SQL, read by Settings so an admin can see
--    exactly what's missing, well before the 2027/2028 deadlines.
-- ------------------------------------------------------------

create or replace function public.einvoice_readiness()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_tin     boolean;
  v_rc      boolean;
  v_address boolean;
  v_prod_total int;
  v_prod_ready int;
  v_cust_b2b   int;
  v_cust_b2b_ready int;
  v_business_score numeric;
  v_product_score  numeric;
  v_customer_score numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('admin', 'accounts') then
    raise exception 'Your role is not allowed to view e-invoicing readiness.' using errcode = 'insufficient_privilege';
  end if;

  select t.tin is not null and trim(t.tin) <> '',
         t.rc_number is not null and trim(t.rc_number) <> '',
         t.address is not null and trim(t.address) <> ''
    into v_tin, v_rc, v_address
    from tenants t where t.id = v_tenant;

  select count(*),
         count(*) filter (where g.tax_category is not null and trim(g.tax_category) <> ''
                             and g.classification_code is not null and trim(g.classification_code) <> '')
    into v_prod_total, v_prod_ready
    from finished_goods g where g.tenant_id = v_tenant;

  select count(*), count(*) filter (where c.tin is not null and trim(c.tin) <> '')
    into v_cust_b2b, v_cust_b2b_ready
    from customers c where c.tenant_id = v_tenant and c.customer_kind = 'b2b';

  v_business_score := (v_tin::int + v_rc::int + v_address::int) / 3.0;
  v_product_score  := case when v_prod_total = 0 then 1 else v_prod_ready::numeric / v_prod_total end;
  v_customer_score := case when v_cust_b2b = 0 then 1 else v_cust_b2b_ready::numeric / v_cust_b2b end;

  return jsonb_build_object(
    'overall_percent', round((v_business_score + v_product_score + v_customer_score) / 3 * 100),
    'business', jsonb_build_object('tin', v_tin, 'rc_number', v_rc, 'address', v_address),
    'products', jsonb_build_object('total', v_prod_total, 'ready', v_prod_ready),
    'customers_b2b', jsonb_build_object('total', v_cust_b2b, 'ready', v_cust_b2b_ready)
  );
end $$;
