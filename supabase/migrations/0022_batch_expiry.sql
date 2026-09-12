-- ============================================================
-- StockFlow — Batch numbers, manufacture and expiry dates
--
-- NAFDAC requires soaps, cosmetics, food and drugs to carry a batch number,
-- a manufacture date and an expiry date. Until now StockFlow tracked none of
-- them: "Expired" existed only as a stock-adjustment reason.
--
-- After this migration:
--   • Every production run gets a batch number (auto-generated, or typed in),
--     a manufacture date and, when known, an expiry date. The batch number
--     travels with the stock through transfers.
--   • A product can be set to "sell earliest expiry first" (FEFO) instead
--     of oldest-made first (FIFO).
--   • Expired stock and batches put on hold or recalled can't be sold —
--     at every branch, at once.
--   • batch_trace() answers "which materials went into batch X, and which
--     customers got it?" for a recall.
--   • Suppliers' batch numbers and expiry dates can be recorded on
--     purchases, so a finished batch traces back to the exact raw material.
--
-- Batch *numbers* are for every plan. Expiry tracking, FEFO, recall and
-- trace are Growth and above (see 0021).
--
-- Run AFTER 0001–0021.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Columns
-- ------------------------------------------------------------
alter table finished_goods
  add column if not exists track_batches   boolean not null default false,
  add column if not exists shelf_life_days int check (shelf_life_days is null or shelf_life_days > 0),
  add column if not exists pick_rule       text not null default 'fifo' check (pick_rule in ('fifo','fefo')),
  add column if not exists batch_prefix    text,
  add column if not exists nafdac_no       text;

alter table materials
  add column if not exists track_batches boolean not null default false;

alter table fg_batches
  add column if not exists batch_no      text,
  add column if not exists mfg_date      date,
  add column if not exists expiry_date   date,
  add column if not exists status        text not null default 'available'
    check (status in ('available','quarantine','recalled')),
  add column if not exists status_reason text;

alter table purchase_items
  add column if not exists supplier_batch_no text,
  add column if not exists expiry_date       date;

alter table production_runs
  add column if not exists batch_no    text,
  add column if not exists expiry_date date;

alter table stock_adjustments
  add column if not exists batch_id uuid;   -- the exact layer a write-off hit

alter table tenants
  add column if not exists expiry_warning_days int not null default 60
    check (expiry_warning_days between 1 and 730),
  add column if not exists allow_expired_sale boolean not null default false;

-- A production batch number identifies one run, company-wide. Transferred
-- and adjusted layers legitimately repeat it.
create unique index if not exists uq_fg_batch_no_production
  on fg_batches (tenant_id, finished_good_id, lower(batch_no))
  where origin = 'production' and batch_no is not null;
create index if not exists idx_fg_batches_expiry
  on fg_batches (tenant_id, expiry_date) where qty_remaining > 0 and expiry_date is not null;
create index if not exists idx_fg_batches_batch_no
  on fg_batches (tenant_id, finished_good_id, batch_no) where batch_no is not null;


-- ------------------------------------------------------------
-- 2. Helpers
-- ------------------------------------------------------------
-- Can this layer be sold on this date? Expiry day itself is still sellable.
create or replace function public.batch_is_sellable(p_status text, p_expiry date, p_on date, p_allow_expired boolean)
returns boolean language sql immutable as $$
  select p_status = 'available' and (p_allow_expired or p_expiry is null or p_expiry >= p_on)
$$;

-- PREFIX-YYMMDD-NN, e.g. LSOA-260912-01. The prefix is the product's own
-- (Settings) or the first four letters of its name.
create or replace function public.next_batch_no(p_tenant uuid, p_fg uuid, p_on date)
returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_prefix text;
  v_name   text;
  v_base   text;
  v_n      int;
  v_try    text;
begin
  select batch_prefix, name into v_prefix, v_name from finished_goods where id = p_fg;
  v_prefix := upper(regexp_replace(coalesce(nullif(trim(v_prefix), ''), left(regexp_replace(v_name, '[^A-Za-z0-9]', '', 'g'), 4)),
                                   '[^A-Za-z0-9]', '', 'g'));
  if v_prefix = '' then v_prefix := 'B'; end if;
  v_base := v_prefix || '-' || to_char(p_on, 'YYMMDD') || '-';

  select count(*) + 1 into v_n
    from fg_batches
   where tenant_id = p_tenant and finished_good_id = p_fg and origin = 'production'
     and batch_no like v_base || '%';
  loop
    v_try := v_base || case when v_n >= 100 then v_n::text else lpad(v_n::text, 2, '0') end;
    exit when not exists (
      select 1 from fg_batches
       where tenant_id = p_tenant and finished_good_id = p_fg and origin = 'production'
         and lower(batch_no) = lower(v_try));
    v_n := v_n + 1;
  end loop;
  return v_try;
end $$;

-- Switching on expiry tracking or FEFO is a paid feature. Direct REST
-- writes only: the SQL Editor (no tenant context) is left alone.
create or replace function public.guard_batch_feature()
returns trigger language plpgsql set search_path = public as $$
declare
  v_new jsonb := to_jsonb(NEW);
  v_old jsonb := case when TG_OP = 'UPDATE' then to_jsonb(OLD) else '{}'::jsonb end;
