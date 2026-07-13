-- ============================================================
-- StockFlow — Business Logic Engine (THE BACKEND)
-- Server-side functions implementing the 7 Access calculations.
-- Each runs in a single transaction → stock never drifts.
-- Called from React via supabase.rpc('<name>', {...}).
-- Run this AFTER 0001_init.sql.
-- ============================================================

-- ------------------------------------------------------------
-- 1) CREATE PURCHASE
--    Inserts PO + material batches, raises material stock,
--    logs PURCHASE movements, records initial payment.
--    p_items: [{ "material_id": uuid, "qty": num, "cost_price": num }]
-- ------------------------------------------------------------
create or replace function public.create_purchase(
  p_supplier      uuid,
  p_date          date,
  p_payment_type  uuid,
  p_amount_paid   numeric,
  p_items         jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid := public.current_branch_id();
  v_po     uuid;
  v_item   jsonb;
  v_total  numeric := 0;
  v_amount numeric;
  v_paid   numeric;
  v_status pay_status;
  v_qty    numeric;
  v_cost   numeric;
  v_mat    uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  insert into purchase_orders(tenant_id, branch_id, supplier_id, purchase_date, payment_type_id, created_by)
  values (v_tenant, v_branch, p_supplier, coalesce(p_date, current_date), p_payment_type, auth.uid())
  returning id into v_po;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_mat  := (v_item->>'material_id')::uuid;
    v_qty  := (v_item->>'qty')::numeric;
    v_cost := (v_item->>'cost_price')::numeric;
    v_amount := v_qty * v_cost;
    v_total  := v_total + v_amount;

    -- new purchase batch (qty_remaining drives FIFO later)
    insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining, cost_price, amount)
    values (v_tenant, v_po, v_mat, v_qty, v_qty, v_cost, v_amount);

    update materials set qty_balance = qty_balance + v_qty
      where id = v_mat and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_branch, 'material', v_mat, 'PURCHASE', v_qty, v_po, auth.uid());
  end loop;

  v_paid   := least(coalesce(p_amount_paid, 0), v_total);
  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid >= v_total then 'full'
                   else 'part' end;

  update purchase_orders
     set total_amount = v_total, total_paid = v_paid, balance = v_total - v_paid,
         payment_status = v_status, processed = true
   where id = v_po;

  if v_paid > 0 then
    insert into purchase_payments(tenant_id, purchase_order_id, amount_paid, payment_type_id)
    values (v_tenant, v_po, v_paid, p_payment_type);
  end if;

  return v_po;
end $$;

