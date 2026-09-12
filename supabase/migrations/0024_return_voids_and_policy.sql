-- ============================================================
-- StockFlow — Closing three gaps from the returns engine (0023)
--
--   1. A return recorded by mistake had no way back — void_sale_return()
--      and void_purchase_return() reverse one, precisely, using a new
--      table that records exactly which batch each returned unit went
--      back into (sale_return_consumption), so a partial return with
--      several earlier returns on the same line can be undone on its own
--      without touching the others.
--   2. Returns were only reachable from the Sales page. The engine itself
--      didn't change — POS.tsx now looks a sale up by its invoice number
--      and reuses the same create_sale_return() RPC.
--   3. Whether a cashier may process a return at all was hardcoded to
--      "their own sale, same day only." tenants.cashier_returns now makes
--      that a per-business setting: 'none' | 'same_day_own' | 'any'.
--
-- Run AFTER 0001–0023.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Cashier return policy, configurable per business
-- ------------------------------------------------------------
alter table tenants add column if not exists cashier_returns text not null default 'same_day_own'
  check (cashier_returns in ('none', 'same_day_own', 'any'));


-- ------------------------------------------------------------
-- 2. Exactly which batch a resellable return credited
-- ------------------------------------------------------------
-- sales_consumption.qty_returned (0023) is a single running total, so once
-- a line has had two separate returns there's no way to tell which one
-- came from where. This records it per return, so voiding one return
-- never touches what an earlier or later return already did.
create table if not exists sale_return_consumption (
  id                   uuid primary key default gen_random_uuid(),
  tenant_id            uuid not null references tenants(id) on delete cascade,
  sale_return_item_id  uuid not null references sale_return_items(id) on delete cascade,
  fg_batch_id          uuid references fg_batches(id) on delete set null,
  qty                  numeric(14,3) not null,
  unit_cost            numeric(14,2) not null
);
create index if not exists idx_src_item on sale_return_consumption (sale_return_item_id);

alter table sale_return_consumption enable row level security;
drop policy if exists sale_return_consumption_read on sale_return_consumption;
create policy sale_return_consumption_read on sale_return_consumption for select
  using (
    tenant_id = public.current_tenant_id()
    and public.has_role('sales','accounts')
    and exists (
      select 1 from sale_return_items sri join sale_returns sr on sr.id = sri.sale_return_id
       where sri.id = sale_return_item_id and public.can_see_branch(sr.branch_id))
  );
-- No write policy: only create_sale_return()/void_sale_return() touch it.

-- A refund payment needs to be findable (and reversible) by the return
-- that created it.
alter table sale_payments add column if not exists sale_return_id uuid references sale_returns(id) on delete set null;

-- voided/voided_at follow the same shape as sales_orders/purchase_orders,
-- and reuse the SAME guard_void/audit_void triggers (0017/0021) — no new
-- trigger logic needed, just attaching the existing ones.
alter table sale_returns     add column if not exists voided boolean not null default false;
alter table sale_returns     add column if not exists voided_at timestamptz;
alter table purchase_returns add column if not exists voided boolean not null default false;
alter table purchase_returns add column if not exists voided_at timestamptz;