begin
  if current_user in ('authenticated', 'anon') then
    if (coalesce((v_new->>'track_batches')::boolean, false) and not coalesce((v_old->>'track_batches')::boolean, false))
       or (v_new->>'pick_rule' = 'fefo' and coalesce(v_old->>'pick_rule', '') <> 'fefo') then
      perform public.require_feature('batch_tracking', 'Batch and expiry tracking');
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_batch_feature on finished_goods;
create trigger trg_guard_batch_feature before insert or update on finished_goods
  for each row execute function public.guard_batch_feature();
drop trigger if exists trg_guard_batch_feature on materials;
create trigger trg_guard_batch_feature before insert or update on materials
  for each row execute function public.guard_batch_feature();


-- ------------------------------------------------------------
-- 3. Stock levels: on hand vs. sellable
-- ------------------------------------------------------------
-- `qty` stays what's physically on the shelf (it still adds up to
-- qty_balance). `sellable_qty` leaves out expired, on-hold and recalled
-- stock — that's the number a till may sell. The return type changes, so
-- drop first; dashboard_summary (plpgsql) only reads qty/min_level and
-- keeps working.
drop function if exists public.stock_levels(uuid);

create or replace function public.stock_levels(p_branch uuid default null)
returns table (
  branch_id    uuid,
  branch_name  text,
  product_kind text,
  product_id   uuid,
  name         text,
  unit         text,
  qty          numeric,
  min_level    numeric,
  sellable_qty numeric
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tenant uuid := public.current_tenant_id();
  v_def    uuid;
  v_allow  boolean;
begin
  if v_tenant is null then
    raise exception 'No tenant context';
  end if;
  v_def := public.default_branch_id(v_tenant);
  select allow_expired_sale into v_allow from tenants where id = v_tenant;

  return query
  with br as (
    select b.id, b.name from branches b
     where b.tenant_id = v_tenant
       and (p_branch is null or b.id = p_branch)
       and (b.is_active or b.id = p_branch)
  ),
  layers as (
    select pi.branch_id as bid, 'material'::text as k, pi.material_id as pid,
           sum(pi.qty_remaining) as q, sum(pi.qty_remaining) as s
      from purchase_items pi where pi.tenant_id = v_tenant
     group by pi.branch_id, pi.material_id
    union all
    select fb.branch_id, 'finished_good'::text, fb.finished_good_id,
           sum(fb.qty_remaining),
           coalesce(sum(fb.qty_remaining) filter (
             where public.batch_is_sellable(fb.status, fb.expiry_date, current_date, coalesce(v_allow, false))), 0)
      from fg_batches fb where fb.tenant_id = v_tenant
     group by fb.branch_id, fb.finished_good_id
  ),
  products as (
    select 'material'::text as k, m.id as pid, m.name as nm, m.unit as un, m.min_stock_level as mn
      from materials m where m.tenant_id = v_tenant
    union all
    select 'finished_good'::text, g.id, g.name, g.unit, g.min_stock_level
      from finished_goods g where g.tenant_id = v_tenant
  )
  select br.id, br.name, p.k, p.pid, p.nm, p.un,
         coalesce(l.q, 0)::numeric, p.mn::numeric, coalesce(l.s, 0)::numeric
    from br
   cross join products p
    left join layers l on l.bid = br.id and l.k = p.k and l.pid = p.pid
   where l.pid is not null or br.id = v_def
   order by br.name, p.k, p.nm;
end $$;


-- ------------------------------------------------------------
-- 4. Purchases record the supplier's batch and expiry
-- ------------------------------------------------------------
-- Same signature as 0020, so this replaces it in place. Items may carry
-- optional supplier_batch_no and expiry_date.
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
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.resolve_branch(p_branch);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A purchase needs at least one item.';
  end if;
  perform public.assert_same_tenant('suppliers', p_supplier);
  perform public.assert_same_tenant('payment_types', p_payment_type);

  insert into purchase_orders(tenant_id, branch_id, supplier_id, purchase_date, payment_type_id, created_by)
  values (v_tenant, v_branch, p_supplier, coalesce(p_date, current_date), p_payment_type, auth.uid())
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

    v_amount := v_qty * v_cost;
    v_total  := v_total + v_amount;

    insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining,
                               cost_price, amount, branch_id, origin, supplier_batch_no, expiry_date)
    values (v_tenant, v_po, v_mat, v_qty, v_qty, v_cost, v_amount, v_branch, 'purchase',
            nullif(trim(v_item->>'supplier_batch_no'), ''),
            nullif(v_item->>'expiry_date', '')::date);

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


-- ------------------------------------------------------------
-- 5. Production stamps a batch
-- ------------------------------------------------------------
drop function if exists public.record_production(uuid, date, numeric, numeric, jsonb, uuid);