-- ------------------------------------------------------------
-- 2) RECORD PRODUCTION  (FIFO material costing — calcs #1,2,3,4)
--    Draws each material from the OLDEST purchase batch first,
--    computes true unit cost, auto-prices, creates an fg_batch.
--    p_materials: [{ "material_id": uuid, "qty": num }]
-- ------------------------------------------------------------
create or replace function public.record_production(
  p_finished_good uuid,
  p_date          date,
  p_expenses      numeric,
  p_qty           numeric,
  p_materials     jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid := public.current_branch_id();
  v_run    uuid;
  v_mat    jsonb;
  v_material uuid;
  v_need   numeric;
  v_take   numeric;
  v_batch  record;
  v_material_cost numeric := 0;
  v_unit_cost numeric;
  v_markup numeric;
  v_selling numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity produced must be > 0'; end if;

  insert into production_runs(tenant_id, branch_id, finished_good_id, production_date, expenses, qty_produced, created_by)
  values (v_tenant, v_branch, p_finished_good, coalesce(p_date, current_date), coalesce(p_expenses,0), p_qty, auth.uid())
  returning id into v_run;

  for v_mat in select * from jsonb_array_elements(p_materials)
  loop
    v_material := (v_mat->>'material_id')::uuid;
    v_need     := (v_mat->>'qty')::numeric;

    -- FIFO: consume oldest purchase batches first
    for v_batch in
      select id, qty_remaining, cost_price
        from purchase_items
       where tenant_id = v_tenant and material_id = v_material and qty_remaining > 0
       order by created_at asc
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_batch.qty_remaining);

      update purchase_items set qty_remaining = qty_remaining - v_take where id = v_batch.id;

      insert into production_consumption(tenant_id, production_run_id, material_id, purchase_item_id, qty, cost_price)
      values (v_tenant, v_run, v_material, v_batch.id, v_take, v_batch.cost_price);

      v_material_cost := v_material_cost + (v_take * v_batch.cost_price);
      v_need := v_need - v_take;
    end loop;

    if v_need > 0 then
      raise exception 'Insufficient stock for material % (short by %)', v_material, v_need;
    end if;

    update materials set qty_balance = qty_balance - (v_mat->>'qty')::numeric
      where id = v_material and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_branch, 'material', v_material, 'PRODUCTION', -(v_mat->>'qty')::numeric, v_run, auth.uid());
  end loop;

  -- calc #3: unit cost = (materials + expenses) / qty
  v_unit_cost := (v_material_cost + coalesce(p_expenses,0)) / p_qty;

  -- calc #4: auto selling price = unit_cost * markup (default 1.5)
  select coalesce(default_markup, 1.5) into v_markup
    from finished_goods where id = p_finished_good and tenant_id = v_tenant;
  v_selling := round(v_unit_cost * coalesce(v_markup, 1.5), 2);

  update production_runs
     set material_cost = v_material_cost,
         total_cost    = v_material_cost + coalesce(p_expenses,0),
         unit_cost     = v_unit_cost
   where id = v_run;

  -- new finished-goods batch (qty_remaining drives FIFO on sale)
  insert into fg_batches(tenant_id, production_run_id, finished_good_id, qty, qty_remaining, unit_cost, selling_price)
  values (v_tenant, v_run, p_finished_good, p_qty, p_qty, v_unit_cost, v_selling);

  update finished_goods
     set qty_balance = qty_balance + p_qty, selling_price = v_selling
   where id = p_finished_good and tenant_id = v_tenant;

  insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
  values (v_tenant, v_branch, 'finished_good', p_finished_good, 'PRODUCTION', p_qty, v_run, auth.uid());

  return v_run;
end $$;

-- ------------------------------------------------------------
-- 3) CREATE SALE  (FIFO COGS — calcs #5,6,7)
--    Draws each product from the OLDEST fg_batch first → exact
--    COGS + gross profit per sale. Blocks oversell. Records payment.
--    p_items: [{ "finished_good_id": uuid, "quantity": num, "unit_price": num }]
-- ------------------------------------------------------------
create or replace function public.create_sale(
  p_customer     uuid,
  p_date         date,
  p_payment_type uuid,
  p_amount_paid  numeric,
  p_items        jsonb
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid := public.current_branch_id();
  v_sale   uuid;
  v_item   jsonb;
  v_fg     uuid;
  v_qty    numeric;
  v_price  numeric;
  v_line   numeric;
  v_total  numeric := 0;
  v_cogs   numeric := 0;
  v_sale_item uuid;
  v_need   numeric;
  v_take   numeric;
  v_batch  record;
  v_avail  numeric;
  v_paid   numeric;
  v_status pay_status;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  insert into sales_orders(tenant_id, branch_id, customer_id, transaction_date, payment_type_id, created_by)
  values (v_tenant, v_branch, p_customer, coalesce(p_date, current_date), p_payment_type, auth.uid())
  returning id into v_sale;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_fg    := (v_item->>'finished_good_id')::uuid;
    v_qty   := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    v_line  := v_qty * v_price;
    v_total := v_total + v_line;

    select qty_balance into v_avail from finished_goods where id = v_fg and tenant_id = v_tenant;
    if coalesce(v_avail,0) < v_qty then
      raise exception 'Insufficient stock for product % (have %, need %)', v_fg, coalesce(v_avail,0), v_qty;
    end if;

    insert into sale_items(tenant_id, sales_order_id, finished_good_id, quantity, unit_price, amount)
    values (v_tenant, v_sale, v_fg, v_qty, v_price, v_line)
    returning id into v_sale_item;

    -- FIFO: draw oldest finished-goods batches first → real COGS
    v_need := v_qty;
    for v_batch in
      select id, qty_remaining, unit_cost
        from fg_batches
       where tenant_id = v_tenant and finished_good_id = v_fg and qty_remaining > 0
       order by produced_at asc
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_batch.qty_remaining);

      update fg_batches set qty_remaining = qty_remaining - v_take where id = v_batch.id;

      insert into sales_consumption(tenant_id, sale_item_id, fg_batch_id, finished_good_id, qty, unit_cost, selling_price)
      values (v_tenant, v_sale_item, v_batch.id, v_fg, v_take, v_batch.unit_cost, v_price);

      v_cogs := v_cogs + (v_take * v_batch.unit_cost);
      v_need := v_need - v_take;
    end loop;

    if v_need > 0 then
      raise exception 'Stock/batch mismatch for product %', v_fg;
    end if;

    update finished_goods set qty_balance = qty_balance - v_qty
      where id = v_fg and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_branch, 'finished_good', v_fg, 'SALE', -v_qty, v_sale, auth.uid());
  end loop;

  v_paid   := least(coalesce(p_amount_paid, 0), v_total);
  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid >= v_total then 'full'
                   else 'part' end;

  update sales_orders
     set total_amount = v_total, amount_paid = v_paid, balance = v_total - v_paid,
         cogs = v_cogs, gross_profit = v_total - v_cogs,
         payment_status = v_status, processed = true
   where id = v_sale;

  if v_paid > 0 then
    insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id)
    values (v_tenant, v_sale, v_paid, p_payment_type);
  end if;

  return v_sale;
