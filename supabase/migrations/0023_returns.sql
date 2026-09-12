-- ============================================================
-- StockFlow — Returns and credit notes
--
-- Until now the only way to reverse a sale was void_sale, all or nothing.
-- A customer bringing back 2 of the 10 cartons they bought had nowhere to
-- go, and the fix (edit or delete the sale) would have rewritten history —
-- a return next month has no business changing last month's numbers.
--
-- After this migration:
--   • create_sale_return() handles a PARTIAL return, line by line. Resellable
--     stock goes back to the exact batch it left, cost and all; damaged or
--     expired stock does not restock, and its cost stays a loss.
--   • Money is applied in order: first it reduces what the customer still
--     owes, then whatever is left over is refunded in cash/transfer or
--     turned into store credit for a named customer.
--   • total_amount, gross_profit and cogs on the original sale are never
--     edited — they stay exactly as invoiced. Two running columns
--     (returned_total, returned_profit) track the adjustment, and reports
--     net against the RETURN's own date, not the original sale's date, so
--     a return in October leaves September's P&L untouched.
--   • void_sale now refuses a sale that has a return against it.
--   • create_purchase_return() mirrors this for goods sent back to a
--     supplier, drawn from the exact purchase batch, only from what's
--     still unused.
--
-- Run AFTER 0001–0022.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Ledger types and columns
-- ------------------------------------------------------------
alter type movement_type add value if not exists 'RETURN';
alter type movement_type add value if not exists 'SUPPLIER_RETURN';

alter table sales_orders add column if not exists returned_total  numeric(14,2) not null default 0;
alter table sales_orders add column if not exists returned_profit numeric(14,2) not null default 0;
alter table sale_items   add column if not exists qty_returned    numeric(14,3) not null default 0;
-- How much of each FIFO draw has already been given back to stock, so a
-- second partial return on the same line knows which units are still
-- "out" rather than re-crediting a batch that was already restocked.
alter table sales_consumption add column if not exists qty_returned numeric(14,3) not null default 0;

alter table purchase_orders add column if not exists returned_total numeric(14,2) not null default 0;

alter table customers add column if not exists credit_balance numeric(14,2) not null default 0;

create table if not exists customer_credit_ledger (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  amount      numeric(14,2) not null,   -- + issued (from a return), - spent (on a sale)
  source_type text not null,            -- 'return' | 'sale'
  source_id   uuid,
  created_at  timestamptz not null default now()
);
create index if not exists idx_credit_ledger_customer on customer_credit_ledger (tenant_id, customer_id, created_at desc);


-- ------------------------------------------------------------
-- 2. Customer returns
-- ------------------------------------------------------------
create table if not exists sale_returns (
  id                     uuid primary key default gen_random_uuid(),
  tenant_id              uuid not null references tenants(id) on delete cascade,
  branch_id              uuid references branches(id) on delete set null,
  sales_order_id         uuid not null references sales_orders(id) on delete cascade,
  doc_no                 text,                  -- CN-000123
  return_date            date not null default current_date,
  reason                 text,
  subtotal               numeric(14,2) not null default 0,
  vat_amount             numeric(14,2) not null default 0,
  total                  numeric(14,2) not null default 0,
  cogs_reversed          numeric(14,2) not null default 0,   -- only the resellable lines
  applied_to_balance     numeric(14,2) not null default 0,
  refunded               numeric(14,2) not null default 0,   -- cash/transfer paid back
  to_store_credit        numeric(14,2) not null default 0,
  refund_payment_type_id uuid references payment_types(id) on delete set null,
  created_by             uuid references auth.users(id),
  created_at             timestamptz not null default now()
);

create table if not exists sale_return_items (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  sale_return_id uuid not null references sale_returns(id) on delete cascade,
  sale_item_id   uuid not null references sale_items(id) on delete restrict,
  finished_good_id uuid not null references finished_goods(id) on delete restrict,
  qty            numeric(14,3) not null,
  unit_price     numeric(14,2) not null,
  amount         numeric(14,2) not null default 0,
  condition      text not null default 'resellable' check (condition in ('resellable','damaged','expired'))
);