create or replace function public.record_production(
  p_finished_good uuid,
  p_date          date,
  p_expenses      numeric,
  p_qty           numeric,
  p_materials     jsonb,
  p_branch        uuid default null,
  p_batch_no      text default null,
  p_mfg_date      date default null,
  p_expiry_date   date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_branch   uuid;
  v_run      uuid;
  v_mat      jsonb;
  v_material uuid;
  v_mtrack   boolean;
  v_need     numeric;
  v_take     numeric;
  v_batch    record;
  v_material_cost numeric := 0;
  v_unit_cost numeric;
  v_markup   numeric;
  v_selling  numeric;
  v_name     text;
  v_unit     text;
  v_track    boolean;
  v_shelf    int;
  v_mfg      date;
  v_expiry   date;
  v_batch_no text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity produced must be above zero.'; end if;
  if coalesce(p_expenses, 0) < 0 then raise exception 'Production expenses can''t be negative.'; end if;
  v_branch := public.resolve_branch(p_branch);
  perform public.assert_same_tenant('finished_goods', p_finished_good);

  -- ---- the batch ----
  select track_batches, shelf_life_days into v_track, v_shelf
    from finished_goods where id = p_finished_good;
  v_mfg    := coalesce(p_mfg_date, p_date, current_date);
  v_expiry := coalesce(p_expiry_date, case when v_shelf is not null then v_mfg + v_shelf end);
  if v_mfg > current_date then
    raise exception 'The manufacture date can''t be in the future.';
  end if;
  if v_expiry is not null and v_expiry <= v_mfg then
    raise exception 'The expiry date must be after the manufacture date.';
  end if;
  if v_track and v_expiry is null then
    raise exception 'This product tracks expiry. Enter an expiry date, or set a shelf life on the product.';
  end if;

  v_batch_no := nullif(trim(p_batch_no), '');
  if v_batch_no is not null then
    if length(v_batch_no) > 40 then
      raise exception 'Keep the batch number to 40 characters or fewer.';
    end if;
    if exists (select 1 from fg_batches
                where tenant_id = v_tenant and finished_good_id = p_finished_good
                  and origin = 'production' and lower(batch_no) = lower(v_batch_no)) then
      raise exception 'Batch number % is already used for this product.', v_batch_no;
    end if;
  else
    v_batch_no := public.next_batch_no(v_tenant, p_finished_good, v_mfg);
  end if;

  insert into production_runs(tenant_id, branch_id, finished_good_id, production_date, expenses,
                              qty_produced, created_by, batch_no, expiry_date)
  values (v_tenant, v_branch, p_finished_good, coalesce(p_date, current_date), coalesce(p_expenses, 0),
          p_qty, auth.uid(), v_batch_no, v_expiry)
  returning id into v_run;

  for v_mat in select * from jsonb_array_elements(coalesce(p_materials, '[]'::jsonb))
  loop
    v_material := (v_mat->>'material_id')::uuid;
    v_need     := (v_mat->>'qty')::numeric;
    if v_need is null or v_need <= 0 then
      raise exception 'Every material line needs a quantity above zero.';
    end if;
    perform public.assert_same_tenant('materials', v_material);
    select track_batches into v_mtrack from materials where id = v_material;

    -- FIFO within THIS branch (earliest expiry first for tracked
    -- materials); rows locked so a concurrent run can't draw the same
    -- layer twice.
    for v_batch in
      select id, qty_remaining, cost_price
        from purchase_items
       where tenant_id = v_tenant and branch_id = v_branch
         and material_id = v_material and qty_remaining > 0
       order by case when v_mtrack then expiry_date end asc nulls last, created_at asc, id asc
         for update
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
      select name, unit into v_name, v_unit from materials where id = v_material;
      raise exception 'Not enough % at % — short by % %.',
        v_name, public.branch_name(v_branch), v_need, coalesce(v_unit, '');
    end if;

    update materials set qty_balance = qty_balance - (v_mat->>'qty')::numeric
     where id = v_material and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_branch, 'material', v_material, 'PRODUCTION', -(v_mat->>'qty')::numeric, v_run, auth.uid());
  end loop;

  v_unit_cost := (v_material_cost + coalesce(p_expenses, 0)) / p_qty;

  select coalesce(default_markup, 1.5) into v_markup
    from finished_goods where id = p_finished_good and tenant_id = v_tenant;
  v_selling := round(v_unit_cost * coalesce(v_markup, 1.5), 2);

  update production_runs
     set material_cost = v_material_cost,
         total_cost    = v_material_cost + coalesce(p_expenses, 0),
         unit_cost     = v_unit_cost
   where id = v_run;

  insert into fg_batches(tenant_id, production_run_id, finished_good_id, qty, qty_remaining,
                         unit_cost, selling_price, branch_id, origin, batch_no, mfg_date, expiry_date)
  values (v_tenant, v_run, p_finished_good, p_qty, p_qty, v_unit_cost, v_selling, v_branch, 'production',
          v_batch_no, v_mfg, v_expiry);

  update finished_goods
     set qty_balance = qty_balance + p_qty, selling_price = v_selling
   where id = p_finished_good and tenant_id = v_tenant;

  insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
  values (v_tenant, v_branch, 'finished_good', p_finished_good, 'PRODUCTION', p_qty, v_run, auth.uid());

  return v_run;
end $$;


