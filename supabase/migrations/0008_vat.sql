-- ============================================================
-- StockFlow — VAT / FIRS support
--  • tenant-level VAT settings (rate, TIN, on/off)
--  • sale stores subtotal + vat separately; profit = subtotal − COGS
--    (VAT is collected for govt, never counted as profit)
-- Run AFTER 0001–0007.
-- ============================================================

alter table tenants add column if not exists vat_enabled boolean not null default false;
alter table tenants add column if not exists vat_rate numeric(5,2) not null default 7.5;
alter table tenants add column if not exists tin text;

alter table sales_orders add column if not exists subtotal   numeric(14,2) not null default 0;
alter table sales_orders add column if not exists vat_amount numeric(14,2) not null default 0;
alter table sales_orders add column if not exists vat_rate   numeric(5,2)  not null default 0;

-- Recreate create_sale with an optional VAT rate.
drop function if exists public.create_sale(uuid, date, uuid, numeric, jsonb);

create or replace function public.create_sale(
  p_customer     uuid,
  p_date         date,
  p_payment_type uuid,
  p_amount_paid  numeric,
  p_items        jsonb,
  p_vat_rate     numeric default 0
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
  v_subtotal numeric := 0;
  v_vat    numeric := 0;
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
    v_subtotal := v_subtotal + v_line;

    select qty_balance into v_avail from finished_goods where id = v_fg and tenant_id = v_tenant;
    if coalesce(v_avail,0) < v_qty then
      raise exception 'Insufficient stock for product % (have %, need %)', v_fg, coalesce(v_avail,0), v_qty;
    end if;

    insert into sale_items(tenant_id, sales_order_id, finished_good_id, quantity, unit_price, amount)
    values (v_tenant, v_sale, v_fg, v_qty, v_price, v_line)
    returning id into v_sale_item;

    v_need := v_qty;
    for v_batch in
      select id, qty_remaining, unit_cost from fg_batches
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
    if v_need > 0 then raise exception 'Stock/batch mismatch for product %', v_fg; end if;

    update finished_goods set qty_balance = qty_balance - v_qty where id = v_fg and tenant_id = v_tenant;
    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_branch, 'finished_good', v_fg, 'SALE', -v_qty, v_sale, auth.uid());
  end loop;

  v_vat   := round(v_subtotal * coalesce(p_vat_rate,0) / 100, 2);
  v_total := v_subtotal + v_vat;

  v_paid   := least(coalesce(p_amount_paid, 0), v_total);
  v_status := case when v_paid <= 0 then 'unpaid' when v_paid >= v_total then 'full' else 'part' end;

  update sales_orders
     set subtotal = v_subtotal, vat_amount = v_vat, vat_rate = coalesce(p_vat_rate,0),
         total_amount = v_total, amount_paid = v_paid, balance = v_total - v_paid,
         cogs = v_cogs, gross_profit = v_subtotal - v_cogs,   -- VAT excluded from profit
         payment_status = v_status, processed = true
   where id = v_sale;

  if v_paid > 0 then
    insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id)
    values (v_tenant, v_sale, v_paid, p_payment_type);
  end if;

  return v_sale;
end $$;

grant execute on function public.create_sale(uuid,date,uuid,numeric,jsonb,numeric) to authenticated;