create unique index if not exists uq_sale_returns_doc_no on sale_returns (tenant_id, doc_no);
create index if not exists idx_sale_returns_sale   on sale_returns (tenant_id, sales_order_id);
create index if not exists idx_sale_returns_date   on sale_returns (tenant_id, return_date);
create index if not exists idx_sale_return_items_return on sale_return_items (sale_return_id);

alter table sale_returns      enable row level security;
alter table sale_return_items enable row level security;
alter table customer_credit_ledger enable row level security;

drop policy if exists sale_returns_read on sale_returns;
create policy sale_returns_read on sale_returns for select
  using (
    tenant_id = public.current_tenant_id()
    and public.has_role('sales','accounts')
    and public.can_see_branch(branch_id)
  );
drop policy if exists sale_return_items_read on sale_return_items;
create policy sale_return_items_read on sale_return_items for select
  using (
    tenant_id = public.current_tenant_id()
    and public.has_role('sales','accounts')
    and exists (select 1 from sale_returns sr where sr.id = sale_return_id and public.can_see_branch(sr.branch_id))
  );
drop policy if exists credit_ledger_read on customer_credit_ledger;
create policy credit_ledger_read on customer_credit_ledger for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales','accounts'));
-- No write policies anywhere here: only create_sale_return() writes these.

drop trigger if exists trg_guard_write on sale_returns;
create trigger trg_guard_write before insert on sale_returns
  for each row execute function public.guard_money_write('admin,sales,accounts', 'record a return');


-- ------------------------------------------------------------
-- 3. The return engine
-- ------------------------------------------------------------
-- p_items: [{ "sale_item_id": uuid, "qty": numeric, "condition": "resellable"|"damaged"|"expired" }]
-- p_remainder_method: what happens to whatever is left AFTER the return has
-- first paid down the customer's balance — 'cash' records a refund payment
-- (needs p_payment_type); 'store_credit' needs the sale to have a customer.
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
  v_so       record;
  v_date     date := coalesce(p_date, current_date);
  v_item     jsonb;
  v_line     record;
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

  -- Cashiers: their own sales, same day only. Admin and accounts: anything.
  if v_role = 'sales' then
    if v_so.created_by is distinct from auth.uid() then
      raise exception 'You can only process returns for sales you rang up yourself.';
    end if;
    if v_so.transaction_date <> current_date then
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

    -- Resellable: walk the FIFO trace newest draw first (the last batch
    -- this line took from) and put the stock straight back at its own cost.
    -- Damaged/expired: the units don't come back and their cost stays a
    -- loss, so sales_consumption is left untouched.
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
        v_cogs_reversed := v_cogs_reversed + v_take * v_cons.unit_cost;
        v_need := v_need - v_take;
      end loop;
      if v_need > 0 then
        raise exception 'Couldn''t trace % of this line back to what was actually sold — try a smaller quantity.', v_need;
      end if;
    end if;

    insert into sale_return_items(tenant_id, sale_return_id, sale_item_id, finished_good_id, qty, unit_price, amount, condition)
    values (v_tenant, v_return_id, v_line.id, v_line.finished_good_id, v_qty, v_line.unit_price, v_line_subtotal, v_cond);
  end loop;

  if not v_any then raise exception 'A return needs at least one item.'; end if;

  declare
    v_return_total  numeric := v_return_subtotal + v_return_vat;
    v_profit_impact numeric := v_return_subtotal - v_cogs_reversed;
  begin
    -- Money: pay down the balance first; whatever is left goes out as a
    -- refund or store credit. total_amount/gross_profit are never touched —
    -- returned_total/returned_profit carry the adjustment instead.
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
        insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id, reference, notes)
        values (v_tenant, p_sale, -v_remainder, p_payment_type, 'RETURN', 'Refund for ' || v_doc_no);
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