-- ------------------------------------------------------------
-- 6. Sales skip expired / held stock, and can follow FEFO
-- ------------------------------------------------------------
-- Same signature as 0020 (replaced in place). An item may carry
-- `fg_batch_id` to sell from one exact batch (a scanned batch label).
create or replace function public.create_sale(
  p_customer     uuid,
  p_date         date,
  p_payment_type uuid,
  p_amount_paid  numeric,
  p_items        jsonb,
  p_vat_rate     numeric default 0,   -- accepted for compatibility; ignored
  p_branch       uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_branch    uuid;
  v_sale      uuid;
  v_date      date := coalesce(p_date, current_date);
  v_item      jsonb;
  v_fg        uuid;
  v_pin       uuid;
  v_pinned    record;
  v_qty       numeric;
  v_price     numeric;
  v_line      numeric;
  v_subtotal  numeric := 0;
  v_vat_rate  numeric := 0;
  v_allow     boolean := false;
  v_vat       numeric := 0;
  v_total     numeric := 0;
  v_cogs      numeric := 0;
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
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.resolve_branch(p_branch);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item.';
  end if;
  perform public.assert_same_tenant('customers', p_customer);
  perform public.assert_same_tenant('payment_types', p_payment_type);

  -- VAT comes from the company's own settings, never the client.
  select case when vat_enabled then coalesce(vat_rate, 0) else 0 end, coalesce(allow_expired_sale, false)
    into v_vat_rate, v_allow from tenants where id = v_tenant;

  insert into sales_orders(tenant_id, branch_id, customer_id, transaction_date, payment_type_id, created_by)
  values (v_tenant, v_branch, p_customer, v_date, p_payment_type, auth.uid())
  returning id into v_sale;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_fg    := (v_item->>'finished_good_id')::uuid;
    v_qty   := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    v_pin   := nullif(v_item->>'fg_batch_id', '')::uuid;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every sale line needs a quantity above zero.';
    end if;
    if v_price is null or v_price < 0 then
      raise exception 'Selling price can''t be negative.';
    end if;
    perform public.assert_same_tenant('finished_goods', v_fg);
    select name, unit, pick_rule into v_name, v_unit, v_rule from finished_goods where id = v_fg;

    v_line := v_qty * v_price;
    v_subtotal := v_subtotal + v_line;

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
      -- What THIS branch can sell — not the company total, and not stock
      -- that's expired, recalled or on hold.
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

    insert into sale_items(tenant_id, sales_order_id, finished_good_id, quantity, unit_price, amount)
    values (v_tenant, v_sale, v_fg, v_qty, v_price, v_line)
    returning id into v_sale_item;

    v_need := v_qty;
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
      v_cogs := v_cogs + (v_take * v_batch.unit_cost);
      v_need := v_need - v_take;
    end loop;
    -- Another till got there first while we waited on the lock.
    if v_need > 0 then
      raise exception '% just sold out at % — please check the quantity and try again.',
        v_name, public.branch_name(v_branch);
    end if;

    update finished_goods set qty_balance = qty_balance - v_qty where id = v_fg and tenant_id = v_tenant;
    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_branch, 'finished_good', v_fg, 'SALE', -v_qty, v_sale, auth.uid());
  end loop;

  v_vat   := round(v_subtotal * v_vat_rate / 100, 2);
  v_total := v_subtotal + v_vat;

  v_paid   := greatest(0, least(coalesce(p_amount_paid, 0), v_total));
  v_status := case when v_paid <= 0 then 'unpaid' when v_paid >= v_total then 'full' else 'part' end;

  update sales_orders
     set subtotal = v_subtotal, vat_amount = v_vat, vat_rate = v_vat_rate,
         total_amount = v_total, amount_paid = v_paid, balance = v_total - v_paid,
         cogs = v_cogs, gross_profit = v_subtotal - v_cogs,   -- VAT is never profit
         payment_status = v_status, processed = true
   where id = v_sale;

  if v_paid > 0 then
    insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id)
    values (v_tenant, v_sale, v_paid, p_payment_type);
  end if;

  return v_sale;
end $$;


-- ------------------------------------------------------------
-- 7. Transfers carry the batch across
-- ------------------------------------------------------------
-- Without p_batch, only sellable finished goods move, in the product's
-- pick order — nobody should restock a shop with expired soap by accident.
-- With p_batch, exactly that layer moves whatever its state (e.g. sending
-- a recalled batch back to head office).
drop function if exists public.transfer_stock(uuid, uuid, text, uuid, numeric, text);

