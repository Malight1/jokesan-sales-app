-- ============================================================
-- StockFlow — Units of measure (Phase 6c)
--
-- Until now every quantity was typed and stored in one base unit per
-- product (pieces, kg, litres...) — selling "2 cartons" meant the
-- cashier had to know it's 24 pieces and type 24. product_units lets a
-- product define named units ("Carton" = 12, "Dozen" = 12, "Bag" = 25kg)
-- with a barcode of their own.
--
-- The engine still works entirely in base units — nothing about FIFO
-- costing, discounts, or reporting changes. create_sale/create_purchase/
-- receive_purchase_order convert {uom_id, uom_qty} to base-unit quantity
-- in ONE place, right where they already read the line's quantity, then
-- everything below that point is completely untouched. unit_price/
-- cost_price stay per BASE unit always — a line sold or bought by the
-- carton still prices per piece, same as before; only the QUANTITY entry
-- changes. Deferred: price_list_items per-UOM pricing (FEATURE_PLAN.md's
-- 6c mentions it) — a price list still resolves in base units only.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Schema
-- ------------------------------------------------------------

create table if not exists product_units (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references tenants(id) on delete cascade,
  product_kind          text not null check (product_kind in ('material', 'finished_good')),
  product_id            uuid not null,
  name                  text not null,             -- Carton, Bag, Dozen
  factor                numeric(14,6) not null check (factor > 0),   -- base units per this unit
  barcode               text,
  default_for_purchase  boolean not null default false,
  default_for_sale      boolean not null default false,
  created_at            timestamptz not null default now()
);
create unique index if not exists uq_product_units_barcode on product_units (tenant_id, barcode) where barcode is not null;
create index if not exists idx_product_units_product on product_units (tenant_id, product_kind, product_id);

alter table sale_items     add column if not exists uom_id     uuid references product_units(id);
alter table sale_items     add column if not exists uom_qty    numeric(14,3);
alter table sale_items     add column if not exists uom_factor numeric(14,6);
alter table purchase_items add column if not exists uom_id     uuid references product_units(id);
alter table purchase_items add column if not exists uom_qty    numeric(14,3);
alter table purchase_items add column if not exists uom_factor numeric(14,6);


-- ------------------------------------------------------------
-- 2. RLS — same shape as materials/finished_goods: everyone who needs
--    products to sell or buy can see their units; only admin/inventory
--    manage them, and only while the tenant is live (matching how every
--    other row in this generic policy loop already works — see 0017).
-- ------------------------------------------------------------

alter table product_units enable row level security;
drop policy if exists product_units_read on product_units;
drop policy if exists product_units_write on product_units;

create policy product_units_read on product_units for select
  using (tenant_id = public.current_tenant_id()
         and public.has_role(variadic string_to_array('admin,sales,inventory,accounts', ',')));

create policy product_units_write on product_units for all
  using (tenant_id = public.current_tenant_id()
         and public.has_role(variadic string_to_array('admin,inventory', ','))
         and public.tenant_is_live())
  with check (tenant_id = public.current_tenant_id()
         and public.has_role(variadic string_to_array('admin,inventory', ','))
         and public.tenant_is_live());


-- ------------------------------------------------------------
-- 3. The one place a unit is resolved to its base-unit factor
-- ------------------------------------------------------------

create or replace function public.resolve_uom_factor(p_product_kind text, p_product_id uuid, p_uom_id uuid)
returns numeric
language sql stable security definer set search_path = public as $$
  select factor from product_units
   where id = p_uom_id and tenant_id = public.current_tenant_id()
     and product_kind = p_product_kind and product_id = p_product_id
$$;


-- ------------------------------------------------------------
-- 4. create_sale, create_purchase and receive_purchase_order each
--    convert {uom_id, uom_qty} to base-unit quantity in one spot —
--    bodies otherwise unchanged from 0026/0029.
-- ------------------------------------------------------------

