-- ============================================================
-- ProfixBook: accounting fixes (audit AUDIT-ACCOUNTING-2026-11.md, part 1)
--
--  1. Payments after a return no longer undo the return. A customer
--     payment (or supplier payment) used to recompute the balance as
--     total - paid, forgetting what a return had already taken off.
--     Balances are now reduced by the payment, and balances already
--     knocked out by the old maths are repaired (each repair is logged).
--  2. Stock losses (write-offs, damage, count corrections that lower
--     stock) and till shortages/overages reach the profit figures via
--     report_extras().
--  3. Money paid out of the till for a business cost becomes an expense.
--  4. Expenses: void instead of delete, every change in the activity log,
--     optional VAT part, and dashboard totals skip voided expenses.
--  5. "Books closed up to" date: nothing dated on or before it can be
--     added, changed or voided.
--  6. Stock value at cost per product (report_stock_value()).
--  7. Supplier VAT on purchases (set_purchase_vat()).
--  8. Payment provider charges recorded as an expense (server only).
--
-- Run AFTER 0001-0059.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Payments reduce the balance; they don't recompute it
-- ------------------------------------------------------------
create or replace function public.record_sale_payment(
  p_sale         uuid,
  p_amount       numeric,
  p_payment_type uuid,
  p_reference    text default null,
  p_notes        text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_row     record;
  v_paid    numeric;
  v_balance numeric;
  v_shift   uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment has to be more than zero.';
  end if;
  perform public.assert_same_tenant('payment_types', p_payment_type);

  select * into v_row from sales_orders where id = p_sale and tenant_id = v_tenant for update;
  if not found then raise exception 'Sale not found.'; end if;
  if v_row.voided then raise exception 'This sale has been voided — it can''t take a payment.'; end if;
  if p_amount > v_row.balance + 0.005 then
    raise exception 'That''s more than the ₦% still owed on this sale.', v_row.balance;
  end if;

  v_shift := public.current_open_shift(v_row.branch_id);

  insert into sale_payments(tenant_id, sales_order_id, payment_date, amount_paid, payment_type_id, reference, notes, shift_id)
  values (v_tenant, p_sale, current_date, p_amount, p_payment_type, p_reference, p_notes, v_shift);

  select coalesce(sum(amount_paid), 0) into v_paid
    from sale_payments where sales_order_id = p_sale and tenant_id = v_tenant;
  -- What a return already took off stays taken off.
  v_balance := greatest(0, v_row.balance - p_amount);

  update sales_orders
     set amount_paid = v_paid, balance = v_balance,
         payment_status = case when v_balance <= 0.005 then 'full'::pay_status
                               when v_paid <= 0 then 'unpaid'::pay_status
                               else 'part'::pay_status end
   where id = p_sale and tenant_id = v_tenant;
end $$;
grant execute on function public.record_sale_payment(uuid, numeric, uuid, text, text) to authenticated;

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
  v_balance  numeric;
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

  select id into v_shift from shifts
   where tenant_id = v_row.tenant_id and branch_id = v_sale.branch_id and status = 'open'
   order by opened_at desc limit 1;

  v_applied := least(v_row.amount, v_sale.balance);

  insert into sale_payments (tenant_id, sales_order_id, amount_paid, payment_type_id, reference, notes, shift_id, incoming_payment_id)
  values (v_row.tenant_id, v_sale.id, v_applied, v_transfer_pt, v_row.provider_ref,
          'Confirmed automatically via ' || v_row.provider, v_shift, p_incoming)
  returning id into v_pay_id;

  if v_row.amount > v_applied and v_sale.customer_id is not null then
    update customers set credit_balance = credit_balance + (v_row.amount - v_applied) where id = v_sale.customer_id;
    insert into customer_credit_ledger (tenant_id, customer_id, amount, source_type, source_id)
    values (v_row.tenant_id, v_sale.customer_id, v_row.amount - v_applied, 'overpayment', p_incoming);
  end if;

  select coalesce(sum(amount_paid), 0) into v_paid from sale_payments where sales_order_id = v_sale.id;
  v_balance := greatest(0, v_sale.balance - v_applied);
  update sales_orders
     set amount_paid = v_paid, balance = v_balance,
         payment_status = case when v_balance <= 0.005 then 'full'::pay_status
                               when v_paid <= 0 then 'unpaid'::pay_status
                               else 'part'::pay_status end
   where id = v_sale.id;

  update incoming_payments set match_status = 'auto', customer_id = v_sale.customer_id, applied_payment_id = v_pay_id
   where id = p_incoming;

  perform public.log_audit('payment_confirmed', 'sales_orders', v_sale.id::text,
    jsonb_build_object('amount', v_applied, 'provider', v_row.provider, 'provider_ref', v_row.provider_ref));
end $$;
revoke execute on function public.apply_incoming_payment(uuid) from public, anon, authenticated;

create or replace function public.record_purchase_payment(
  p_purchase     uuid,
  p_amount       numeric,
  p_payment_type uuid,
  p_reference    text default null,
  p_notes        text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_row     record;
  v_paid    numeric;
  v_balance numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment has to be more than zero.';
  end if;
  perform public.assert_same_tenant('payment_types', p_payment_type);

  select * into v_row from purchase_orders where id = p_purchase and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase not found.'; end if;
  if v_row.voided then raise exception 'This purchase has been voided — it can''t take a payment.'; end if;

  insert into purchase_payments(tenant_id, purchase_order_id, payment_date, amount_paid, payment_type_id, reference, notes)
  values (v_tenant, p_purchase, current_date, p_amount, p_payment_type, p_reference, p_notes);

  select coalesce(sum(amount_paid), 0) into v_paid
    from purchase_payments where purchase_order_id = p_purchase and tenant_id = v_tenant;
  -- Advance payments may take it below zero (the supplier owes you goods).
  v_balance := v_row.balance - p_amount;

  update purchase_orders
     set total_paid = v_paid, balance = v_balance,
         payment_status = case when v_balance <= 0.005 then 'full'::pay_status
                               when v_paid <= 0 then 'unpaid'::pay_status
                               else 'part'::pay_status end
   where id = p_purchase and tenant_id = v_tenant;
end $$;
grant execute on function public.record_purchase_payment(uuid, numeric, uuid, text, text) to authenticated;

-- Repair balances the old maths got wrong. Only rows with a return can be
-- affected. What is owed = total, less returns, less money paid (refunds
-- are negative payments), plus any part of a return given as store credit
-- (that value went to the customer's credit, not off this invoice).
with fixed as (
  select so.id, so.tenant_id, so.balance as old_balance,
         greatest(0, so.total_amount - so.returned_total
           - coalesce((select sum(sp.amount_paid) from sale_payments sp where sp.sales_order_id = so.id), 0)
           + coalesce((select sum(sr.to_store_credit) from sale_returns sr
                        where sr.sales_order_id = so.id and not sr.voided), 0)) as new_balance,
         coalesce((select sum(sp.amount_paid) from sale_payments sp where sp.sales_order_id = so.id), 0) as paid
    from sales_orders so
   where not so.voided and so.returned_total > 0
), changed as (
  update sales_orders so
     set balance = f.new_balance,
         payment_status = case when f.new_balance <= 0.005 then 'full'::pay_status
                               when f.paid <= 0 then 'unpaid'::pay_status
                               else 'part'::pay_status end
    from fixed f
   where so.id = f.id and abs(f.new_balance - f.old_balance) > 0.005
  returning so.id, so.tenant_id, f.old_balance, f.new_balance
)
insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
select tenant_id, null, 'balance_corrected', 'sales_orders', id::text,
       jsonb_build_object('old_balance', old_balance, 'new_balance', new_balance,
                          'why', 'A payment after a return had undone the return')
  from changed;

with fixed as (
  select po.id, po.tenant_id, po.balance as old_balance,
         po.total_amount - po.returned_total
           - coalesce((select sum(pp.amount_paid) from purchase_payments pp where pp.purchase_order_id = po.id), 0) as new_balance,
         coalesce((select sum(pp.amount_paid) from purchase_payments pp where pp.purchase_order_id = po.id), 0) as paid
    from purchase_orders po
   where not po.voided and po.returned_total > 0
), changed as (
  update purchase_orders po
     set balance = f.new_balance,
         payment_status = case when f.new_balance <= 0.005 then 'full'::pay_status
                               when f.paid <= 0 then 'unpaid'::pay_status
                               else 'part'::pay_status end
    from fixed f
   where po.id = f.id and abs(f.new_balance - f.old_balance) > 0.005
  returning po.id, po.tenant_id, f.old_balance, f.new_balance
)
insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
select tenant_id, null, 'balance_corrected', 'purchase_orders', id::text,
       jsonb_build_object('old_balance', old_balance, 'new_balance', new_balance,
                          'why', 'A payment after a return had undone the return')
  from changed;


-- ------------------------------------------------------------
-- 4. Expenses: void, VAT part, source, audit
-- ------------------------------------------------------------
alter table expenses add column if not exists voided     boolean not null default false;
alter table expenses add column if not exists voided_at  timestamptz;
alter table expenses add column if not exists voided_by  uuid references auth.users(id);
alter table expenses add column if not exists vat_amount numeric(14,2) not null default 0;
-- Where an automatic expense came from: 'till_pay_out' or 'payment_fee'.
alter table expenses add column if not exists source     text;
alter table expenses add column if not exists source_ref text;

do $$ begin
  alter table expenses add constraint expenses_vat_check check (vat_amount >= 0 and vat_amount <= amount);
exception when duplicate_object then null; end $$;

create unique index if not exists uq_expenses_source
  on expenses (tenant_id, source, source_ref) where source is not null;

create or replace function public.guard_expense_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- The engine (no signed-in user) may still clean up, e.g. deleting a tenant.
  if auth.uid() is null then return coalesce(NEW, OLD); end if;
  if TG_OP = 'DELETE' then
    raise exception 'Expenses can''t be deleted. Void it instead, so there is a record of it.'
      using errcode = 'insufficient_privilege';
  end if;
  if OLD.voided then
    raise exception 'This expense was voided and can''t be changed.';
  end if;
  if NEW.voided and not OLD.voided then
    NEW.voided_at := now();
    NEW.voided_by := auth.uid();
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_expense_change on expenses;
create trigger trg_guard_expense_change before update or delete on expenses
  for each row execute function public.guard_expense_change();

-- Every new, changed or voided expense goes into the activity log.
drop trigger if exists trg_audit_row_change on expenses;
create trigger trg_audit_row_change after insert or update or delete on expenses
  for each row execute function public.audit_row_change(
    'expense_date,expense_type_id,description,amount,vat_amount,payment_type_id,branch_id,voided', 'tenant_id');

-- Dashboard totals: skip voided expenses and the reclaimable VAT part.
do $$
declare v_def text; v_new text;
begin
  select pg_get_functiondef('public.dashboard_summary()'::regprocedure) into v_def;
  v_new := regexp_replace(v_def, 'sum\(amount\)(\s+)from expenses(\s+)where tenant_id = v_tenant',
                          'sum(amount - vat_amount)\1from expenses\2where not voided and tenant_id = v_tenant', 'g');
  v_new := regexp_replace(v_new, 'count\(\*\)(\s+)from expenses(\s+)where tenant_id = v_tenant',
                          'count(*)\1from expenses\2where not voided and tenant_id = v_tenant', 'g');
  if v_new = v_def or v_new !~ 'from expenses\s+where not voided' then
    raise exception 'dashboard_summary(): could not find the expense totals to update.';
  end if;
  execute v_new;
end $$;


-- ------------------------------------------------------------
-- 3. Till pay outs for a business cost become expenses
-- ------------------------------------------------------------
alter table cash_movements add column if not exists expense_id uuid references expenses(id) on delete set null;

drop function if exists public.add_cash_movement(text, numeric, text, jsonb);
create or replace function public.add_cash_movement(
  p_kind         text,
  p_amount       numeric,
  p_reason       text,
  p_approval     jsonb default null,
  p_expense_type uuid  default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_shift       uuid;
  v_branch      uuid;
  v_id          uuid;
  v_limit       numeric;
  v_approved_by uuid;
  v_cash_pt     uuid;
  v_expense     uuid;
begin
  if p_kind not in ('pay_in','pay_out','drop') then raise exception 'Unknown cash-movement kind.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'The amount has to be more than zero.'; end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required.'; end if;
  if p_expense_type is not null and p_kind <> 'pay_out' then
    raise exception 'Only money paid out can be an expense.';
  end if;

  v_shift := public.current_open_shift();
  if v_shift is null then raise exception 'Open your till first.'; end if;
  select branch_id into v_branch from shifts where id = v_shift;

  if p_kind = 'pay_out' and public.current_role() <> 'admin' then
    select coalesce((shift_rules->>'pay_out_limit')::numeric, 0) into v_limit from tenants where id = v_tenant;
    if v_limit > 0 and p_amount > v_limit then
      v_approved_by := nullif(p_approval->>'user_id', '')::uuid;
      if v_approved_by is null or not public.verify_approval_pin(v_approved_by, p_approval->>'pin') then
        raise exception 'A pay-out over ₦%s needs a manager''s PIN.', to_char(v_limit, 'FM999,999,999');
      end if;
    end if;
  end if;

  insert into cash_movements (tenant_id, shift_id, kind, amount, reason, created_by)
  values (v_tenant, v_shift, p_kind, p_amount, p_reason, auth.uid())
  returning id into v_id;

  if p_expense_type is not null then
    if not exists (select 1 from expense_types where id = p_expense_type and tenant_id = v_tenant) then
      raise exception 'That expense type does not belong to this company.';
    end if;
    select id into v_cash_pt from payment_types
     where tenant_id = v_tenant and method_group = 'cash' order by name limit 1;
    insert into expenses (tenant_id, branch_id, expense_date, expense_type_id, description, amount,
                          payment_type_id, created_by, source, source_ref)
    values (v_tenant, v_branch, public.shop_today(), p_expense_type, 'Paid from the till: ' || trim(p_reason),
            p_amount, v_cash_pt, auth.uid(), 'till_pay_out', v_id::text)
    returning id into v_expense;
    update cash_movements set expense_id = v_expense where id = v_id;
  end if;

  perform public.log_audit('cash_' || p_kind, 'cash_movements', v_id::text,
    jsonb_build_object('amount', p_amount, 'reason', p_reason, 'approved_by', v_approved_by, 'expense_id', v_expense));
  return v_id;
end $$;
grant execute on function public.add_cash_movement(text, numeric, text, jsonb, uuid) to authenticated;


-- ------------------------------------------------------------
-- 5. Books closed up to a date
-- ------------------------------------------------------------
alter table tenants add column if not exists books_closed_until date;

create or replace function public.guard_books_closed_date()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.books_closed_until is distinct from OLD.books_closed_until
     and NEW.books_closed_until is not null
     and NEW.books_closed_until >= public.shop_today() then
    raise exception 'Pick a date before today. Today''s work can''t be closed yet.';
  end if;
  return NEW;
end $$;
drop trigger if exists trg_guard_books_closed_date on tenants;
create trigger trg_guard_books_closed_date before update on tenants
  for each row execute function public.guard_books_closed_date();

-- Closing (or reopening) the books is logged like any other setting.
drop trigger if exists trg_audit_row_change on tenants;
create trigger trg_audit_row_change after insert or update or delete on tenants
  for each row execute function public.audit_row_change(
    'name,currency,vat_enabled,vat_rate,tin,cashier_returns,shift_rules,allow_expired_sale,expiry_warning_days,bank_details,pricing_rules,is_active,require_confirmed_transfer,books_closed_until',
    'id');

-- TG_ARGV[0]: the row's date column. TG_ARGV[1]: on UPDATE, the columns
-- that may not change for a closed date (anything else, such as a balance
-- going down when an old invoice is paid today, is fine).
create or replace function public.guard_closed_period()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_col    text := TG_ARGV[0];
  v_watch  text[] := string_to_array(coalesce(TG_ARGV[1], ''), ',');
  v_tenant uuid;
  v_lock   date;
  v_old    date;
  v_new    date;
  v_c      text;
  v_hit    boolean := false;
begin
  -- The engine itself (sample data, webhooks, migrations) is not blocked.
  if auth.uid() is null then return coalesce(NEW, OLD); end if;
  v_tenant := coalesce((to_jsonb(NEW) ->> 'tenant_id')::uuid, (to_jsonb(OLD) ->> 'tenant_id')::uuid);
  select books_closed_until into v_lock from tenants where id = v_tenant;
  if v_lock is null then return coalesce(NEW, OLD); end if;

  if TG_OP in ('UPDATE', 'DELETE') then v_old := (to_jsonb(OLD) ->> v_col)::date; end if;
  if TG_OP in ('UPDATE', 'INSERT') then v_new := (to_jsonb(NEW) ->> v_col)::date; end if;

  if TG_OP = 'INSERT' then
    v_hit := v_new <= v_lock;
  elsif TG_OP = 'DELETE' then
    v_hit := v_old <= v_lock;
  elsif v_old <= v_lock or v_new <= v_lock then
    foreach v_c in array v_watch loop
      if (to_jsonb(NEW) -> v_c) is distinct from (to_jsonb(OLD) -> v_c) then v_hit := true; end if;
    end loop;
  end if;

  if v_hit then
    raise exception 'The books are closed up to %. Anything dated on or before then can''t be added, changed or voided. The owner can change this in Settings.',
      to_char(v_lock, 'FMDD Mon YYYY')
      using errcode = 'check_violation';
  end if;
  return coalesce(NEW, OLD);
end $$;

do $$
declare g record;
begin
  for g in
    select * from (values
      ('sales_orders',      'transaction_date', 'transaction_date,total_amount,subtotal,vat_amount,cogs,gross_profit,voided,branch_id,customer_id'),
      ('purchase_orders',   'purchase_date',    'purchase_date,voided,branch_id,supplier_id,vat_amount'),
      ('expenses',          'expense_date',     'expense_date,amount,vat_amount,expense_type_id,voided,branch_id'),
      ('sale_payments',     'payment_date',     'payment_date,amount_paid'),
      ('purchase_payments', 'payment_date',     'payment_date,amount_paid'),
      ('sale_returns',      'return_date',      'return_date,total,voided'),
      ('purchase_returns',  'return_date',      'return_date,total,voided'),
      ('production_runs',   'production_date',  'production_date,qty_produced,expenses,voided')
    ) as t(tbl, col, watch)
  loop
    execute format('drop trigger if exists trg_guard_closed_period on %I;', g.tbl);
    execute format($f$
      create trigger trg_guard_closed_period before insert or update or delete on %I
      for each row execute function public.guard_closed_period(%L, %L);
    $f$, g.tbl, g.col, g.watch);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 7. Supplier VAT on a purchase
-- ------------------------------------------------------------
alter table purchase_orders add column if not exists vat_amount numeric(14,2) not null default 0;

-- Item prices stay without VAT (that is the stock's real cost); the VAT
-- is added on top, so the supplier is owed it and it can be claimed back.
create or replace function public.set_purchase_vat(p_purchase uuid, p_vat numeric)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_po      record;
  v_delta   numeric;
  v_balance numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('accounts') then
    raise exception 'Only the owner or accounts can change a purchase''s VAT.' using errcode = 'insufficient_privilege';
  end if;
  if p_vat is null or p_vat < 0 then raise exception 'VAT can''t be negative.'; end if;

  select * into v_po from purchase_orders where id = p_purchase and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase not found.'; end if;
  if v_po.voided then raise exception 'This purchase has been voided.'; end if;
  if coalesce(v_po.status, 'received') <> 'received' then
    raise exception 'Add the VAT once all the goods have been received.';
  end if;
  if p_vat > (v_po.total_amount - v_po.vat_amount) then
    raise exception 'The VAT can''t be more than the goods cost.';
  end if;

  v_delta   := round(p_vat, 2) - v_po.vat_amount;
  v_balance := v_po.balance + v_delta;
  update purchase_orders
     set vat_amount   = round(p_vat, 2),
         total_amount = total_amount + v_delta,
         balance      = v_balance,
         payment_status = case when v_balance <= 0.005 then 'full'::pay_status
                               when v_po.total_paid <= 0 then 'unpaid'::pay_status
                               else 'part'::pay_status end
   where id = p_purchase;

  perform public.log_audit('purchase_vat', 'purchase_orders', p_purchase::text,
    jsonb_build_object('old_vat', v_po.vat_amount, 'new_vat', round(p_vat, 2)));
end $$;
grant execute on function public.set_purchase_vat(uuid, numeric) to authenticated;


-- ------------------------------------------------------------
-- 2 + 6. Figures the reports need from the server
-- ------------------------------------------------------------
-- Stock losses, till short/over and store credit owed, for a date range.
create or replace function public.report_extras(p_from date default null, p_to date default null, p_branch uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('accounts') then
    raise exception 'Only the owner or accounts can see this.' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    -- Stock that went down without a sale: write-offs, damage, counts.
    'stock_loss', coalesce((
      select round(sum(total_cost), 2) from stock_adjustments
       where tenant_id = v_tenant and qty_delta < 0
         and (p_branch is null or branch_id = p_branch)
         and (p_from is null or (created_at at time zone 'Africa/Lagos')::date >= p_from)
         and (p_to   is null or (created_at at time zone 'Africa/Lagos')::date <= p_to)), 0),
    'stock_loss_count', (
      select count(*) from stock_adjustments
       where tenant_id = v_tenant and qty_delta < 0
         and (p_branch is null or branch_id = p_branch)
         and (p_from is null or (created_at at time zone 'Africa/Lagos')::date >= p_from)
         and (p_to   is null or (created_at at time zone 'Africa/Lagos')::date <= p_to)),
    -- Counted cash against expected at till close. Negative variance = short.
    'till_short', coalesce((
      select sum(-variance) from shifts
       where tenant_id = v_tenant and status = 'closed' and variance < 0
         and (p_branch is null or branch_id = p_branch)
         and (p_from is null or (closed_at at time zone 'Africa/Lagos')::date >= p_from)
         and (p_to   is null or (closed_at at time zone 'Africa/Lagos')::date <= p_to)), 0),
    'till_over', coalesce((
      select sum(variance) from shifts
       where tenant_id = v_tenant and status = 'closed' and variance > 0
         and (p_branch is null or branch_id = p_branch)
         and (p_from is null or (closed_at at time zone 'Africa/Lagos')::date >= p_from)
         and (p_to   is null or (closed_at at time zone 'Africa/Lagos')::date <= p_to)), 0),
    -- Owed to customers right now (not a range figure).
    'store_credit_owed', coalesce((
      select sum(credit_balance) from customers where tenant_id = v_tenant and credit_balance > 0), 0),
    'store_credit_customers', (
      select count(*) from customers where tenant_id = v_tenant and credit_balance > 0)
  );
end $$;
grant execute on function public.report_extras(date, date, uuid) to authenticated;

-- What stock on hand cost, per item, from the FIFO layers.
create or replace function public.report_stock_value(p_branch uuid default null)
returns table (product_kind text, product_id uuid, qty numeric, value_at_cost numeric)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('accounts') then
    raise exception 'Only the owner or accounts can see this.' using errcode = 'insufficient_privilege';
  end if;
  return query
    select 'finished_good'::text, fb.finished_good_id, sum(fb.qty_remaining), round(sum(fb.qty_remaining * fb.unit_cost), 2)
      from fg_batches fb
     where fb.tenant_id = v_tenant and fb.qty_remaining > 0 and (p_branch is null or fb.branch_id = p_branch)
     group by fb.finished_good_id
    union all
    select 'material'::text, pi.material_id, sum(pi.qty_remaining), round(sum(pi.qty_remaining * pi.cost_price), 2)
      from purchase_items pi
     where pi.tenant_id = v_tenant and pi.qty_remaining > 0 and pi.material_id is not null
       and (p_branch is null or pi.branch_id = p_branch)
     group by pi.material_id;
end $$;
grant execute on function public.report_stock_value(uuid) to authenticated;


-- ------------------------------------------------------------
-- 8. Payment provider charges (server only)
-- ------------------------------------------------------------
alter table incoming_payments add column if not exists fee numeric(14,2) not null default 0;

create or replace function public.record_payment_fee(
  p_tenant   uuid,
  p_provider text,
  p_ref      text,
  p_fee      numeric,
  p_branch   uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_type   uuid;
  v_branch uuid;
  v_id     uuid;
  v_label  text := case p_provider when 'monnify' then 'Moniepoint' when 'opay' then 'OPay'
                                   when 'paystack' then 'Paystack' else p_provider end;
begin
  if p_fee is null or p_fee <= 0 then return null; end if;

  update incoming_payments set fee = p_fee
   where tenant_id = p_tenant and provider = p_provider and provider_ref = p_ref;

  select id into v_type from expense_types
   where tenant_id = p_tenant and lower(name) = 'payment charges' limit 1;
  if v_type is null then
    insert into expense_types (tenant_id, name) values (p_tenant, 'Payment charges') returning id into v_type;
  end if;
  v_branch := coalesce(p_branch, public.default_branch_id(p_tenant));

  insert into expenses (tenant_id, branch_id, expense_date, expense_type_id, description, amount, source, source_ref)
  values (p_tenant, v_branch, public.shop_today(), v_type, v_label || ' charge on payment ' || p_ref,
          round(p_fee, 2), 'payment_fee', p_provider || ':' || p_ref)
  on conflict (tenant_id, source, source_ref) where source is not null do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.record_payment_fee(uuid, text, text, numeric, uuid) from public, anon, authenticated;