create or replace function public.transfer_stock(
  p_from    uuid,
  p_to      uuid,
  p_kind    text,
  p_product uuid,
  p_qty     numeric,
  p_note    text default null,
  p_batch   uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_mine   uuid;
  v_id     uuid;
  v_need   numeric;
  v_take   numeric;
  v_cost   numeric := 0;
  v_layer  record;
  v_name   text;
  v_unit   text;
  v_rule   text := 'fifo';
  v_mtrack boolean := false;
  v_allow  boolean;
  v_avail  numeric;
  v_onhand numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_kind not in ('material', 'finished_good') then raise exception 'Unknown stock type.'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Transfer quantity must be above zero.'; end if;
  if p_from is null or p_to is null or p_from = p_to then
    raise exception 'Choose two different branches.';
  end if;
  perform public.assert_active_branch(p_from);
  perform public.assert_active_branch(p_to);

  -- A storekeeper sends from their own branch; only an admin moves stock
  -- out of somewhere else.
  if public.current_role() <> 'admin' then
    v_mine := public.work_branch_id();
    if p_from <> v_mine then
      raise exception 'You can only send stock out of your own branch (%).', public.branch_name(v_mine);
    end if;
  end if;

  if p_kind = 'material' then
    select name, unit, track_batches into v_name, v_unit, v_mtrack
      from materials where id = p_product and tenant_id = v_tenant;
  else
    select name, unit, pick_rule into v_name, v_unit, v_rule
      from finished_goods where id = p_product and tenant_id = v_tenant;
  end if;
  if v_name is null then raise exception 'That item does not belong to this company.'; end if;
  select coalesce(allow_expired_sale, false) into v_allow from tenants where id = v_tenant;

  if p_batch is not null then
    if p_kind = 'material' then
      perform 1 from purchase_items
       where id = p_batch and tenant_id = v_tenant and branch_id = p_from and material_id = p_product;
    else
      perform 1 from fg_batches
       where id = p_batch and tenant_id = v_tenant and branch_id = p_from and finished_good_id = p_product;
    end if;
    if not found then
      raise exception 'That batch of % isn''t at %.', v_name, public.branch_name(p_from);
    end if;
  elsif p_kind = 'finished_good' then
    select coalesce(sum(qty_remaining) filter (
             where public.batch_is_sellable(status, expiry_date, current_date, v_allow)), 0),
           coalesce(sum(qty_remaining), 0)
      into v_avail, v_onhand
      from fg_batches
     where tenant_id = v_tenant and branch_id = p_from and finished_good_id = p_product;
    if v_avail < p_qty and v_onhand > v_avail then
      raise exception 'Only % % of % at % can be sent — % % are expired, recalled or on hold. Move those one batch at a time from Batches.',
        v_avail, coalesce(v_unit, ''), v_name, public.branch_name(p_from), v_onhand - v_avail, coalesce(v_unit, '');
    end if;
  end if;

  -- The guard trigger on this insert enforces role + live account.
  insert into stock_transfers(tenant_id, from_branch_id, to_branch_id, product_kind, product_id, qty, note, created_by)
  values (v_tenant, p_from, p_to, p_kind, p_product, p_qty, nullif(trim(p_note), ''), auth.uid())
  returning id into v_id;

  v_need := p_qty;
  if p_kind = 'material' then
    for v_layer in
      select * from purchase_items
       where tenant_id = v_tenant and branch_id = p_from
         and material_id = p_product and qty_remaining > 0
         and (p_batch is null or id = p_batch)
       order by case when v_mtrack then expiry_date end asc nulls last, created_at asc, id asc
         for update
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_layer.qty_remaining);
      update purchase_items set qty_remaining = qty_remaining - v_take where id = v_layer.id;
      insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining,
                                 cost_price, amount, branch_id, origin, created_at, stock_transfer_id,
                                 supplier_batch_no, expiry_date)
      values (v_tenant, null, p_product, v_take, v_take,
              v_layer.cost_price, v_take * v_layer.cost_price, p_to, 'transfer', v_layer.created_at, v_id,
              v_layer.supplier_batch_no, v_layer.expiry_date);
      v_cost := v_cost + v_take * v_layer.cost_price;
      v_need := v_need - v_take;
    end loop;
  else
    for v_layer in
      select * from fg_batches
       where tenant_id = v_tenant and branch_id = p_from
         and finished_good_id = p_product and qty_remaining > 0
         and (case when p_batch is null
                   then public.batch_is_sellable(status, expiry_date, current_date, v_allow)
                   else id = p_batch end)
       order by case when v_rule = 'fefo' then expiry_date end asc nulls last, produced_at asc, id asc
         for update
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_layer.qty_remaining);
      update fg_batches set qty_remaining = qty_remaining - v_take where id = v_layer.id;
      insert into fg_batches(tenant_id, production_run_id, finished_good_id, qty, qty_remaining,
                             unit_cost, selling_price, produced_at, branch_id, origin, stock_transfer_id,
                             batch_no, mfg_date, expiry_date, status, status_reason)
      values (v_tenant, null, p_product, v_take, v_take,
              v_layer.unit_cost, v_layer.selling_price, v_layer.produced_at, p_to, 'transfer', v_id,
              v_layer.batch_no, v_layer.mfg_date, v_layer.expiry_date, v_layer.status, v_layer.status_reason);
      v_cost := v_cost + v_take * v_layer.unit_cost;
      v_need := v_need - v_take;
    end loop;
  end if;

  if v_need > 0 then
    raise exception 'Only % % of % at % — can''t send %.',
      p_qty - v_need, coalesce(v_unit, ''), v_name, public.branch_name(p_from), p_qty;
  end if;

  update stock_transfers set total_cost = round(v_cost, 2) where id = v_id;

  insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
  values (v_tenant, p_from, p_kind, p_product, 'TRANSFER', -p_qty, v_id, auth.uid()),
         (v_tenant, p_to,   p_kind, p_product, 'TRANSFER',  p_qty, v_id, auth.uid());

  return v_id;
end $$;


-- ------------------------------------------------------------
-- 8. Adjustments know about batches
-- ------------------------------------------------------------
-- Adding stock may record its batch number, manufacture and expiry dates
-- (opening balances of already-labelled goods). Removing stock may name
-- the exact layer (writing off one expired batch).
drop function if exists public.adjust_stock(uuid, text, uuid, numeric, numeric, text);