end $$;

-- ------------------------------------------------------------
-- 4) RECORD SALE PAYMENT  (calc #6 — running balance)
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
  v_tenant uuid := public.current_tenant_id();
  v_total  numeric;
  v_paid   numeric;
  v_status pay_status;
begin
  insert into sale_payments(tenant_id, sales_order_id, payment_date, amount_paid, payment_type_id, reference, notes)
  values (v_tenant, p_sale, current_date, p_amount, p_payment_type, p_reference, p_notes);

  select total_amount into v_total from sales_orders where id = p_sale and tenant_id = v_tenant;
  select coalesce(sum(amount_paid),0) into v_paid from sale_payments where sales_order_id = p_sale and tenant_id = v_tenant;

  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid >= v_total then 'full'
                   else 'part' end;

  update sales_orders set amount_paid = v_paid, balance = v_total - v_paid, payment_status = v_status
   where id = p_sale and tenant_id = v_tenant;
end $$;

-- ------------------------------------------------------------
-- 5) RECORD PURCHASE PAYMENT  (calc #6 — running balance)
-- ------------------------------------------------------------
create or replace function public.record_purchase_payment(
  p_purchase     uuid,
  p_amount       numeric,
  p_payment_type uuid,
  p_reference    text default null,
  p_notes        text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_total  numeric;
  v_paid   numeric;
  v_status pay_status;
begin
  insert into purchase_payments(tenant_id, purchase_order_id, payment_date, amount_paid, payment_type_id, reference, notes)
  values (v_tenant, p_purchase, current_date, p_amount, p_payment_type, p_reference, p_notes);

  select total_amount into v_total from purchase_orders where id = p_purchase and tenant_id = v_tenant;
  select coalesce(sum(amount_paid),0) into v_paid from purchase_payments where purchase_order_id = p_purchase and tenant_id = v_tenant;

  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid >= v_total then 'full'
                   else 'part' end;

  update purchase_orders set total_paid = v_paid, balance = v_total - v_paid, payment_status = v_status
   where id = p_purchase and tenant_id = v_tenant;
end $$;

-- ------------------------------------------------------------
-- Allow logged-in users to call these (RLS + tenant checks inside
-- still enforce isolation; SECURITY DEFINER runs them as owner).
-- ------------------------------------------------------------
grant execute on function public.create_purchase(uuid,date,uuid,numeric,jsonb) to authenticated;
grant execute on function public.record_production(uuid,date,numeric,numeric,jsonb) to authenticated;
grant execute on function public.create_sale(uuid,date,uuid,numeric,jsonb) to authenticated;
grant execute on function public.record_sale_payment(uuid,numeric,uuid,text,text) to authenticated;
grant execute on function public.record_purchase_payment(uuid,numeric,uuid,text,text) to authenticated;

-- ============================================================
-- This file IS the backend business logic. The 7 calculations
-- from the Access app now run server-side, transactionally.
-- ============================================================