-- A sale with a return is adjusted through further returns, not voided
-- whole — voiding it now would double-restock whatever the return already
-- put back, and would erase a credit note that's already been issued.
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
  if exists (select 1 from sale_returns where sales_order_id = p_sale) then
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
-- 4. Supplier returns
-- ------------------------------------------------------------
create table if not exists purchase_returns (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  branch_id         uuid references branches(id) on delete set null,
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  doc_no            text,            -- SR-000045
  return_date       date not null default current_date,
  reason            text,
  total             numeric(14,2) not null default 0,
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now()
);

create table if not exists purchase_return_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  purchase_return_id uuid not null references purchase_returns(id) on delete cascade,
  purchase_item_id  uuid not null references purchase_items(id) on delete restrict,
  material_id       uuid not null references materials(id) on delete restrict,
  qty               numeric(14,3) not null,
  cost_price        numeric(14,2) not null,
  amount            numeric(14,2) not null default 0
);

create unique index if not exists uq_purchase_returns_doc_no on purchase_returns (tenant_id, doc_no);
create index if not exists idx_purchase_returns_purchase on purchase_returns (tenant_id, purchase_order_id);
create index if not exists idx_purchase_return_items_return on purchase_return_items (purchase_return_id);

alter table purchase_returns      enable row level security;
alter table purchase_return_items enable row level security;

drop policy if exists purchase_returns_read on purchase_returns;
create policy purchase_returns_read on purchase_returns for select
  using (
    tenant_id = public.current_tenant_id()
    and public.has_role('inventory','accounts')
    and public.can_see_branch(branch_id)
  );
drop policy if exists purchase_return_items_read on purchase_return_items;
create policy purchase_return_items_read on purchase_return_items for select
  using (
    tenant_id = public.current_tenant_id()
    and public.has_role('inventory','accounts')
    and exists (select 1 from purchase_returns pr where pr.id = purchase_return_id and public.can_see_branch(pr.branch_id))
  );

drop trigger if exists trg_guard_write on purchase_returns;
create trigger trg_guard_write before insert on purchase_returns
  for each row execute function public.guard_money_write('admin,inventory,accounts', 'return goods to a supplier');

-- Draws only from what's still sitting in that exact batch — once any of it
-- has gone into production or been sent to another branch, it can't be
-- pulled back from the supplier through this batch anymore.
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
  -- Balance can go negative on purpose: once you've returned more than you
  -- still owed, the supplier owes YOU. Reports.tsx only lists positive
  -- balances as owing, so a credit like this simply drops off Creditors.
  update purchase_orders
     set returned_total = returned_total + v_total,
         balance        = balance - v_total,
         payment_status = case when balance - v_total <= 0 then 'full'::pay_status else payment_status end
   where id = p_purchase;

  perform public.log_audit('supplier_return', 'purchase_orders', p_purchase::text,
    jsonb_build_object('return_id', v_return_id, 'doc_no', v_doc_no, 'total', v_total));

  return v_return_id;
end $$;