create or replace function public.adjust_stock(
  p_branch    uuid,
  p_kind      text,
  p_product   uuid,
  p_qty_delta numeric,
  p_unit_cost numeric default null,
  p_reason    text default null,
  p_batch     uuid default null,
  p_batch_no  text default null,
  p_expiry    date default null,
  p_mfg       date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid;
  v_id     uuid;
  v_name   text;
  v_unit   text;
  v_price  numeric;
  v_markup numeric;
  v_shelf  int;
  v_cost   numeric;
  v_need   numeric;
  v_take   numeric;
  v_spent  numeric := 0;
  v_layer  record;
  v_expiry date;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_kind not in ('material', 'finished_good') then raise exception 'Unknown stock type.'; end if;
  if p_qty_delta is null or p_qty_delta = 0 then raise exception 'Enter how much to add or remove.'; end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'Unit cost can''t be negative.'; end if;
  if p_batch is not null and p_qty_delta > 0 then
    raise exception 'Pick a batch only when removing stock.';
  end if;
  v_branch := public.resolve_branch(p_branch);

  if p_kind = 'material' then
    select name, unit into v_name, v_unit from materials where id = p_product and tenant_id = v_tenant;
  else
    select name, unit, selling_price, default_markup, shelf_life_days
      into v_name, v_unit, v_price, v_markup, v_shelf
      from finished_goods where id = p_product and tenant_id = v_tenant;
  end if;
  if v_name is null then raise exception 'That item does not belong to this company.'; end if;

  v_expiry := coalesce(p_expiry, case when p_mfg is not null and v_shelf is not null then p_mfg + v_shelf end);
  if v_expiry is not null and p_mfg is not null and v_expiry <= p_mfg then
    raise exception 'The expiry date must be after the manufacture date.';
  end if;

  -- The guard trigger on this insert enforces role + live account.
  insert into stock_adjustments(tenant_id, branch_id, product_kind, product_id, qty_delta, reason, created_by, batch_id)
  values (v_tenant, v_branch, p_kind, p_product, p_qty_delta, nullif(trim(p_reason), ''), auth.uid(), p_batch)
  returning id into v_id;

  if p_qty_delta > 0 then
    -- No cost given: use the latest known cost for this item anywhere in the
    -- company, or for a product with no history, price ÷ markup.
    if p_kind = 'material' then
      v_cost := coalesce(p_unit_cost,
        (select cost_price from purchase_items where material_id = p_product and tenant_id = v_tenant
          order by created_at desc limit 1), 0);
      insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining,
                                 cost_price, amount, branch_id, origin, supplier_batch_no, expiry_date)
      values (v_tenant, null, p_product, p_qty_delta, p_qty_delta,
              v_cost, p_qty_delta * v_cost, v_branch, 'adjustment',
              nullif(trim(p_batch_no), ''), v_expiry);
      update materials set qty_balance = qty_balance + p_qty_delta where id = p_product;
    else
      v_cost := coalesce(p_unit_cost,
        (select unit_cost from fg_batches where finished_good_id = p_product and tenant_id = v_tenant
          order by produced_at desc limit 1),
        round(coalesce(v_price, 0) / nullif(v_markup, 0), 2), 0);
      insert into fg_batches(tenant_id, production_run_id, finished_good_id, qty, qty_remaining,
                             unit_cost, selling_price, branch_id, origin, batch_no, mfg_date, expiry_date)
      values (v_tenant, null, p_product, p_qty_delta, p_qty_delta,
              v_cost, coalesce(v_price, 0), v_branch, 'adjustment',
              nullif(trim(p_batch_no), ''), p_mfg, v_expiry);
      update finished_goods set qty_balance = qty_balance + p_qty_delta where id = p_product;
    end if;
    v_spent := p_qty_delta * v_cost;
  else
    v_need := -p_qty_delta;
    if p_kind = 'material' then
      for v_layer in
        select id, qty_remaining, cost_price as c from purchase_items
         where tenant_id = v_tenant and branch_id = v_branch
           and material_id = p_product and qty_remaining > 0
           and (p_batch is null or id = p_batch)
         order by created_at asc, id asc
           for update
      loop
        exit when v_need <= 0;
        v_take := least(v_need, v_layer.qty_remaining);
        update purchase_items set qty_remaining = qty_remaining - v_take where id = v_layer.id;
        v_spent := v_spent + v_take * v_layer.c;
        v_need  := v_need - v_take;
      end loop;
    else
      for v_layer in
        select id, qty_remaining, unit_cost as c from fg_batches
         where tenant_id = v_tenant and branch_id = v_branch
           and finished_good_id = p_product and qty_remaining > 0
           and (p_batch is null or id = p_batch)
         order by produced_at asc, id asc
           for update
      loop
        exit when v_need <= 0;
        v_take := least(v_need, v_layer.qty_remaining);
        update fg_batches set qty_remaining = qty_remaining - v_take where id = v_layer.id;
        v_spent := v_spent + v_take * v_layer.c;
        v_need  := v_need - v_take;
      end loop;
    end if;

    if v_need > 0 then
      raise exception 'Only % % of % % — can''t remove %.',
        -p_qty_delta - v_need, coalesce(v_unit, ''), v_name,
        case when p_batch is null then 'at ' || public.branch_name(v_branch) else 'in that batch' end,
        -p_qty_delta;
    end if;

    if p_kind = 'material' then
      update materials set qty_balance = qty_balance + p_qty_delta where id = p_product;
    else
      update finished_goods set qty_balance = qty_balance + p_qty_delta where id = p_product;
    end if;
  end if;

  update stock_adjustments
     set unit_cost  = round(v_spent / abs(p_qty_delta), 2),
         total_cost = round(v_spent, 2)
   where id = v_id;

  insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
  values (v_tenant, v_branch, p_kind, p_product, 'ADJUSTMENT', p_qty_delta, v_id, auth.uid());

  return v_id;
end $$;