do $$
declare v_tbl text;
begin
  foreach v_tbl in array array['sale_returns', 'purchase_returns'] loop
    execute format('drop trigger if exists trg_guard_void on %I;', v_tbl);
    execute format('create trigger trg_guard_void before update on %I
                    for each row execute function public.guard_void();', v_tbl);
    execute format('drop trigger if exists trg_audit_void on %I;', v_tbl);
    execute format('create trigger trg_audit_void after update of voided on %I
                    for each row execute function public.audit_void();', v_tbl);
  end loop;
end $$;

-- sale_returns/purchase_returns use `total`, not `total_amount`/`total_cost`.
create or replace function public.audit_void()
returns trigger language plpgsql security definer set search_path = public as $$
declare v jsonb := to_jsonb(NEW);
begin
  if NEW.voided and not OLD.voided then
    perform public.log_audit('void', TG_TABLE_NAME, NEW.id::text, jsonb_build_object(
      'doc_no', v->>'doc_no',
      'total',  coalesce(v->>'total_amount', v->>'total_cost', v->>'total')
    ));
  end if;
  return NEW;
end $$;


-- ------------------------------------------------------------
-- 3. create_sale_return: record the batch trail, respect the policy
-- ------------------------------------------------------------
create or replace function public.create_sale_return(
  p_sale             uuid,
  p_items            jsonb,
  p_reason           text default null,
  p_remainder_method text default 'cash',
  p_payment_type     uuid default null,
  p_date             date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_role     user_role := public.current_role();
  v_policy   text;
  v_so       record;
  v_date     date := coalesce(p_date, current_date);
  v_item     jsonb;
  v_line     record;
  v_ret_item_id uuid;
  v_qty      numeric;
  v_cond     text;
  v_line_subtotal numeric;
  v_line_vat      numeric;
  v_return_subtotal numeric := 0;
  v_return_vat      numeric := 0;
  v_cogs_reversed   numeric := 0;
  v_need numeric; v_take numeric; v_cons record;
  v_return_id uuid;
  v_doc_no text;
  v_applied numeric; v_remainder numeric; v_new_balance numeric;
  v_net_total numeric; v_status pay_status;
  v_any boolean := false;
  v_refund_id uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('sales','accounts') then
    raise exception 'Your role is not allowed to record a return.' using errcode = 'insufficient_privilege';
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — returns are read-only until billing is sorted out.';
  end if;
  if p_remainder_method not in ('cash','store_credit') then
    raise exception 'Unknown refund method %.', p_remainder_method;
  end if;

  select * into v_so from sales_orders where id = p_sale and tenant_id = v_tenant for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_so.voided then raise exception 'This sale is voided — there is nothing left to return.'; end if;
  if v_date < v_so.transaction_date then raise exception 'A return can''t be dated before the sale.'; end if;

  -- How far a cashier may go is a per-business setting (tenants.cashier_returns):
  -- 'none' (admin/accounts only), 'same_day_own' (the default), or 'any'.
  if v_role = 'sales' then
    select coalesce(cashier_returns, 'same_day_own') into v_policy from tenants where id = v_tenant;
    if v_policy = 'none' then
      raise exception 'Cashiers cannot process returns at this business — ask an admin or accounts.'
        using errcode = 'insufficient_privilege';
    end if;
    if v_policy <> 'any' and v_so.created_by is distinct from auth.uid() then
      raise exception 'You can only process returns for sales you rang up yourself.';
    end if;
    if v_policy = 'same_day_own' and v_so.transaction_date <> current_date then
      raise exception 'You can only return something the same day it was sold — ask an admin or accounts for an older sale.';
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A return needs at least one item.';
  end if;

  v_doc_no := public.next_doc_no(v_tenant, 'CN');
  insert into sale_returns(tenant_id, branch_id, sales_order_id, doc_no, return_date, reason, created_by)
  values (v_tenant, v_so.branch_id, p_sale, v_doc_no, v_date, nullif(trim(p_reason), ''), auth.uid())
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_line from sale_items
     where id = (v_item->>'sale_item_id')::uuid and sales_order_id = p_sale and tenant_id = v_tenant
       for update;
    if not found then raise exception 'That line does not belong to this sale.'; end if;

    v_qty  := (v_item->>'qty')::numeric;
    v_cond := coalesce(nullif(v_item->>'condition', ''), 'resellable');
    if v_cond not in ('resellable','damaged','expired') then
      raise exception 'Unknown condition %.', v_cond;
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every return line needs a quantity above zero.';
    end if;
    if v_qty > (v_line.quantity - v_line.qty_returned) then
      raise exception 'Only % of this line is still returnable — % of it has already come back.',
        v_line.quantity - v_line.qty_returned, v_line.qty_returned;
    end if;

    v_any := true;
    v_line_subtotal := v_qty * v_line.unit_price;
    v_line_vat      := round(v_line_subtotal * v_so.vat_rate / 100, 2);
    v_return_subtotal := v_return_subtotal + v_line_subtotal;
    v_return_vat      := v_return_vat + v_line_vat;

    update sale_items set qty_returned = qty_returned + v_qty where id = v_line.id;

    insert into sale_return_items(tenant_id, sale_return_id, sale_item_id, finished_good_id, qty, unit_price, amount, condition)
    values (v_tenant, v_return_id, v_line.id, v_line.finished_good_id, v_qty, v_line.unit_price, v_line_subtotal, v_cond)
    returning id into v_ret_item_id;

    -- Resellable: walk the FIFO trace newest draw first (the last batch
    -- this line took from) and put the stock straight back at its own
    -- cost — recorded per-return, so voiding this return later touches
    -- only what THIS return moved. Damaged/expired: the units don't come
    -- back and their cost stays a loss, so sales_consumption is untouched.
    if v_cond = 'resellable' then
      v_need := v_qty;
      for v_cons in
        select * from sales_consumption
         where sale_item_id = v_line.id and tenant_id = v_tenant and qty > qty_returned
         order by id desc
           for update
      loop
        exit when v_need <= 0;
        v_take := least(v_need, v_cons.qty - v_cons.qty_returned);
        update sales_consumption set qty_returned = qty_returned + v_take where id = v_cons.id;
        if v_cons.fg_batch_id is not null then
          update fg_batches set qty_remaining = qty_remaining + v_take
           where id = v_cons.fg_batch_id and tenant_id = v_tenant;
        end if;
        update finished_goods set qty_balance = qty_balance + v_take
         where id = v_line.finished_good_id and tenant_id = v_tenant;
        insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
        values (v_tenant, v_so.branch_id, 'finished_good', v_line.finished_good_id, 'RETURN', v_take, v_return_id, auth.uid());
        insert into sale_return_consumption(tenant_id, sale_return_item_id, fg_batch_id, qty, unit_cost)
        values (v_tenant, v_ret_item_id, v_cons.fg_batch_id, v_take, v_cons.unit_cost);
        v_cogs_reversed := v_cogs_reversed + v_take * v_cons.unit_cost;
        v_need := v_need - v_take;
      end loop;
      if v_need > 0 then
        raise exception 'Couldn''t trace % of this line back to what was actually sold — try a smaller quantity.', v_need;
      end if;
    end if;
  end loop;

  if not v_any then raise exception 'A return needs at least one item.'; end if;

  declare
    v_return_total  numeric := v_return_subtotal + v_return_vat;
    v_profit_impact numeric := v_return_subtotal - v_cogs_reversed;
  begin
    v_applied     := least(v_return_total, v_so.balance);
    v_remainder   := v_return_total - v_applied;
    v_new_balance := v_so.balance - v_applied;

    if v_remainder > 0 then
      if p_remainder_method = 'store_credit' then
        if v_so.customer_id is null then
          raise exception 'Store credit needs a named customer on this sale — pick one, or refund in cash instead.';
        end if;
        update customers set credit_balance = credit_balance + v_remainder
         where id = v_so.customer_id and tenant_id = v_tenant;
        insert into customer_credit_ledger(tenant_id, customer_id, amount, source_type, source_id)
        values (v_tenant, v_so.customer_id, v_remainder, 'return', v_return_id);
      else
        perform public.assert_same_tenant('payment_types', p_payment_type);
        insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id, reference, notes, sale_return_id)
        values (v_tenant, p_sale, -v_remainder, p_payment_type, 'RETURN', 'Refund for ' || v_doc_no, v_return_id)
        returning id into v_refund_id;
      end if;
    end if;

    v_net_total := v_so.total_amount - (v_so.returned_total + v_return_total);
    v_status := case
      when v_new_balance <= 0 then 'full'
      when v_new_balance >= v_net_total then 'unpaid'
      else 'part' end;

    update sale_returns
       set subtotal = v_return_subtotal, vat_amount = v_return_vat, total = v_return_total,
           cogs_reversed = v_cogs_reversed, applied_to_balance = v_applied,
           refunded        = case when p_remainder_method = 'cash'         then v_remainder else 0 end,
           to_store_credit = case when p_remainder_method = 'store_credit' then v_remainder else 0 end,
           refund_payment_type_id = case when p_remainder_method = 'cash' then p_payment_type else null end
     where id = v_return_id;

    update sales_orders
       set returned_total  = returned_total + v_return_total,
           returned_profit = returned_profit + v_profit_impact,
           balance         = v_new_balance,
           payment_status  = v_status
     where id = p_sale;
  end;

  perform public.log_audit('return', 'sales_orders', p_sale::text,
    jsonb_build_object('return_id', v_return_id, 'doc_no', v_doc_no, 'total', v_return_subtotal + v_return_vat));

  return v_return_id;
end $$;

-- A sale can be voided again once every return against it has itself
-- been voided.
create or replace function public.void_sale(p_sale uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row record;
  v_item record;
begin
  select * into v_row from sales_orders where id = p_sale and tenant_id = v_tenant for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_row.voided then raise exception 'Sale is already voided'; end if;
  if exists (select 1 from sale_returns where sales_order_id = p_sale and not voided) then
    raise exception 'This sale has a return recorded against it — use a return to adjust it further; it can''t be voided as a whole.';
  end if;

  for v_item in
    select sc.fg_batch_id, sc.finished_good_id, sc.qty
      from sales_consumption sc
      join sale_items si on si.id = sc.sale_item_id
     where si.sales_order_id = p_sale and sc.tenant_id = v_tenant
  loop
    if v_item.fg_batch_id is not null then
      update fg_batches set qty_remaining = qty_remaining + v_item.qty
       where id = v_item.fg_batch_id and tenant_id = v_tenant;
    end if;

    update finished_goods set qty_balance = qty_balance + v_item.qty
     where id = v_item.finished_good_id and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_row.branch_id, 'finished_good', v_item.finished_good_id, 'ADJUSTMENT', v_item.qty, p_sale, auth.uid());
  end loop;

  update sales_orders set voided = true, voided_at = now() where id = p_sale;
end $$;


-- ------------------------------------------------------------
-- 4. Voiding a return: precise, and refused where it can't be trusted
-- ------------------------------------------------------------
-- Admin-only (enforced by the guard_void trigger this shares with every
-- other void in the app) — refused outright rather than left half-done if
-- the stock has moved on or the store credit has already been spent.
create or replace function public.void_sale_return(p_return uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_ret    record;
  v_so     record;
  v_item   record;
  v_cons   record;
  v_credit numeric;
  v_new_balance numeric;
  v_net_total   numeric;
  v_status pay_status;
begin
  select * into v_ret from sale_returns where id = p_return and tenant_id = v_tenant for update;
  if not found then raise exception 'Return not found'; end if;
  if v_ret.voided then raise exception 'This return is already voided'; end if;

  select * into v_so from sales_orders where id = v_ret.sales_order_id and tenant_id = v_tenant for update;
  if not found then raise exception 'The sale this return belongs to no longer exists.'; end if;

  -- Refuse rather than half-undo: check every batch has enough left, and
  -- that any store credit issued hasn't already been spent, BEFORE
  -- touching anything.
  for v_item in
    select src.fg_batch_id, src.qty, sri.finished_good_id
      from sale_return_consumption src
      join sale_return_items sri on sri.id = src.sale_return_item_id
     where sri.sale_return_id = p_return and src.tenant_id = v_tenant
  loop
    if v_item.fg_batch_id is not null and exists (
      select 1 from fg_batches where id = v_item.fg_batch_id and qty_remaining < v_item.qty
    ) then
      raise exception 'Some of what this return put back on the shelf has already been sold or moved elsewhere — this return can''t be undone.';
    end if;
  end loop;

  if v_ret.to_store_credit > 0 then
    select credit_balance into v_credit from customers where id = v_so.customer_id and tenant_id = v_tenant for update;
    if coalesce(v_credit, 0) < v_ret.to_store_credit then
      raise exception 'This customer has already spent some of the store credit from this return — it can''t be undone.';
    end if;
  end if;

  -- Reverse the stock, batch by batch, exactly as it was credited.
  for v_item in
    select sri.id as item_id, sri.sale_item_id, sri.finished_good_id, sri.qty as line_qty, sri.condition
      from sale_return_items sri where sri.sale_return_id = p_return
  loop
    update sale_items set qty_returned = qty_returned - v_item.line_qty where id = v_item.sale_item_id;

    if v_item.condition = 'resellable' then
      for v_cons in
        select * from sale_return_consumption where sale_return_item_id = v_item.item_id
      loop
        if v_cons.fg_batch_id is not null then
          update fg_batches set qty_remaining = qty_remaining - v_cons.qty
           where id = v_cons.fg_batch_id and tenant_id = v_tenant;
          -- Give the reversed units back their place in the FIFO/FEFO
          -- queue: sales_consumption.qty_returned is what "how much of
          -- this draw is currently out" means, so voiding the return
          -- that brought it back in reduces that figure again. A
          -- (sale_item, batch) pair is drawn from at most once per sale,
          -- so this always matches the one row that return came from.
          update sales_consumption set qty_returned = greatest(qty_returned - v_cons.qty, 0)
           where fg_batch_id = v_cons.fg_batch_id and sale_item_id = v_item.sale_item_id and qty_returned > 0;
        end if;
        update finished_goods set qty_balance = qty_balance - v_cons.qty
         where id = v_item.finished_good_id and tenant_id = v_tenant;
        insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
        values (v_tenant, v_ret.branch_id, 'finished_good', v_item.finished_good_id, 'ADJUSTMENT', -v_cons.qty, p_return, auth.uid());
      end loop;
    end if;
  end loop;

  -- Undo the money: restore the balance this return had paid down, and
  -- claw back whatever was refunded or credited.
  v_new_balance := v_so.balance + v_ret.applied_to_balance;

  if v_ret.refunded > 0 then
    delete from sale_payments where sale_return_id = p_return;
  end if;

  if v_ret.to_store_credit > 0 then
    update customers set credit_balance = credit_balance - v_ret.to_store_credit
     where id = v_so.customer_id and tenant_id = v_tenant;
    insert into customer_credit_ledger(tenant_id, customer_id, amount, source_type, source_id)
    values (v_tenant, v_so.customer_id, -v_ret.to_store_credit, 'return_void', p_return);
  end if;

  v_net_total := v_so.total_amount - (v_so.returned_total - v_ret.total);
  v_status := case
    when v_new_balance <= 0 then 'full'
    when v_new_balance >= v_net_total then 'unpaid'
    else 'part' end;

  update sales_orders
     set returned_total  = returned_total  - v_ret.total,
         returned_profit = returned_profit - (v_ret.subtotal - v_ret.cogs_reversed),
         balance         = v_new_balance,
         payment_status  = v_status
   where id = v_ret.sales_order_id;

  update sale_returns set voided = true, voided_at = now() where id = p_return;
end $$;


-- ------------------------------------------------------------
-- 5. Purchase returns: a cleaner payment-status formula, and a void
-- ------------------------------------------------------------
create or replace function public.create_purchase_return(
  p_purchase uuid,
  p_items    jsonb,
  p_reason   text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_po     record;
  v_item   jsonb;
  v_line   record;
  v_qty    numeric;
  v_total  numeric := 0;
  v_return_id uuid;
  v_doc_no text;
  v_any boolean := false;
  v_new_balance numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('inventory','accounts') then
    raise exception 'Your role is not allowed to return goods to a supplier.' using errcode = 'insufficient_privilege';
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — returns are read-only until billing is sorted out.';
  end if;

  select * into v_po from purchase_orders where id = p_purchase and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase not found'; end if;
  if v_po.voided then raise exception 'This purchase is voided — there is nothing left to return.'; end if;
  if public.current_role() <> 'admin' and v_po.branch_id is distinct from public.work_branch_id() then
    raise exception 'You can only return goods bought at your own branch (%).', public.branch_name(v_po.branch_id);
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A supplier return needs at least one item.';
  end if;

  v_doc_no := public.next_doc_no(v_tenant, 'SR');
  insert into purchase_returns(tenant_id, branch_id, purchase_order_id, doc_no, return_date, reason, created_by)
  values (v_tenant, v_po.branch_id, p_purchase, v_doc_no, current_date, nullif(trim(p_reason), ''), auth.uid())
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_line from purchase_items
     where id = (v_item->>'purchase_item_id')::uuid and purchase_order_id = p_purchase and tenant_id = v_tenant
       for update;
    if not found then raise exception 'That item does not belong to this purchase.'; end if;

    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every return line needs a quantity above zero.'; end if;
    if v_qty > v_line.qty_remaining then
      raise exception 'Only % of this batch is still unused — % has already gone into production or another branch.',
        v_line.qty_remaining, v_line.qty - v_line.qty_remaining;
    end if;

    v_any := true;
    update purchase_items set qty_remaining = qty_remaining - v_qty where id = v_line.id;
    update materials set qty_balance = qty_balance - v_qty where id = v_line.material_id and tenant_id = v_tenant;
    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_po.branch_id, 'material', v_line.material_id, 'SUPPLIER_RETURN', -v_qty, v_return_id, auth.uid());

    insert into purchase_return_items(tenant_id, purchase_return_id, purchase_item_id, material_id, qty, cost_price, amount)
    values (v_tenant, v_return_id, v_line.id, v_line.material_id, v_qty, v_line.cost_price, v_qty * v_line.cost_price);

    v_total := v_total + v_qty * v_line.cost_price;
  end loop;

  if not v_any then raise exception 'A supplier return needs at least one item.'; end if;

  update purchase_returns set total = v_total where id = v_return_id;

  -- Balance can go negative on purpose: once you've returned more than
  -- you still owed, the supplier owes YOU. Reports.tsx only lists
  -- positive balances as owing, so a credit like this simply drops off
  -- Creditors.
  v_new_balance := v_po.balance - v_total;
  update purchase_orders
     set returned_total = returned_total + v_total,
         balance        = v_new_balance,
         payment_status = case when v_new_balance <= 0 then 'full'::pay_status
                               when v_po.total_paid > 0  then 'part'::pay_status
                               else 'unpaid'::pay_status end
   where id = p_purchase;

  perform public.log_audit('supplier_return', 'purchase_orders', p_purchase::text,
    jsonb_build_object('return_id', v_return_id, 'doc_no', v_doc_no, 'total', v_total));

  return v_return_id;
end $$;

create or replace function public.void_purchase_return(p_return uuid)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_ret record;
  v_po  record;
  v_item record;
  v_new_balance numeric;
begin
  select * into v_ret from purchase_returns where id = p_return and tenant_id = v_tenant for update;
  if not found then raise exception 'Return not found'; end if;
  if v_ret.voided then raise exception 'This return is already voided'; end if;

  select * into v_po from purchase_orders where id = v_ret.purchase_order_id and tenant_id = v_tenant for update;
  if not found then raise exception 'The purchase this return belongs to no longer exists.'; end if;

  for v_item in
    select * from purchase_return_items where purchase_return_id = p_return
  loop
    update purchase_items set qty_remaining = qty_remaining + v_item.qty
     where id = v_item.purchase_item_id and tenant_id = v_tenant;
    update materials set qty_balance = qty_balance + v_item.qty
     where id = v_item.material_id and tenant_id = v_tenant;
    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_ret.branch_id, 'material', v_item.material_id, 'ADJUSTMENT', v_item.qty, p_return, auth.uid());
  end loop;

  v_new_balance := v_po.balance + v_ret.total;
  update purchase_orders
     set returned_total = returned_total - v_ret.total,
         balance        = v_new_balance,
         payment_status = case when v_new_balance <= 0 then 'full'::pay_status
                               when v_po.total_paid > 0  then 'part'::pay_status
                               else 'unpaid'::pay_status end
   where id = v_ret.purchase_order_id;

  update purchase_returns set voided = true, voided_at = now() where id = p_return;
end $$;


-- ------------------------------------------------------------
-- 6. Reporting: voided returns don't count
-- ------------------------------------------------------------
-- report_product_profitability needs no change: it reads sale_items.qty_returned
-- and sales_consumption.qty_returned directly, and void_sale_return already
-- moves those back down, so it stays correct on its own.
create or replace function public.report_returns(
  p_from   date default null,
  p_to     date default null,
  p_branch uuid default null
)
returns table (
  fg_id          uuid,
  product_name   text,
  qty_returned   numeric,
  value_returned numeric,
  resellable_qty numeric,
  loss_value     numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('accounts') then
    raise exception 'Only admin and accounts can see the returns report.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select sri.finished_good_id, fg.name,
         sum(sri.qty),
         sum(sri.amount),
         coalesce(sum(sri.qty)    filter (where sri.condition = 'resellable'), 0),
         coalesce(sum(sri.amount) filter (where sri.condition <> 'resellable'), 0)
    from sale_return_items sri
    join sale_returns   sr on sr.id = sri.sale_return_id
    join finished_goods fg on fg.id = sri.finished_good_id
   where sri.tenant_id = public.current_tenant_id()
     and not sr.voided
     and (p_from   is null or sr.return_date >= p_from)
     and (p_to     is null or sr.return_date <= p_to)
     and (p_branch is null or sr.branch_id = p_branch)
   group by sri.finished_good_id, fg.name
   order by sum(sri.amount) desc;
end $$;

create or replace function public.dashboard_summary()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid      := public.current_tenant_id();
  v_role   user_role := public.current_role();
  v_uid    uuid      := auth.uid();
  v_today  date      := current_date;
  v_branch uuid;
  v_multi  boolean;
  v_out    jsonb;
  v_common jsonb;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.my_branch_id();
  select type = 'multi_branch' into v_multi from tenants where id = v_tenant;

  select jsonb_build_object(
    'role',          v_role,
    'account_live',  public.tenant_is_live(),
    'multi_branch',  coalesce(v_multi, false),
    'branch_id',     v_branch,
    'branch_name',   public.branch_name(v_branch),
    'low_goods_count', (
      select count(*) from public.stock_levels(case when v_role in ('admin','accounts') then null else v_branch end) s
       where s.product_kind = 'finished_good' and s.qty <= s.min_level),
    'low_materials_count', (
      select count(*) from public.stock_levels(case when v_role in ('admin','accounts') then null else v_branch end) s
       where s.product_kind = 'material' and s.qty <= s.min_level),
    'low_stock', (
      select coalesce(jsonb_agg(x), '[]'::jsonb) from (
        select jsonb_build_object(
                 'kind', s.product_kind, 'name', s.name, 'qty', s.qty, 'unit', s.unit,
                 'min', s.min_level, 'branch', s.branch_name) as x
          from public.stock_levels(case when v_role in ('admin','accounts') then null else v_branch end) s
         where s.qty <= s.min_level
         order by (s.qty <= 0) desc, s.qty asc, s.name
         limit 12) q)
  ) into v_common;

  if v_role = 'sales' then
    select v_common || jsonb_build_object(
      'today_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today), 0)
        - coalesce((
        select sum(total) from sale_returns
         where tenant_id = v_tenant and branch_id = v_branch and not voided and return_date = v_today), 0),
      'today_count', (
        select count(*) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today),
      'my_today_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today and created_by = v_uid), 0)
        - coalesce((
        select sum(sr.total) from sale_returns sr join sales_orders so on so.id = sr.sales_order_id
         where sr.tenant_id = v_tenant and not sr.voided and sr.return_date = v_today and so.created_by = v_uid), 0),
      'my_today_count', (
        select count(*) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today and created_by = v_uid),
      'today_unpaid', coalesce((
        select sum(balance) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today), 0),
      'yesterday_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today - 1), 0)
        - coalesce((
        select sum(total) from sale_returns
         where tenant_id = v_tenant and branch_id = v_branch and not voided and return_date = v_today - 1), 0),
      'my_recent', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', so.id, 'date', so.transaction_date,
                   'total', so.total_amount, 'balance', so.balance, 'status', so.payment_status,
                   'customer', coalesce(
                     nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                     c.company_store, 'Walk-in')) as x
            from sales_orders so
            left join customers c on c.id = so.customer_id
           where so.tenant_id = v_tenant and not so.voided and so.created_by = v_uid
           order by so.created_at desc
           limit 8) s),
      'week_trend', (
        select coalesce(jsonb_agg(x order by x->>'day'), '[]'::jsonb) from (
          select jsonb_build_object('day', transaction_date::text, 'total', sum(total_amount)) as x
            from sales_orders
           where tenant_id = v_tenant and branch_id = v_branch and not voided
             and transaction_date >= v_today - 6
           group by transaction_date) s)
    ) into v_out;

  elsif v_role = 'inventory' then
    select v_common || jsonb_build_object(
      'out_of_stock_count', (
        select count(*) from public.stock_levels(v_branch) s where s.qty <= 0),
      'stock_items', (
        select count(*) from public.stock_levels(v_branch) s),
      'production_this_month', coalesce((
        select sum(qty_produced) from production_runs
         where tenant_id = v_tenant and branch_id = v_branch and not voided
           and production_date >= date_trunc('month', v_today)), 0),
      'production_runs_this_month', (
        select count(*) from production_runs
         where tenant_id = v_tenant and branch_id = v_branch and not voided
           and production_date >= date_trunc('month', v_today)),
      'open_purchases', (
        select count(*) from purchase_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and balance > 0),
      'recent_production', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select jsonb_build_object('id', pr.id, 'date', pr.production_date,
                                    'product', fg.name, 'qty', pr.qty_produced) as x
            from production_runs pr
            join finished_goods fg on fg.id = pr.finished_good_id
           where pr.tenant_id = v_tenant and pr.branch_id = v_branch and not pr.voided
           order by pr.created_at desc limit 6) s),
      'recent_movements', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select jsonb_build_object('id', sm.id, 'type', sm.movement_type,
                                    'qty', sm.quantity, 'kind', sm.product_kind, 'at', sm.created_at,
                                    'name', coalesce(
                                      (select m.name from materials m where m.id = sm.product_id),
                                      (select g.name from finished_goods g where g.id = sm.product_id))) as x
            from stock_movements sm
           where sm.tenant_id = v_tenant and sm.branch_id = v_branch
           order by sm.created_at desc limit 8) s)
    ) into v_out;

  else
    select v_common || jsonb_build_object(
      'total_sales',     coalesce((select sum(total_amount - returned_total) from sales_orders where tenant_id = v_tenant and not voided), 0),
      'sales_count',     (select count(*)                   from sales_orders    where tenant_id = v_tenant and not voided),
      'gross_profit',    coalesce((select sum(gross_profit - returned_profit) from sales_orders where tenant_id = v_tenant and not voided), 0),
      'outstanding',     coalesce((select sum(balance)      from sales_orders    where tenant_id = v_tenant and not voided), 0),
      'total_purchases', coalesce((select sum(total_amount - returned_total) from purchase_orders where tenant_id = v_tenant and not voided), 0),
      'purchase_count',  (select count(*)                   from purchase_orders where tenant_id = v_tenant and not voided),
      'creditors',       coalesce((select sum(balance)      from purchase_orders where tenant_id = v_tenant and not voided and balance > 0), 0),
      'total_expenses',  coalesce((select sum(amount)       from expenses        where tenant_id = v_tenant), 0),
      'expense_count',   (select count(*)                   from expenses        where tenant_id = v_tenant),
      'month_sales',       coalesce((select sum(total_amount) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr where sr.tenant_id = v_tenant and not sr.voided
                                      and sr.return_date >= date_trunc('month', v_today)), 0),
      'month_sales_count', (select count(*) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today)),
      'month_profit',      coalesce((select sum(gross_profit) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.subtotal - sr.cogs_reversed) from sale_returns sr where sr.tenant_id = v_tenant and not sr.voided
                                      and sr.return_date >= date_trunc('month', v_today)), 0),
      'month_expenses',    coalesce((select sum(amount) from expenses where tenant_id = v_tenant
                                      and expense_date >= date_trunc('month', v_today)), 0),
      'last_month_sales',  coalesce((select sum(total_amount) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today) - interval '1 month'
                                      and transaction_date <= (v_today - interval '1 month')::date), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr where sr.tenant_id = v_tenant and not sr.voided
                                      and sr.return_date >= date_trunc('month', v_today) - interval '1 month'
                                      and sr.return_date <= (v_today - interval '1 month')::date), 0),
      'last_month_profit', coalesce((select sum(gross_profit) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today) - interval '1 month'
                                      and transaction_date <= (v_today - interval '1 month')::date), 0)
                          - coalesce((select sum(sr.subtotal - sr.cogs_reversed) from sale_returns sr where sr.tenant_id = v_tenant and not sr.voided
                                      and sr.return_date >= date_trunc('month', v_today) - interval '1 month'
                                      and sr.return_date <= (v_today - interval '1 month')::date), 0),
      'month_trend', (
        select coalesce(jsonb_agg(x order by x->>'month'), '[]'::jsonb) from (
          select jsonb_build_object(
                   'month', to_char(date_trunc('month', transaction_date), 'YYYY-MM'),
                   'label', to_char(date_trunc('month', transaction_date), 'Mon YY'),
                   'total', sum(total_amount)) as x
            from sales_orders
           where tenant_id = v_tenant and not voided
             and transaction_date >= (date_trunc('month', v_today) - interval '11 months')
           group by date_trunc('month', transaction_date)) s),
      'recent_sales', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', so.id, 'date', so.transaction_date,
                   'total', so.total_amount, 'status', so.payment_status,
                   'branch', b.name,
                   'customer', coalesce(
                     nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                     c.company_store, 'Walk-in')) as x
            from sales_orders so
            left join customers c on c.id = so.customer_id
            left join branches  b on b.id = so.branch_id
           where so.tenant_id = v_tenant and not so.voided
           order by so.created_at desc limit 6) s),
      'reminders', (
        select coalesce(jsonb_agg(x order by (x->>'balance')::numeric desc), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', c.id,
                   'name', coalesce(
                     nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''),
                     c.company_store, 'Customer'),
                   'phone', c.phone,
                   'balance', sum(so.balance),
                   'days', max(v_today - so.transaction_date)) as x
            from sales_orders so
            join customers c on c.id = so.customer_id
           where so.tenant_id = v_tenant and not so.voided and so.balance > 0
             and (c.last_reminded_at is null or c.last_reminded_at < now() - interval '3 days')
           group by c.id, c.first_name, c.last_name, c.company_store, c.phone
          having max(v_today - so.transaction_date) >= 14
           limit 8) s),
      'by_branch', (
        select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', b.id,
                   'name', b.name,
                   'today', coalesce((select sum(so.total_amount) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date = v_today), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr
                                       where sr.tenant_id = v_tenant and sr.branch_id = b.id and not sr.voided
                                         and sr.return_date = v_today), 0),
                   'month', coalesce((select sum(so.total_amount) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr
                                       where sr.tenant_id = v_tenant and sr.branch_id = b.id and not sr.voided
                                         and sr.return_date >= date_trunc('month', v_today)), 0),
                   'month_profit', coalesce((select sum(so.gross_profit) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.subtotal - sr.cogs_reversed) from sale_returns sr
                                       where sr.tenant_id = v_tenant and sr.branch_id = b.id and not sr.voided
                                         and sr.return_date >= date_trunc('month', v_today)), 0),
                   'outstanding', coalesce((select sum(so.balance) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided), 0),
                   'low_stock', (select count(*) from public.stock_levels(b.id) s where s.qty <= s.min_level)
                 ) as x
            from branches b
           where b.tenant_id = v_tenant and b.is_active) s)
    ) into v_out;
  end if;

  return v_out;
end $$;


-- ------------------------------------------------------------
-- 7. Grants
-- ------------------------------------------------------------
grant execute on function public.create_sale_return(uuid, jsonb, text, text, uuid, date) to authenticated;
grant execute on function public.void_sale_return(uuid)                                   to authenticated;
grant execute on function public.create_purchase_return(uuid, jsonb, text)                 to authenticated;
grant execute on function public.void_purchase_return(uuid)                                to authenticated;
grant execute on function public.void_sale(uuid)                                           to authenticated;
grant execute on function public.report_returns(date, date, uuid)                          to authenticated;
grant execute on function public.dashboard_summary()                                       to authenticated;