create or replace function public.create_sale(
  p_customer       uuid,
  p_date           date,
  p_payment_type   uuid,
  p_amount_paid    numeric,
  p_items          jsonb,
  p_vat_rate       numeric default 0,   -- accepted for compatibility; ignored
  p_branch         uuid default null,
  p_order_discount numeric default 0,   -- a flat ₦ amount off the whole sale
  p_approval       jsonb default null   -- {"user_id": "...", "pin": "1234"}, only when over the limit
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_role      user_role := public.current_role();
  v_branch    uuid;
  v_shift     uuid;   -- Phase 4
  v_sale      uuid;
  v_date      date := coalesce(p_date, current_date);
  v_item      jsonb;
  v_fg        uuid;
  v_pin       uuid;
  v_pinned    record;
  v_qty       numeric;
  v_price     numeric;
  v_line      numeric;
  v_list_price numeric;
  v_line_list_id uuid;
  v_sale_list_id uuid;
  v_line_discount numeric;
  v_reason    text;
  v_uom_id     uuid;   -- Phase 6c
  v_uom_qty    numeric;
  v_uom_factor numeric;
  v_subtotal  numeric := 0;
  v_total_list_value numeric := 0;
  v_total_discount   numeric := 0;
  v_vat_rate  numeric := 0;
  v_allow     boolean := false;
  v_below_cost text := 'warn';
  v_vat       numeric := 0;
  v_total     numeric := 0;
  v_cogs      numeric := 0;
  v_line_cogs numeric;
  v_sale_item uuid;
  v_need      numeric;
  v_take      numeric;
  v_batch     record;
  v_avail     numeric;
  v_onhand    numeric;
  v_rule      text;
  v_paid      numeric;
  v_status    pay_status;
  v_name      text;
  v_unit      text;
  v_max_pct   numeric;
  v_discount_pct numeric;
  v_approved_by uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.resolve_branch(p_branch);

  -- Phase 4: an open till, if this tenant requires one for selling.
  v_shift := public.current_open_shift(v_branch);
  if v_shift is null and public.shift_required('sales') then
    raise exception 'Open your till before selling.';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item.';
  end if;
  perform public.assert_same_tenant('customers', p_customer);
  perform public.assert_same_tenant('payment_types', p_payment_type);

  select case when vat_enabled then coalesce(vat_rate, 0) else 0 end, coalesce(allow_expired_sale, false),
         coalesce(pricing_rules->>'below_cost', 'warn')
    into v_vat_rate, v_allow, v_below_cost from tenants where id = v_tenant;

  insert into sales_orders(tenant_id, branch_id, customer_id, transaction_date, payment_type_id, created_by, shift_id)
  values (v_tenant, v_branch, p_customer, v_date, p_payment_type, auth.uid(), v_shift)
  returning id into v_sale;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_fg    := (v_item->>'finished_good_id')::uuid;
    v_qty   := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    v_pin   := nullif(v_item->>'fg_batch_id', '')::uuid;
    v_reason := nullif(trim(v_item->>'discount_reason'), '');
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every sale line needs a quantity above zero.';
    end if;
    if v_price is null or v_price < 0 then
      raise exception 'Selling price can''t be negative.';
    end if;
    perform public.assert_same_tenant('finished_goods', v_fg);
    select name, unit, pick_rule into v_name, v_unit, v_rule from finished_goods where id = v_fg;

    -- Phase 6c: a line sold by the carton/dozen/etc. converts to base
    -- units here, once — everything below (FIFO draw, COGS, discount
    -- math) keeps working in base units exactly as it always has.
    v_uom_id := nullif(v_item->>'uom_id', '')::uuid;
    if v_uom_id is not null then
      v_uom_qty := (v_item->>'uom_qty')::numeric;
      if v_uom_qty is null or v_uom_qty <= 0 then
        raise exception 'The unit quantity has to be more than zero.';
      end if;
      v_uom_factor := public.resolve_uom_factor('finished_good', v_fg, v_uom_id);
      if v_uom_factor is null then
        raise exception 'That unit doesn''t belong to %.', v_name;
      end if;
      v_qty := v_uom_qty * v_uom_factor;
    else
      v_uom_qty := null;
      v_uom_factor := null;
    end if;

    select rp.unit_price, rp.price_list_id into v_list_price, v_line_list_id from public.resolve_price(v_fg, p_customer, v_qty) rp;
    if v_sale_list_id is null then v_sale_list_id := v_line_list_id; end if;

    v_line := v_qty * v_price;
    v_subtotal := v_subtotal + v_line;
    v_total_list_value := v_total_list_value + (v_qty * v_list_price);
    -- Charging less than list is a discount; charging more is a price-up,
    -- not tracked as a negative discount.
    v_line_discount := greatest((v_qty * v_list_price) - v_line, 0);
    v_total_discount := v_total_discount + v_line_discount;

    if v_pin is not null then
      select * into v_pinned from fg_batches
       where id = v_pin and tenant_id = v_tenant and branch_id = v_branch and finished_good_id = v_fg;
      if not found then
        raise exception 'That batch of % isn''t at %.', v_name, public.branch_name(v_branch);
      end if;
      if v_pinned.status <> 'available' then
        raise exception 'Batch % of % is %, so it can''t be sold.', coalesce(v_pinned.batch_no, ''), v_name,
          case v_pinned.status when 'recalled' then 'recalled' else 'on hold' end;
      end if;
      if not public.batch_is_sellable(v_pinned.status, v_pinned.expiry_date, v_date, v_allow) then
        raise exception 'Batch % of % expired on %, so it can''t be sold.', coalesce(v_pinned.batch_no, ''), v_name,
          to_char(v_pinned.expiry_date, 'DD Mon YYYY');
      end if;
      if v_pinned.qty_remaining < v_qty then
        raise exception 'Only % % left in batch % of %.', v_pinned.qty_remaining, coalesce(v_unit, ''),
          coalesce(v_pinned.batch_no, ''), v_name;
      end if;
    else
      select coalesce(sum(qty_remaining) filter (
               where public.batch_is_sellable(status, expiry_date, v_date, v_allow)), 0),
             coalesce(sum(qty_remaining), 0)
        into v_avail, v_onhand
        from fg_batches
       where tenant_id = v_tenant and branch_id = v_branch and finished_good_id = v_fg;
      if v_avail < v_qty then
        if v_onhand > v_avail then
          raise exception 'Only % % of % can be sold at % — % % are expired, recalled or on hold.',
            v_avail, coalesce(v_unit, ''), v_name, public.branch_name(v_branch),
            v_onhand - v_avail, coalesce(v_unit, '');
        end if;
        raise exception 'Only % % of % left at % — can''t sell %.',
          v_avail, coalesce(v_unit, ''), v_name, public.branch_name(v_branch), v_qty;
      end if;
    end if;

    insert into sale_items(tenant_id, sales_order_id, finished_good_id, quantity, unit_price, amount,
                           list_price, discount_amount, discount_reason, uom_id, uom_qty, uom_factor)
    values (v_tenant, v_sale, v_fg, v_qty, v_price, v_line, v_list_price, v_line_discount, v_reason,
            v_uom_id, v_uom_qty, v_uom_factor)
    returning id into v_sale_item;

    v_need := v_qty;
    v_line_cogs := 0;
    for v_batch in
      select id, qty_remaining, unit_cost from fg_batches
       where tenant_id = v_tenant and branch_id = v_branch
         and finished_good_id = v_fg and qty_remaining > 0
         and (v_pin is null or id = v_pin)
         and public.batch_is_sellable(status, expiry_date, v_date, v_allow)
       order by case when v_rule = 'fefo' then expiry_date end asc nulls last,
                produced_at asc, id asc
         for update
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_batch.qty_remaining);
      update fg_batches set qty_remaining = qty_remaining - v_take where id = v_batch.id;
      insert into sales_consumption(tenant_id, sale_item_id, fg_batch_id, finished_good_id, qty, unit_cost, selling_price)
      values (v_tenant, v_sale_item, v_batch.id, v_fg, v_take, v_batch.unit_cost, v_price);
      v_line_cogs := v_line_cogs + (v_take * v_batch.unit_cost);
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      raise exception '% just sold out at % — please check the quantity and try again.',
        v_name, public.branch_name(v_branch);
    end if;
    v_cogs := v_cogs + v_line_cogs;

    if v_line < v_line_cogs then
      if v_below_cost = 'block' then
        raise exception '% would sell below its cost — charging %s but it cost %s. Raise the price, or ask a manager.',
          v_name, to_char(v_price, 'FM999,999,999.00'), to_char(round(v_line_cogs / v_qty, 2), 'FM999,999,999.00');
      else
        perform public.log_audit('below_cost_sale', 'finished_goods', v_fg::text,
          jsonb_build_object('charged', v_price, 'cost_per_unit', round(v_line_cogs / v_qty, 2), 'sale_item_id', v_sale_item));
      end if;
    end if;

    update finished_goods set qty_balance = qty_balance - v_qty where id = v_fg and tenant_id = v_tenant;
    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_branch, 'finished_good', v_fg, 'SALE', -v_qty, v_sale, auth.uid());
  end loop;

  if coalesce(p_order_discount, 0) < 0 then raise exception 'The order discount can''t be negative.'; end if;
  if p_order_discount > v_subtotal then raise exception 'The order discount can''t be more than the sale total.'; end if;
  v_total_discount := v_total_discount + coalesce(p_order_discount, 0);
  v_subtotal := v_subtotal - coalesce(p_order_discount, 0);

  v_max_pct := case when v_role = 'admin' then 100
                     else coalesce((
                       select (pricing_rules->'max_discount_pct'->>v_role::text)::numeric from tenants where id = v_tenant
                     ), 0) end;
  v_discount_pct := case when v_total_list_value > 0 then round(100 * v_total_discount / v_total_list_value, 2) else 0 end;

  if v_discount_pct > v_max_pct then
    v_approved_by := nullif(p_approval->>'user_id', '')::uuid;
    if v_approved_by is null or not public.verify_approval_pin(v_approved_by, p_approval->>'pin') then
      raise exception 'This %s%% discount is above your %s%% limit — a manager''s PIN is needed to go ahead.',
        to_char(v_discount_pct, 'FM999990.0'), to_char(v_max_pct, 'FM999990');
    end if;
  else
    v_approved_by := null;
  end if;

  v_vat   := round(v_subtotal * v_vat_rate / 100, 2);
  v_total := v_subtotal + v_vat;

  v_paid   := greatest(0, least(coalesce(p_amount_paid, 0), v_total));
  v_status := case when v_paid <= 0 then 'unpaid' when v_paid >= v_total then 'full' else 'part' end;

  update sales_orders
     set subtotal = v_subtotal, vat_amount = v_vat, vat_rate = v_vat_rate,
         total_amount = v_total, amount_paid = v_paid, balance = v_total - v_paid,
         cogs = v_cogs, gross_profit = v_subtotal - v_cogs,   -- VAT is never profit
         payment_status = v_status, processed = true,
         price_list_id = v_sale_list_id, discount_total = v_total_discount, approved_by = v_approved_by
   where id = v_sale;

  if v_paid > 0 then
    insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id, shift_id)
    values (v_tenant, v_sale, v_paid, p_payment_type, v_shift);
  end if;

  if v_total_discount > 0 then
    perform public.log_audit('discount', 'sales_orders', v_sale::text,
      jsonb_build_object('discount_total', v_total_discount, 'discount_pct', v_discount_pct, 'approved_by', v_approved_by));
  end if;

  return v_sale;