-- ------------------------------------------------------------
-- 9. Writing off a whole batch
-- ------------------------------------------------------------
create or replace function public.write_off_batch(
  p_kind   text,
  p_batch  uuid,
  p_reason text default 'Expired'
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_branch  uuid;
  v_product uuid;
  v_qty     numeric;
  v_no      text;
  v_id      uuid;
  v_reason  text := coalesce(nullif(trim(p_reason), ''), 'Expired');
begin
  if p_kind = 'finished_good' then
    select branch_id, finished_good_id, qty_remaining, batch_no
      into v_branch, v_product, v_qty, v_no
      from fg_batches where id = p_batch and tenant_id = v_tenant;
  elsif p_kind = 'material' then
    select branch_id, material_id, qty_remaining, supplier_batch_no
      into v_branch, v_product, v_qty, v_no
      from purchase_items where id = p_batch and tenant_id = v_tenant;
  else
    raise exception 'Unknown stock type.';
  end if;
  if v_product is null then raise exception 'Batch not found.'; end if;
  if v_qty <= 0 then raise exception 'Nothing is left in that batch.'; end if;

  -- adjust_stock enforces role, live account and "your own branch".
  v_id := public.adjust_stock(v_branch, p_kind, v_product, -v_qty, null,
            v_reason || coalesce(' · batch ' || v_no, ''), p_batch);

  perform public.log_audit('write_off', 'batch', p_batch::text, jsonb_build_object(
    'kind', p_kind, 'product_id', v_product, 'batch_no', v_no, 'qty', v_qty, 'reason', v_reason));
  return v_id;
end $$;


-- ------------------------------------------------------------
-- 10. Hold, recall, release — every branch at once
-- ------------------------------------------------------------
create or replace function public.set_batch_status(
  p_fg       uuid,
  p_batch_no text,
  p_status   text,
  p_reason   text default null
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_rows   int;
begin
  if public.current_role() <> 'admin' then
    raise exception 'Only an admin can hold, recall or release a batch.' using errcode = 'insufficient_privilege';
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — batch changes are read-only until billing is sorted out.';
  end if;
  perform public.require_feature('batch_tracking', 'Batch recall');
  if p_status not in ('available','quarantine','recalled') then
    raise exception 'Unknown batch status %.', p_status;
  end if;
  if p_status <> 'available' and nullif(trim(p_reason), '') is null then
    raise exception 'Give a reason — it''s kept on the batch and in the audit log.';
  end if;
  perform public.assert_same_tenant('finished_goods', p_fg);

  update fg_batches
     set status = p_status,
         status_reason = case when p_status = 'available' then null else trim(p_reason) end
   where tenant_id = v_tenant and finished_good_id = p_fg
     and lower(batch_no) = lower(trim(p_batch_no));
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception 'No batch % found for this product.', p_batch_no;
  end if;

  perform public.log_audit('batch_' || p_status, 'batch', p_batch_no, jsonb_build_object(
    'product_id', p_fg, 'reason', nullif(trim(p_reason), ''), 'layers', v_rows));
  return v_rows;
end $$;


-- ------------------------------------------------------------
-- 11. Trace a batch: what went in, where it went
-- ------------------------------------------------------------
-- Customers (names and phones) are finance/owner information; a storekeeper
-- gets the upstream trace, the stock left, and how much was sold.
create or replace function public.batch_trace(p_fg uuid, p_batch_no text)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_layers uuid[];
  v_runs   uuid[];
  v_head   record;
  v_people boolean := public.has_role('accounts');
  v_sales  jsonb;
begin
  if not public.has_role('inventory', 'accounts') then
    raise exception 'Only admin, inventory and accounts can trace a batch.' using errcode = 'insufficient_privilege';
  end if;
  perform public.require_feature('batch_tracking', 'Batch trace');
  perform public.assert_same_tenant('finished_goods', p_fg);

  select array_agg(id), array_agg(production_run_id) filter (where production_run_id is not null)
    into v_layers, v_runs
    from fg_batches
   where tenant_id = v_tenant and finished_good_id = p_fg and lower(batch_no) = lower(trim(p_batch_no));
  if v_layers is null then
    raise exception 'No batch % found for this product.', p_batch_no;
  end if;

  select g.name as product, g.nafdac_no, g.unit,
         min(fb.mfg_date) as mfg_date, min(fb.expiry_date) as expiry_date,
         max(fb.batch_no) as batch_no,
         coalesce(sum(fb.qty) filter (where fb.origin <> 'transfer'), 0) as made,
         bool_or(fb.status = 'recalled') as recalled,
         bool_or(fb.status = 'quarantine') as on_hold,
         max(fb.status_reason) as status_reason
    into v_head
    from fg_batches fb join finished_goods g on g.id = fb.finished_good_id
   where fb.id = any(v_layers)
   group by g.name, g.nafdac_no, g.unit;

  select coalesce(jsonb_agg(x order by x->>'date', x->>'doc_no'), '[]'::jsonb) into v_sales
    from (
      select jsonb_build_object(
               'sale_id',  so.id,
               'doc_no',   so.doc_no,
               'date',     so.transaction_date,
               'branch',   public.branch_name(so.branch_id),
               'qty',      sum(sc.qty),
               'customer', case when not v_people then null
                                when c.id is null then 'Walk-in'
                                else coalesce(nullif(trim(coalesce(c.first_name, '') || ' ' || coalesce(c.last_name, '')), ''), c.company_store, 'Customer') end,
               'phone',    case when v_people then c.phone end
             ) as x
        from sales_consumption sc
        join sale_items si   on si.id = sc.sale_item_id
        join sales_orders so on so.id = si.sales_order_id
        left join customers c on c.id = so.customer_id
       where sc.fg_batch_id = any(v_layers) and so.voided = false
       group by so.id, so.doc_no, so.transaction_date, so.branch_id, c.id, c.first_name, c.last_name, c.company_store, c.phone
    ) s;

  return jsonb_build_object(
    'product',       v_head.product,
    'batch_no',      v_head.batch_no,
    'nafdac_no',     v_head.nafdac_no,
    'unit',          v_head.unit,
    'mfg_date',      v_head.mfg_date,
    'expiry_date',   v_head.expiry_date,
    'made',          v_head.made,
    'status',        case when v_head.recalled then 'recalled' when v_head.on_hold then 'quarantine' else 'available' end,
    'status_reason', v_head.status_reason,
    'shows_customers', v_people,
    'sources', coalesce((
      select jsonb_agg(jsonb_build_object(
               'material',          m.name,
               'unit',              m.unit,
               'qty',               pc.qty,
               'supplier',          coalesce(nullif(trim(coalesce(s.company_store, '') ), ''),
                                             nullif(trim(coalesce(s.first_name, '') || ' ' || coalesce(s.last_name, '')), '')),
               'supplier_batch_no', pi.supplier_batch_no,
               'material_expiry',   pi.expiry_date,
               'purchased_on',      po.purchase_date
             ) order by m.name)
        from production_consumption pc
        join materials m on m.id = pc.material_id
        left join purchase_items pi  on pi.id = pc.purchase_item_id
        left join purchase_orders po on po.id = pi.purchase_order_id
        left join suppliers s        on s.id = po.supplier_id
       where pc.production_run_id = any(coalesce(v_runs, '{}'))
    ), '[]'::jsonb),
    'stock', coalesce((
      select jsonb_agg(jsonb_build_object('branch', public.branch_name(fb.branch_id), 'qty', sum_q) order by public.branch_name(fb.branch_id))
        from (select branch_id, sum(qty_remaining) as sum_q from fg_batches
               where id = any(v_layers) group by branch_id) fb
       where fb.sum_q > 0
    ), '[]'::jsonb),
    'sold_qty', coalesce((select sum((x->>'qty')::numeric) from jsonb_array_elements(v_sales) x), 0),
    'sales', v_sales
  );
end $$;


-- ------------------------------------------------------------
-- 12. What's expiring
-- ------------------------------------------------------------
-- Quantities for everyone (a cashier should know not to shelve it); the
-- money at risk only for admin and accounts. Staff see their own branch.
create or replace function public.expiry_overview(p_branch uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_days   int;
  v_money  boolean := public.has_role('accounts');
  v_scope  uuid;
  v_out    jsonb;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select expiry_warning_days into v_days from tenants where id = v_tenant;
  v_scope := case when v_money then p_branch else public.my_branch_id() end;

  with b as (
    select fb.id, fb.finished_good_id, g.name, g.unit, fb.batch_no, fb.branch_id,
           fb.qty_remaining as qty, fb.expiry_date, fb.status,
           (fb.expiry_date - current_date) as days_left,
           fb.qty_remaining * fb.unit_cost as value
      from fg_batches fb join finished_goods g on g.id = fb.finished_good_id
     where fb.tenant_id = v_tenant and fb.qty_remaining > 0
       and (v_scope is null or fb.branch_id = v_scope)
       and ((fb.expiry_date is not null and fb.expiry_date <= current_date + v_days)
            or fb.status <> 'available')
  )
  select jsonb_build_object(
    'warning_days',   v_days,
    'expired_count',  count(*) filter (where status = 'available' and expiry_date < current_date),
    'expiring_count', count(*) filter (where status = 'available' and expiry_date >= current_date),
    'on_hold_count',  count(*) filter (where status <> 'available'),
    'expired_value',  case when v_money then coalesce(round(sum(value) filter (where status = 'available' and expiry_date < current_date), 2), 0) end,
    'expiring_value', case when v_money then coalesce(round(sum(value) filter (where status = 'available' and expiry_date >= current_date), 2), 0) end,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'batch_id',    x.id,
               'product_id',  x.finished_good_id,
               'name',        x.name,
               'unit',        x.unit,
               'batch_no',    x.batch_no,
               'branch_id',   x.branch_id,
               'branch',      public.branch_name(x.branch_id),
               'qty',         x.qty,
               'expiry_date', x.expiry_date,
               'days_left',   x.days_left,
               'status',      x.status,
               'value',       case when v_money then round(x.value, 2) end
             ) order by x.status <> 'available', x.expiry_date nulls last)
        from (select * from b order by status <> 'available', expiry_date nulls last limit 50) x
    ), '[]'::jsonb)
  ) into v_out
  from b;

  return v_out;
end $$;


-- ------------------------------------------------------------
-- 13. Grants
-- ------------------------------------------------------------
revoke execute on function public.next_batch_no(uuid, uuid, date) from public, anon, authenticated;
revoke execute on function public.guard_batch_feature()           from public, anon, authenticated;

grant execute on function public.batch_is_sellable(text, date, date, boolean)                                    to authenticated;
grant execute on function public.stock_levels(uuid)                                                              to authenticated;
grant execute on function public.record_production(uuid, date, numeric, numeric, jsonb, uuid, text, date, date)  to authenticated;
grant execute on function public.transfer_stock(uuid, uuid, text, uuid, numeric, text, uuid)                     to authenticated;
grant execute on function public.adjust_stock(uuid, text, uuid, numeric, numeric, text, uuid, text, date, date)  to authenticated;
grant execute on function public.write_off_batch(text, uuid, text)                                               to authenticated;
grant execute on function public.set_batch_status(uuid, text, text, text)                                        to authenticated;
grant execute on function public.batch_trace(uuid, text)                                                         to authenticated;
grant execute on function public.expiry_overview(uuid)                                                           to authenticated;
