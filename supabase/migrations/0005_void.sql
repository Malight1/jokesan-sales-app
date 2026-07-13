-- ============================================================
-- StockFlow — Void (reverse) engine for transactions
-- Transactions must never be hard-deleted: they moved stock and
-- FIFO batches. Voiding reverses those effects and keeps the
-- record (voided=true) for the audit trail.
-- Run AFTER 0001–0004.
-- ============================================================

-- ---------- voided flags ----------
alter table sales_orders     add column if not exists voided boolean not null default false;
alter table sales_orders     add column if not exists voided_at timestamptz;
alter table purchase_orders  add column if not exists voided boolean not null default false;
alter table purchase_orders  add column if not exists voided_at timestamptz;
alter table production_runs  add column if not exists voided boolean not null default false;
alter table production_runs  add column if not exists voided_at timestamptz;

-- ------------------------------------------------------------
-- VOID SALE — restore fg_batches + finished goods stock.
-- Always possible (goods come back into stock).
-- ------------------------------------------------------------
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

  -- restore each FIFO draw back to its batch
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
-- VOID PURCHASE — only if none of its batches were consumed.
-- ------------------------------------------------------------
create or replace function public.void_purchase(p_purchase uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row record;
  v_item record;
begin
  select * into v_row from purchase_orders where id = p_purchase and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase not found'; end if;
  if v_row.voided then raise exception 'Purchase is already voided'; end if;

  if exists (
    select 1 from purchase_items
     where purchase_order_id = p_purchase and tenant_id = v_tenant
       and qty_remaining < qty
  ) then
    raise exception 'Cannot void: materials from this purchase were already used in production';
  end if;

  for v_item in
    select material_id, qty from purchase_items
     where purchase_order_id = p_purchase and tenant_id = v_tenant
  loop
    update materials set qty_balance = qty_balance - v_item.qty
     where id = v_item.material_id and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_row.branch_id, 'material', v_item.material_id, 'ADJUSTMENT', -v_item.qty, p_purchase, auth.uid());
  end loop;

  -- retire the batches so FIFO can never draw from them
  update purchase_items set qty_remaining = 0
   where purchase_order_id = p_purchase and tenant_id = v_tenant;

  update purchase_orders set voided = true, voided_at = now() where id = p_purchase;
end $$;

-- ------------------------------------------------------------
-- VOID PRODUCTION — only if nothing was sold from its batch.
-- Restores consumed materials to their original purchase batches.
-- ------------------------------------------------------------
create or replace function public.void_production(p_run uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row record;
  v_batch record;
  v_cons record;
begin
  select * into v_row from production_runs where id = p_run and tenant_id = v_tenant for update;
  if not found then raise exception 'Production run not found'; end if;
  if v_row.voided then raise exception 'Production run is already voided'; end if;

  select * into v_batch from fg_batches
   where production_run_id = p_run and tenant_id = v_tenant
   limit 1 for update;

  if found and v_batch.qty_remaining < v_batch.qty then
    raise exception 'Cannot void: some of this batch has already been sold';
  end if;

  -- give consumed materials back to their purchase batches
  for v_cons in
    select material_id, purchase_item_id, qty from production_consumption
     where production_run_id = p_run and tenant_id = v_tenant
  loop
    if v_cons.purchase_item_id is not null then
      update purchase_items set qty_remaining = qty_remaining + v_cons.qty
       where id = v_cons.purchase_item_id and tenant_id = v_tenant;
    end if;

    update materials set qty_balance = qty_balance + v_cons.qty
     where id = v_cons.material_id and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_row.branch_id, 'material', v_cons.material_id, 'ADJUSTMENT', v_cons.qty, p_run, auth.uid());
  end loop;

  -- remove the finished goods this run created
  if v_batch.id is not null then
    update finished_goods set qty_balance = qty_balance - v_batch.qty
     where id = v_batch.finished_good_id and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_row.branch_id, 'finished_good', v_batch.finished_good_id, 'ADJUSTMENT', -v_batch.qty, p_run, auth.uid());

    delete from fg_batches where id = v_batch.id and tenant_id = v_tenant;
  end if;

  update production_runs set voided = true, voided_at = now() where id = p_run;
end $$;

grant execute on function public.void_sale(uuid) to authenticated;
grant execute on function public.void_purchase(uuid) to authenticated;
grant execute on function public.void_production(uuid) to authenticated;