-- ------------------------------------------------------------
-- 5. Product margins: net of returns
-- ------------------------------------------------------------
-- Revenue nets at the sale_item (qty_returned covers every condition);
-- cost nets at the sales_consumption row (qty_returned only moves for
-- resellable returns, since a damaged unit's cost stays a loss).
drop function if exists public.report_product_profitability(date, date, uuid);

create or replace function public.report_product_profitability(
  p_from   date default null,
  p_to     date default null,
  p_branch uuid default null
)
returns table (
  fg_id         uuid,
  product_name  text,
  qty_sold      numeric,
  total_revenue numeric,
  total_cogs    numeric,
  profit        numeric,
  margin_pct    numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('accounts') then
    raise exception 'Only admin and accounts can see product margins.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  with cost as (
    select si.finished_good_id as fg_id,
           sum(sc.qty - sc.qty_returned) as net_qty,
           sum((sc.qty - sc.qty_returned) * sc.unit_cost) as net_cogs
      from sales_consumption sc
      join sale_items   si on si.id = sc.sale_item_id
      join sales_orders so on so.id = si.sales_order_id
     where sc.tenant_id = public.current_tenant_id()
       and so.voided = false
       and (p_from   is null or so.transaction_date >= p_from)
       and (p_to     is null or so.transaction_date <= p_to)
       and (p_branch is null or so.branch_id = p_branch)
     group by si.finished_good_id
  ),
  rev as (
    select si.finished_good_id as fg_id,
           sum((si.quantity - si.qty_returned) * si.unit_price) as net_revenue
      from sale_items   si
      join sales_orders so on so.id = si.sales_order_id
     where si.tenant_id = public.current_tenant_id()
       and so.voided = false
       and (p_from   is null or so.transaction_date >= p_from)
       and (p_to     is null or so.transaction_date <= p_to)
       and (p_branch is null or so.branch_id = p_branch)
     group by si.finished_good_id
  )
  select
    fg.id, fg.name,
    coalesce(c.net_qty, 0),
    coalesce(r.net_revenue, 0),
    coalesce(c.net_cogs, 0),
    coalesce(r.net_revenue, 0) - coalesce(c.net_cogs, 0),
    case when coalesce(r.net_revenue, 0) > 0
         then round(100 * (coalesce(r.net_revenue, 0) - coalesce(c.net_cogs, 0)) / r.net_revenue, 2)
         else 0 end
  from finished_goods fg
  left join cost c on c.fg_id = fg.id
  left join rev  r on r.fg_id = fg.id
  where fg.tenant_id = public.current_tenant_id()
    and (coalesce(c.net_qty, 0) <> 0 or coalesce(r.net_revenue, 0) <> 0)
  order by (coalesce(r.net_revenue, 0) - coalesce(c.net_cogs, 0)) desc;
end $$;

-- By product, and split resellable vs. a loss — for the Reports "Returns" tab.
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
     and (p_from   is null or sr.return_date >= p_from)
     and (p_to     is null or sr.return_date <= p_to)
     and (p_branch is null or sr.branch_id = p_branch)
   group by sri.finished_good_id, fg.name
   order by sum(sri.amount) desc;
end $$;


-- ------------------------------------------------------------
-- 6. Dashboards: net of returns
-- ------------------------------------------------------------
-- total_amount/gross_profit on sales_orders stay as invoiced, so the
-- ALL-TIME owner figures can net straight off the running returned_total/
-- returned_profit columns. Anything scoped to a MONTH has to join
-- sale_returns and filter on the RETURN's own date instead — a return
-- recorded in October must reduce October's numbers even when the sale
-- itself was made in September.
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

  -- Staff are judged on their own branch's shelves; admin and accounts on
  -- every active branch.
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

  -- ============ CASHIER: this branch's till, today ============
  if v_role = 'sales' then
    select v_common || jsonb_build_object(
      'today_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today), 0)
        - coalesce((
        select sum(total) from sale_returns
         where tenant_id = v_tenant and branch_id = v_branch and return_date = v_today), 0),
      'today_count', (
        select count(*) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today),
      'my_today_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today and created_by = v_uid), 0)
        - coalesce((
        select sum(sr.total) from sale_returns sr join sales_orders so on so.id = sr.sales_order_id
         where sr.tenant_id = v_tenant and sr.return_date = v_today and so.created_by = v_uid), 0),
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
         where tenant_id = v_tenant and branch_id = v_branch and return_date = v_today - 1), 0),
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

  -- ============ STOREKEEPER: this branch's stock. No money. ============
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

  -- ============ OWNER / ACCOUNTS: every branch ============
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
                          - coalesce((select sum(sr.total) from sale_returns sr where sr.tenant_id = v_tenant
                                      and sr.return_date >= date_trunc('month', v_today)), 0),
      'month_sales_count', (select count(*) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today)),
      'month_profit',      coalesce((select sum(gross_profit) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.subtotal - sr.cogs_reversed) from sale_returns sr where sr.tenant_id = v_tenant
                                      and sr.return_date >= date_trunc('month', v_today)), 0),
      'month_expenses',    coalesce((select sum(amount) from expenses where tenant_id = v_tenant
                                      and expense_date >= date_trunc('month', v_today)), 0),
      'last_month_sales',  coalesce((select sum(total_amount) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today) - interval '1 month'
                                      and transaction_date <= (v_today - interval '1 month')::date), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr where sr.tenant_id = v_tenant
                                      and sr.return_date >= date_trunc('month', v_today) - interval '1 month'
                                      and sr.return_date <= (v_today - interval '1 month')::date), 0),
      'last_month_profit', coalesce((select sum(gross_profit) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today) - interval '1 month'
                                      and transaction_date <= (v_today - interval '1 month')::date), 0)
                          - coalesce((select sum(sr.subtotal - sr.cogs_reversed) from sale_returns sr where sr.tenant_id = v_tenant
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
      -- One row per active branch, so the owner can compare stores at a glance.
      'by_branch', (
        select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', b.id,
                   'name', b.name,
                   'today', coalesce((select sum(so.total_amount) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date = v_today), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr
                                       where sr.tenant_id = v_tenant and sr.branch_id = b.id
                                         and sr.return_date = v_today), 0),
                   'month', coalesce((select sum(so.total_amount) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr
                                       where sr.tenant_id = v_tenant and sr.branch_id = b.id
                                         and sr.return_date >= date_trunc('month', v_today)), 0),
                   'month_profit', coalesce((select sum(so.gross_profit) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.subtotal - sr.cogs_reversed) from sale_returns sr
                                       where sr.tenant_id = v_tenant and sr.branch_id = b.id
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
-- 7. Store credit: spend it toward a later sale's balance
-- ------------------------------------------------------------
-- Doesn't touch create_sale — this runs right after, like a second
-- payment. Guarded the same way record_sale_payment is: can't overpay,
-- can't touch a voided sale, can't spend more credit than the customer has.
create or replace function public.spend_store_credit(p_sale uuid, p_amount numeric)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_so     record;
  v_credit numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('sales','accounts') then
    raise exception 'Your role is not allowed to record a payment.' using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero.'; end if;

  select * into v_so from sales_orders where id = p_sale and tenant_id = v_tenant for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_so.voided then raise exception 'This sale has been voided.'; end if;
  if v_so.customer_id is null then raise exception 'This sale has no customer — store credit needs one.'; end if;
  if p_amount > v_so.balance then
    raise exception 'That is more than the %s still owed on this sale.', to_char(v_so.balance, 'FM999,999,999.00');
  end if;

  select credit_balance into v_credit from customers where id = v_so.customer_id and tenant_id = v_tenant for update;
  if coalesce(v_credit, 0) < p_amount then
    raise exception 'This customer only has %s in store credit.', to_char(coalesce(v_credit, 0), 'FM999,999,999.00');
  end if;

  update customers set credit_balance = credit_balance - p_amount where id = v_so.customer_id and tenant_id = v_tenant;
  insert into customer_credit_ledger(tenant_id, customer_id, amount, source_type, source_id)
  values (v_tenant, v_so.customer_id, -p_amount, 'sale', p_sale);

  insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id, reference, notes)
  values (v_tenant, p_sale, p_amount, null, 'STORE_CREDIT', 'Paid from store credit');

  update sales_orders
     set balance = balance - p_amount,
         payment_status = case when balance - p_amount <= 0 then 'full'::pay_status else 'part'::pay_status end
   where id = p_sale;
end $$;


-- ------------------------------------------------------------
-- 8. Grants
-- ------------------------------------------------------------
grant execute on function public.create_sale_return(uuid, jsonb, text, text, uuid, date) to authenticated;
grant execute on function public.create_purchase_return(uuid, jsonb, text)                to authenticated;
grant execute on function public.spend_store_credit(uuid, numeric)                        to authenticated;
grant execute on function public.report_returns(date, date, uuid)                         to authenticated;
grant execute on function public.report_product_profitability(date, date, uuid)           to authenticated;
grant execute on function public.void_sale(uuid)                                          to authenticated;
grant execute on function public.dashboard_summary()                                      to authenticated;
