-- ============================================================
-- StockFlow — Retail mode.
--
-- A plain shop that buys sellable stock and resells it (no production
-- step) could not use this app: purchase_items.material_id was not
-- null, so a purchase could only ever land in raw materials. This
-- migration adds:
--   1. tenants.business_type ('retail' | 'manufacturing'), read at
--      signup, changeable only by the platform admin afterwards.
--   2. A finished-goods branch through the purchase path
--      (create_purchase / create_purchase_return / void_purchase), so a
--      shop can buy directly into sellable stock with a real supplier
--      payable — no fake raw material, no fake production run.
--
-- Everything here is additive to the existing materials path, which is
-- completely unchanged for every manufacturing tenant.
--
-- IMPORTANT: handle_new_user() has been redefined five times (0001,
-- 0007, 0020, 0026, 0043). This migration is based on 0043's body — the
-- actual current definition — with only the business_type read added.
-- If it is ever touched again, rebase on the CURRENT function body
-- (pg_get_functiondef('public.handle_new_user'::regproc)), never on any
-- one migration file. A stale rebase already broke staff invites once
-- (see 0043's own header for that story).
-- Run AFTER 0001–0044.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The flag
-- ------------------------------------------------------------
alter table tenants add column if not exists business_type text not null default 'manufacturing'
  check (business_type in ('retail', 'manufacturing'));

-- ------------------------------------------------------------
-- 2. Signup carries it (based on 0043's current body — see warning above)
-- ------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_tenant_id uuid;
  new_branch_id uuid;
  company text;
  ttype tenant_type;
  btype text;
  base_slug text;
  v_invite record;
begin
  if coalesce((new.raw_user_meta_data ->> 'platform_admin')::boolean, false) then
    insert into platform_admins (user_id) values (new.id) on conflict do nothing;
    return new;
  end if;

  select * into v_invite
    from staff_invites
   where lower(email) = lower(new.email) and status = 'pending'
   order by created_at desc limit 1;

  if found then
    insert into profiles (id, tenant_id, branch_id, role, full_name, email)
    values (new.id, v_invite.tenant_id,
            coalesce(v_invite.branch_id, public.default_branch_id(v_invite.tenant_id)),
            v_invite.role, new.raw_user_meta_data ->> 'full_name', new.email);
    update staff_invites set status = 'accepted' where id = v_invite.id;
    return new;
  end if;

  company := coalesce(new.raw_user_meta_data ->> 'company_name', 'My Company');
  ttype   := coalesce((new.raw_user_meta_data ->> 'tenant_type')::tenant_type, 'single');
  btype   := coalesce(nullif(new.raw_user_meta_data ->> 'business_type', ''), 'manufacturing');
  base_slug := lower(regexp_replace(company, '[^a-zA-Z0-9]+', '-', 'g'))
               || '-' || substr(new.id::text, 1, 6);

  insert into tenants (name, slug, type, business_type)
    values (company, base_slug, ttype, btype)
    returning id into new_tenant_id;

  insert into branches (tenant_id, name)
    values (new_tenant_id, 'Main')
    returning id into new_branch_id;

  insert into profiles (id, tenant_id, branch_id, role, full_name, email)
    values (new.id, new_tenant_id, new_branch_id, 'admin',
            new.raw_user_meta_data ->> 'full_name', new.email);

  insert into payment_types (tenant_id, name, method_group) values
    (new_tenant_id, 'Cash', 'cash'), (new_tenant_id, 'Bank Transfer', 'transfer'), (new_tenant_id, 'Credit', 'other');
  insert into customer_types (tenant_id, name) values
    (new_tenant_id, 'Corporate'), (new_tenant_id, 'Private');
  insert into expense_types (tenant_id, name) values
    (new_tenant_id, 'Transport'), (new_tenant_id, 'Salary'), (new_tenant_id, 'Rent');

  return new;
end $$;

-- ------------------------------------------------------------
-- 3. Only the platform admin can change it afterwards
-- ------------------------------------------------------------
create or replace function public.platform_set_business_type(p_tenant_id uuid, p_business_type text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  if p_business_type not in ('retail', 'manufacturing') then
    raise exception 'business_type must be retail or manufacturing';
  end if;
  update tenants set business_type = p_business_type where id = p_tenant_id;
  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
    values (p_tenant_id, auth.uid(), 'platform.change_business_type', 'tenants', p_tenant_id::text,
            jsonb_build_object('business_type', p_business_type));
end $$;
grant execute on function public.platform_set_business_type(uuid, text) to authenticated;

-- ------------------------------------------------------------
-- 4. Buying into sellable stock — schema
--
-- fg_batch_id links a finished-goods purchase_items row to the specific
-- fg_batches layer it created, the same way material_id already implies
-- the FIFO layer for a materials line (there, the purchase_items row IS
-- the layer). A finished-goods line needs an explicit pointer because
-- its layer lives in a different table (fg_batches, so the same origin
-- can outlive selling engine changes without a schema change — see
-- create_sale, which never inspects fg_batches.origin).
-- ------------------------------------------------------------
alter table purchase_items alter column material_id drop not null;
alter table purchase_items add column if not exists finished_good_id uuid references finished_goods(id) on delete restrict;
alter table purchase_items add column if not exists fg_batch_id uuid references fg_batches(id) on delete restrict;
alter table purchase_items add constraint purchase_items_one_product
  check (num_nonnulls(material_id, finished_good_id) = 1);

alter table purchase_return_items alter column material_id drop not null;
alter table purchase_return_items add column if not exists finished_good_id uuid references finished_goods(id) on delete restrict;
alter table purchase_return_items add constraint purchase_return_items_one_product
  check (num_nonnulls(material_id, finished_good_id) = 1);

-- ------------------------------------------------------------
-- 5. create_purchase() — finished-goods branch (based on 0030's body)
--
-- A finished-goods line's purchase_items row is inserted with
-- qty_remaining = 0: it is the document and cost trace, not the FIFO
-- layer (that lives in fg_batches, inserted first so fg_batch_id can
-- reference it). Leaving qty_remaining at the real quantity would
-- double-count into stock_levels' and reorder_suggestions' material
-- aggregates — both already group/sum by material_id, so a NULL
-- material_id row naturally contributes nothing as long as its
-- qty_remaining is 0; that's the actual guard, not an extra WHERE
-- clause. UOM conversion (Phase 6c) stays materials-only for this pass.
-- ------------------------------------------------------------
create or replace function public.create_purchase(
  p_supplier      uuid,
  p_date          date,
  p_payment_type  uuid,
  p_amount_paid   numeric,
  p_items         jsonb,
  p_branch        uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid;
  v_po     uuid;
  v_item   jsonb;
  v_total  numeric := 0;
  v_amount numeric;
  v_paid   numeric;
  v_status pay_status;
  v_qty    numeric;
  v_cost   numeric;
  v_mat    uuid;
  v_fg     uuid;
  v_fg_price   numeric;
  v_fg_batch   uuid;
  v_uom_id     uuid;   -- Phase 6c
  v_uom_qty    numeric;
  v_uom_factor numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.resolve_branch(p_branch);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A purchase needs at least one item.';
  end if;
  perform public.assert_same_tenant('suppliers', p_supplier);
  perform public.assert_same_tenant('payment_types', p_payment_type);

  insert into purchase_orders(tenant_id, branch_id, supplier_id, purchase_date, payment_type_id, created_by, doc_no, status)
  values (v_tenant, v_branch, p_supplier, coalesce(p_date, current_date), p_payment_type, auth.uid(),
          public.next_doc_no(v_tenant, 'PO'), 'received')
  returning id into v_po;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_mat := nullif(v_item->>'material_id', '')::uuid;
    v_fg  := nullif(v_item->>'finished_good_id', '')::uuid;
    if (v_mat is null) = (v_fg is null) then
      raise exception 'Every purchase line needs exactly one of material_id or finished_good_id.';
    end if;

    v_qty  := (v_item->>'qty')::numeric;
    v_cost := (v_item->>'cost_price')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every purchase line needs a quantity above zero.';
    end if;
    if v_cost is null or v_cost < 0 then
      raise exception 'Cost price can''t be negative.';
    end if;

    if v_mat is not null then
      perform public.assert_same_tenant('materials', v_mat);

      -- Phase 6c: a line bought by the bag/carton/etc. converts to base
      -- units here, once — the FIFO layer below is always in base units.
      v_uom_id := nullif(v_item->>'uom_id', '')::uuid;
      if v_uom_id is not null then
        v_uom_qty := (v_item->>'uom_qty')::numeric;
        if v_uom_qty is null or v_uom_qty <= 0 then
          raise exception 'The unit quantity has to be more than zero.';
        end if;
        v_uom_factor := public.resolve_uom_factor('material', v_mat, v_uom_id);
        if v_uom_factor is null then
          raise exception 'That unit doesn''t belong to this material.';
        end if;
        v_qty := v_uom_qty * v_uom_factor;
      else
        v_uom_qty := null;
        v_uom_factor := null;
      end if;

      v_amount := v_qty * v_cost;
      v_total  := v_total + v_amount;

      insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining,
                                 cost_price, amount, branch_id, origin, supplier_batch_no, expiry_date,
                                 uom_id, uom_qty, uom_factor)
      values (v_tenant, v_po, v_mat, v_qty, v_qty, v_cost, v_amount, v_branch, 'purchase',
              nullif(trim(v_item->>'supplier_batch_no'), ''),
              nullif(v_item->>'expiry_date', '')::date,
              v_uom_id, v_uom_qty, v_uom_factor);

      update materials set qty_balance = qty_balance + v_qty
       where id = v_mat and tenant_id = v_tenant;

      insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
      values (v_tenant, v_branch, 'material', v_mat, 'PURCHASE', v_qty, v_po, auth.uid());
    else
      perform public.assert_same_tenant('finished_goods', v_fg);
      select selling_price into v_fg_price from finished_goods where id = v_fg and tenant_id = v_tenant;

      v_amount := v_qty * v_cost;
      v_total  := v_total + v_amount;

      insert into fg_batches(tenant_id, finished_good_id, qty, qty_remaining, unit_cost, selling_price,
                             branch_id, origin, batch_no, expiry_date)
      values (v_tenant, v_fg, v_qty, v_qty, v_cost, coalesce(v_fg_price, 0),
              v_branch, 'purchase',
              nullif(trim(v_item->>'supplier_batch_no'), ''),
              nullif(v_item->>'expiry_date', '')::date)
      returning id into v_fg_batch;

      insert into purchase_items(tenant_id, purchase_order_id, finished_good_id, fg_batch_id, qty, qty_remaining,
                                 cost_price, amount, branch_id, origin, supplier_batch_no, expiry_date)
      values (v_tenant, v_po, v_fg, v_fg_batch, v_qty, 0, v_cost, v_amount, v_branch, 'purchase',
              nullif(trim(v_item->>'supplier_batch_no'), ''),
              nullif(v_item->>'expiry_date', '')::date);

      update finished_goods set qty_balance = qty_balance + v_qty
       where id = v_fg and tenant_id = v_tenant;

      insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
      values (v_tenant, v_branch, 'finished_good', v_fg, 'PURCHASE', v_qty, v_po, auth.uid());
    end if;
  end loop;

  v_paid   := greatest(0, least(coalesce(p_amount_paid, 0), v_total));
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
-- 6. create_purchase_return() — finished-goods branch (based on 0024's body)
--
-- A finished-goods purchase line always has qty_remaining = 0 on its
-- purchase_items row (§5) — "still unused" lives on the linked
-- fg_batches row instead (fg_batch_id), so the remaining-quantity check
-- and the decrement both target that batch, not purchase_items.
-- ------------------------------------------------------------
create or replace function public.create_purchase_return(p_purchase uuid, p_items jsonb, p_reason text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_po     record;
  v_item   jsonb;
  v_line   record;
  v_batch  record;
  v_qty    numeric;
  v_total  numeric := 0;
  v_return_id uuid;
  v_doc_no text;
  v_any    boolean := false;
  v_new_balance numeric;
begin
  if not public.has_role('admin', 'inventory') then
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

    v_any := true;

    if v_line.material_id is not null then
      if v_qty > v_line.qty_remaining then
        raise exception 'Only % of this batch is still unused — % has already gone into production or another branch.',
          v_line.qty_remaining, v_line.qty - v_line.qty_remaining;
      end if;

      update purchase_items set qty_remaining = qty_remaining - v_qty where id = v_line.id;
      update materials set qty_balance = qty_balance - v_qty where id = v_line.material_id and tenant_id = v_tenant;
      insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
      values (v_tenant, v_po.branch_id, 'material', v_line.material_id, 'SUPPLIER_RETURN', -v_qty, v_return_id, auth.uid());

      insert into purchase_return_items(tenant_id, purchase_return_id, purchase_item_id, material_id, qty, cost_price, amount)
      values (v_tenant, v_return_id, v_line.id, v_line.material_id, v_qty, v_line.cost_price, v_qty * v_line.cost_price);
    else
      select * into v_batch from fg_batches where id = v_line.fg_batch_id for update;
      if v_qty > v_batch.qty_remaining then
        raise exception 'Only % of this batch is still unused — % has already been sold or sent to another branch.',
          v_batch.qty_remaining, v_batch.qty - v_batch.qty_remaining;
      end if;

      update fg_batches set qty_remaining = qty_remaining - v_qty where id = v_batch.id;
      update finished_goods set qty_balance = qty_balance - v_qty where id = v_line.finished_good_id and tenant_id = v_tenant;
      insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
      values (v_tenant, v_po.branch_id, 'finished_good', v_line.finished_good_id, 'SUPPLIER_RETURN', -v_qty, v_return_id, auth.uid());

      insert into purchase_return_items(tenant_id, purchase_return_id, purchase_item_id, finished_good_id, qty, cost_price, amount)
      values (v_tenant, v_return_id, v_line.id, v_line.finished_good_id, v_qty, v_line.cost_price, v_qty * v_line.cost_price);
    end if;

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
    jsonb_build_object('return_id', v_return_id, 'total', v_total));

  return v_return_id;
end $$;

-- ------------------------------------------------------------
-- 7. void_purchase() — finished-goods branch (based on 0020's body)
-- ------------------------------------------------------------
create or replace function public.void_purchase(p_purchase uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row  record;
  v_item record;
begin
  select * into v_row from purchase_orders where id = p_purchase and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase not found'; end if;
  if v_row.voided then raise exception 'Purchase is already voided'; end if;

  if exists (
    select 1 from purchase_items pi
    left join fg_batches fb on fb.id = pi.fg_batch_id
     where pi.purchase_order_id = p_purchase and pi.tenant_id = v_tenant
       and (
         (pi.material_id is not null and pi.qty_remaining < pi.qty)
         or (pi.finished_good_id is not null and fb.qty_remaining < pi.qty)
       )
  ) then
    raise exception 'Can''t void: some of this stock has already been used, sold, or sent to another branch.';
  end if;

  for v_item in
    select material_id, finished_good_id, fg_batch_id, qty, branch_id from purchase_items
     where purchase_order_id = p_purchase and tenant_id = v_tenant
  loop
    if v_item.material_id is not null then
      update materials set qty_balance = qty_balance - v_item.qty
       where id = v_item.material_id and tenant_id = v_tenant;

      insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
      values (v_tenant, v_item.branch_id, 'material', v_item.material_id, 'ADJUSTMENT', -v_item.qty, p_purchase, auth.uid());
    else
      update finished_goods set qty_balance = qty_balance - v_item.qty
       where id = v_item.finished_good_id and tenant_id = v_tenant;
      update fg_batches set qty_remaining = 0 where id = v_item.fg_batch_id;

      insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
      values (v_tenant, v_item.branch_id, 'finished_good', v_item.finished_good_id, 'ADJUSTMENT', -v_item.qty, p_purchase, auth.uid());
    end if;
  end loop;

  update purchase_items set qty_remaining = 0
   where purchase_order_id = p_purchase and tenant_id = v_tenant;

  update purchase_orders set voided = true, voided_at = now() where id = p_purchase;
end $$;