end $$;

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
    v_mat  := (v_item->>'material_id')::uuid;
    v_qty  := (v_item->>'qty')::numeric;
    v_cost := (v_item->>'cost_price')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every purchase line needs a quantity above zero.';
    end if;
    if v_cost is null or v_cost < 0 then
      raise exception 'Cost price can''t be negative.';
    end if;
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

create or replace function public.receive_purchase_order(
  p_po    uuid,
  p_lines jsonb,     -- [{line_id, qty, unit_cost?, supplier_batch_no?, expiry_date?, uom_id?, uom_qty?}]
  p_date  date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_po_row   record;
  v_gr       uuid;
  v_doc_no   text;
  v_line     jsonb;
  v_pol      record;
  v_qty      numeric;
  v_cost     numeric;
  v_amount   numeric;
  v_received numeric := 0;
  v_fully    boolean;
  v_uom_id     uuid;   -- Phase 6c
  v_uom_qty    numeric;
  v_uom_factor numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('admin', 'inventory') then
    raise exception 'Your role is not allowed to receive a purchase order.' using errcode = 'insufficient_privilege';
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — receiving is read-only until billing is sorted out.';
  end if;

  select * into v_po_row from purchase_orders where id = p_po and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase order not found.'; end if;
  if v_po_row.status not in ('ordered', 'partial') then
    raise exception 'This purchase order is % — there''s nothing left to receive.', v_po_row.status;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Receiving needs at least one line.';
  end if;

  v_doc_no := public.next_doc_no(v_tenant, 'GRN');
  insert into goods_receipts(tenant_id, branch_id, purchase_order_id, doc_no, received_at, received_by)
  values (v_tenant, v_po_row.branch_id, p_po, v_doc_no, coalesce(p_date::timestamptz, now()), auth.uid())
  returning id into v_gr;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_pol from purchase_order_lines
     where id = (v_line->>'line_id')::uuid and purchase_order_id = p_po and tenant_id = v_tenant
     for update;
    if not found then raise exception 'That line does not belong to this purchase order.'; end if;

    v_qty := (v_line->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every received line needs a quantity above zero.'; end if;

    -- Phase 6c: received by the bag/carton/etc. converts to base units
    -- here, once — qty_ordered/qty_received and the FIFO layer below are
    -- always in base units.
    v_uom_id := nullif(v_line->>'uom_id', '')::uuid;
    if v_uom_id is not null then
      v_uom_qty := (v_line->>'uom_qty')::numeric;
      if v_uom_qty is null or v_uom_qty <= 0 then
        raise exception 'The unit quantity has to be more than zero.';
      end if;
      v_uom_factor := public.resolve_uom_factor('material', v_pol.material_id, v_uom_id);
      if v_uom_factor is null then
        raise exception 'That unit doesn''t belong to this material.';
      end if;
      v_qty := v_uom_qty * v_uom_factor;
    else
      v_uom_qty := null;
      v_uom_factor := null;
    end if;

    if v_qty > (v_pol.qty_ordered - v_pol.qty_received) then
      raise exception 'Only % still expected on this line — % was ordered, % already received.',
        v_pol.qty_ordered - v_pol.qty_received, v_pol.qty_ordered, v_pol.qty_received;
    end if;
    v_cost := coalesce((v_line->>'unit_cost')::numeric, v_pol.unit_cost);
    if v_cost < 0 then raise exception 'Cost can''t be negative.'; end if;
    v_amount   := v_qty * v_cost;
    v_received := v_received + v_amount;

    update purchase_order_lines set qty_received = qty_received + v_qty where id = v_pol.id;

    insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining, cost_price, amount,
                               branch_id, origin, supplier_batch_no, expiry_date, goods_receipt_id, po_line_id,
                               uom_id, uom_qty, uom_factor)
    values (v_tenant, p_po, v_pol.material_id, v_qty, v_qty, v_cost, v_amount, v_po_row.branch_id, 'purchase',
            nullif(trim(v_line->>'supplier_batch_no'), ''), nullif(v_line->>'expiry_date', '')::date, v_gr, v_pol.id,
            v_uom_id, v_uom_qty, v_uom_factor);

    update materials set qty_balance = qty_balance + v_qty where id = v_pol.material_id and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_po_row.branch_id, 'material', v_pol.material_id, 'PURCHASE', v_qty, v_gr, auth.uid());
  end loop;

  select not exists (
    select 1 from purchase_order_lines where purchase_order_id = p_po and qty_received < qty_ordered
  ) into v_fully;

  update purchase_orders
     set status = case when v_fully then 'received' else 'partial' end,
         total_amount = total_amount + v_received,
         balance = balance + v_received
   where id = p_po;

  if v_fully and v_po_row.ordered_at is not null then
    update suppliers set lead_time_days = greatest(0, extract(day from (now() - v_po_row.ordered_at))::int)
     where id = v_po_row.supplier_id and tenant_id = v_tenant;
  end if;

  perform public.log_audit('goods_received', 'purchase_orders', p_po::text,
    jsonb_build_object('grn', v_doc_no, 'value', v_received));

  return v_gr;
end $$;
