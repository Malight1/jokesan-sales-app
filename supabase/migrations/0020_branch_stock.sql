-- ============================================================
-- StockFlow — Separate stores, each with its own stock
--
-- Until now `branch_id` was written onto sales, purchases and production
-- and then never read again. Stock was one company-wide pool: materials
-- and finished_goods carried a single qty_balance, and the FIFO layers
-- (purchase_items, fg_batches) had no branch at all — so a sale in Lagos
-- quietly drew down stock that was physically sitting in Abuja.
--
-- After this migration:
--
--   • Every FIFO layer belongs to a branch. A branch can only sell,
--     produce from, or send what it physically holds.
--   • qty_balance on materials/finished_goods stays as the COMPANY TOTAL
--     (every existing screen keeps reading it correctly); the per-branch
--     figure comes from the layers via stock_levels().
--   • Stock moves between branches with transfer_stock(), which carries
--     the original FIFO cost across so margins stay true.
--   • Opening stock and stock counts go through adjust_stock(), which
--     gives the stock a cost and a branch. This also fixes an old bug:
--     opening stock typed into the product/material forms or imported by
--     CSV had no FIFO layer behind it, so create_sale passed the stock
--     check and then failed with "Stock/batch mismatch" — it could never
--     be sold. Existing data is reconciled below so nothing on screen moves.
--   • Staff see their own branch's transactions; admin and accounts see
--     every branch. An admin switches the branch they're working at with
--     set_my_branch().
--
-- While rewriting the engine, these holes are closed too:
--   • Items, customers, suppliers and payment types are checked to belong
--     to the caller's company — previously another tenant's IDs were
--     accepted and stored.
--   • Zero/negative quantities, negative costs and negative payments are
--     rejected; a payment can't exceed what's owed or land on a voided
--     sale.
--   • FIFO layers are locked while being drawn down, so two tills selling
--     the last unit at the same moment can't both succeed.
--   • VAT is taken from the company's settings, not from whatever rate
--     the client sends.
--   • Product profitability (margins, COGS) now requires admin/accounts.
--
-- Run AFTER 0001–0019.
-- ============================================================


-- ------------------------------------------------------------
-- 0. Ledger type for transfers
-- ------------------------------------------------------------
-- Added but not used anywhere in this file: Postgres won't let a new enum
-- value be used in the same transaction that adds it. The functions below
-- only reference it when called, later.
alter type movement_type add value if not exists 'TRANSFER';


-- ------------------------------------------------------------
-- 1. Branch helpers
-- ------------------------------------------------------------

-- A company's default branch: its oldest active one.
create or replace function public.default_branch_id(p_tenant uuid)
returns uuid
language sql stable security definer set search_path = public as $$
  select id from branches
   where tenant_id = p_tenant
   order by is_active desc, created_at asc, id asc
   limit 1
$$;

-- The branch the caller belongs to, without ever raising — safe to use
-- inside RLS policies.
create or replace function public.my_branch_id()
returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(public.current_branch_id(),
                  public.default_branch_id(public.current_tenant_id()))
$$;

-- May the caller see records from this branch? Admin and accounts see all.
create or replace function public.can_see_branch(p_branch uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.has_role('accounts') or p_branch is not distinct from public.my_branch_id()
$$;

create or replace function public.branch_name(p_branch uuid)
returns text
language sql stable security definer set search_path = public as $$
  select coalesce((select name from branches where id = p_branch), 'this branch')
$$;

create or replace function public.assert_active_branch(p_branch uuid)
returns void
language plpgsql stable security definer set search_path = public as $$
declare v_active boolean;
begin
  select is_active into v_active from branches
   where id = p_branch and tenant_id = public.current_tenant_id();
  if not found then
    raise exception 'That branch does not belong to this company.';
  end if;
  if not v_active then
    raise exception '% has been deactivated.', public.branch_name(p_branch);
  end if;
end $$;

-- The branch the caller is WORKING at. Raises with a message a person can
-- act on, because this is what decides whose shelf stock moves.
create or replace function public.work_branch_id()
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid := public.current_branch_id();
  v_type   tenant_type;
begin
  if v_tenant is null then
    raise exception 'No tenant context';
  end if;
  if v_branch is null then
    select type into v_type from tenants where id = v_tenant;
    if v_type = 'multi_branch' and public.current_role() <> 'admin' then
      raise exception 'You are not assigned to a branch yet — ask an admin to set your branch under Settings → Team.';
    end if;
    v_branch := public.default_branch_id(v_tenant);
  end if;
  if v_branch is null then
    raise exception 'This company has no branch set up yet.';
  end if;
  perform public.assert_active_branch(v_branch);
  return v_branch;
end $$;

-- Resolve the branch for a stock-moving action. Staff always work at their
-- own branch; only an admin may name a different one.
create or replace function public.resolve_branch(p_branch uuid)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare v_mine uuid;
begin
  if p_branch is null then
    return public.work_branch_id();
  end if;
  perform public.assert_active_branch(p_branch);
  if public.current_role() <> 'admin' then
    v_mine := public.work_branch_id();
    if p_branch <> v_mine then
      raise exception 'You can only record stock at your own branch (%).', public.branch_name(v_mine);
    end if;
  end if;
  return p_branch;
end $$;

-- Refuse IDs that belong to another company. Foreign keys only prove a row
-- exists somewhere; they never checked whose it was.
create or replace function public.assert_same_tenant(p_table text, p_id uuid)
returns void
language plpgsql stable security definer set search_path = public as $$
declare
  v_ok boolean;
  v_label text := case p_table
    when 'materials'      then 'material'
    when 'finished_goods' then 'product'
    when 'customers'      then 'customer'
    when 'suppliers'      then 'supplier'
    when 'payment_types'  then 'payment method'
    else 'record' end;
begin
  if p_id is null then return; end if;
  if p_table not in ('materials','finished_goods','customers','suppliers','payment_types') then
    raise exception 'assert_same_tenant: unsupported table %', p_table;
  end if;
  execute format('select exists (select 1 from %I where id = $1 and tenant_id = $2)', p_table)
     into v_ok using p_id, public.current_tenant_id();
  if not v_ok then
    raise exception 'That % does not belong to this company.', v_label;
  end if;
end $$;


-- ------------------------------------------------------------
-- 2. Everyone and everything gets a branch
-- ------------------------------------------------------------
-- Every company already gets "Main" at signup; this covers any that didn't.
insert into branches (tenant_id, name)
select t.id, 'Main' from tenants t
 where not exists (select 1 from branches b where b.tenant_id = t.id);

-- Invited staff whose invite had no branch were left with NULL.
update profiles p
   set branch_id = public.default_branch_id(p.tenant_id)
 where p.branch_id is null and p.tenant_id is not null;

do $$
declare t text;
begin
  foreach t in array array[
    'sales_orders','purchase_orders','production_runs','stock_movements',
    'expenses','customers','suppliers'
  ] loop
    execute format(
      'update %I x set branch_id = public.default_branch_id(x.tenant_id) where x.branch_id is null', t);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 3. FIFO layers carry a branch
-- ------------------------------------------------------------
-- Material layers are purchase_items. Opening stock, adjustments and
-- transfers create layers that aren't tied to a purchase order.
alter table purchase_items alter column purchase_order_id drop not null;
alter table purchase_items add column if not exists branch_id uuid references branches(id) on delete restrict;
alter table purchase_items add column if not exists origin    text not null default 'purchase';
alter table fg_batches     add column if not exists branch_id uuid references branches(id) on delete restrict;
alter table fg_batches     add column if not exists origin    text not null default 'production';

-- A layer belongs to the branch that bought or produced it.
update purchase_items pi
   set branch_id = coalesce(po.branch_id, public.default_branch_id(pi.tenant_id))
  from purchase_orders po
 where po.id = pi.purchase_order_id and pi.branch_id is null;
update purchase_items pi
   set branch_id = public.default_branch_id(pi.tenant_id)
 where pi.branch_id is null;

update fg_batches fb
   set branch_id = coalesce(pr.branch_id, public.default_branch_id(fb.tenant_id))
  from production_runs pr
 where pr.id = fb.production_run_id and fb.branch_id is null;
update fg_batches fb
   set branch_id = public.default_branch_id(fb.tenant_id)
 where fb.branch_id is null;

alter table purchase_items alter column branch_id set not null;
alter table fg_batches     alter column branch_id set not null;

create index if not exists idx_purchase_items_branch_fifo
  on purchase_items (tenant_id, branch_id, material_id, created_at) where qty_remaining > 0;
create index if not exists idx_fg_batches_branch_fifo
  on fg_batches (tenant_id, branch_id, finished_good_id, produced_at) where qty_remaining > 0;


-- ------------------------------------------------------------
-- 4. Reconcile the layers to what people see on screen
-- ------------------------------------------------------------
-- The engine always moved qty_balance and the layers together, but the
-- product/material forms and the CSV importer wrote opening stock straight
-- into qty_balance with no layer behind it. Treat qty_balance as the truth
-- (it's what the owner typed and has been looking at): add a costed layer
-- at the default branch for any shortfall, draw down any surplus oldest
-- first, and write the missing ledger entry either way. No on-screen stock
-- figure changes as a result of this migration.
do $$
declare
  r record; b record;
  v_def uuid; v_diff numeric; v_cost numeric; v_left numeric; v_take numeric;
begin
  -- ---- materials ----
  for r in
    select m.id, m.tenant_id, m.qty_balance,
           coalesce((select sum(pi.qty_remaining) from purchase_items pi where pi.material_id = m.id), 0) as layered
      from materials m
  loop
    v_diff := r.qty_balance - r.layered;
    continue when v_diff = 0;
    v_def := public.default_branch_id(r.tenant_id);

    if v_diff > 0 then
      select cost_price into v_cost from purchase_items
       where material_id = r.id order by created_at desc limit 1;
      insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining,
                                 cost_price, amount, branch_id, origin)
      values (r.tenant_id, null, r.id, v_diff, v_diff,
              coalesce(v_cost, 0), v_diff * coalesce(v_cost, 0), v_def, 'opening');
    else
      v_left := -v_diff;
      for b in select id, qty_remaining from purchase_items
                where material_id = r.id and qty_remaining > 0
                order by created_at asc, id asc
      loop
        exit when v_left <= 0;
        v_take := least(v_left, b.qty_remaining);
        update purchase_items set qty_remaining = qty_remaining - v_take where id = b.id;
        v_left := v_left - v_take;
      end loop;
      -- A negative balance can't be backed by anything; bring it up to the
      -- layers rather than leave an impossible number on screen.
      if v_left > 0 then
        update materials set qty_balance = qty_balance + v_left where id = r.id;
        v_diff := v_diff + v_left;
      end if;
    end if;

    if v_diff <> 0 then
      insert into stock_movements(tenant_id, branch_id, product_kind, product_id,
                                  movement_type, quantity, reference_id, user_id)
      values (r.tenant_id, v_def, 'material', r.id, 'ADJUSTMENT', v_diff, null, null);
    end if;
  end loop;

  -- ---- finished goods ----
  for r in
    select g.id, g.tenant_id, g.qty_balance, g.selling_price, g.default_markup,
           coalesce((select sum(fb.qty_remaining) from fg_batches fb where fb.finished_good_id = g.id), 0) as layered
      from finished_goods g
  loop
    v_diff := r.qty_balance - r.layered;
    continue when v_diff = 0;
    v_def := public.default_branch_id(r.tenant_id);

    if v_diff > 0 then
      select unit_cost into v_cost from fg_batches
       where finished_good_id = r.id order by produced_at desc limit 1;
      -- With no production history, estimate cost back from price ÷ markup
      -- rather than record zero cost and overstate every future margin.
      v_cost := coalesce(v_cost, round(coalesce(r.selling_price, 0) / nullif(r.default_markup, 0), 2), 0);
      insert into fg_batches(tenant_id, production_run_id, finished_good_id, qty, qty_remaining,
                             unit_cost, selling_price, branch_id, origin)
      values (r.tenant_id, null, r.id, v_diff, v_diff,
              v_cost, coalesce(r.selling_price, 0), v_def, 'opening');
    else
      v_left := -v_diff;
      for b in select id, qty_remaining from fg_batches
                where finished_good_id = r.id and qty_remaining > 0
                order by produced_at asc, id asc
      loop
        exit when v_left <= 0;
        v_take := least(v_left, b.qty_remaining);
        update fg_batches set qty_remaining = qty_remaining - v_take where id = b.id;
        v_left := v_left - v_take;
      end loop;
      if v_left > 0 then
        update finished_goods set qty_balance = qty_balance + v_left where id = r.id;
        v_diff := v_diff + v_left;
      end if;
    end if;

    if v_diff <> 0 then
      insert into stock_movements(tenant_id, branch_id, product_kind, product_id,
                                  movement_type, quantity, reference_id, user_id)
      values (r.tenant_id, v_def, 'finished_good', r.id, 'ADJUSTMENT', v_diff, null, null);
    end if;
  end loop;
end $$;


-- ------------------------------------------------------------
-- 5. Transfers and adjustments
-- ------------------------------------------------------------
create table if not exists stock_transfers (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  from_branch_id uuid not null references branches(id) on delete restrict,
  to_branch_id   uuid not null references branches(id) on delete restrict,
  product_kind   text not null check (product_kind in ('material','finished_good')),
  product_id     uuid not null,
  qty            numeric(14,3) not null check (qty > 0),
  total_cost     numeric(14,2) not null default 0,
  note           text,
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now(),
  check (from_branch_id <> to_branch_id)
);

create table if not exists stock_adjustments (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  branch_id    uuid not null references branches(id) on delete restrict,
  product_kind text not null check (product_kind in ('material','finished_good')),
  product_id   uuid not null,
  qty_delta    numeric(14,3) not null check (qty_delta <> 0),
  unit_cost    numeric(14,2) not null default 0,
  total_cost   numeric(14,2) not null default 0,
  reason       text,
  created_by   uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now()
);

alter table purchase_items add column if not exists stock_transfer_id uuid references stock_transfers(id) on delete set null;
alter table fg_batches     add column if not exists stock_transfer_id uuid references stock_transfers(id) on delete set null;

create index if not exists idx_transfers_tenant on stock_transfers (tenant_id, created_at desc);
create index if not exists idx_adjust_tenant    on stock_adjustments (tenant_id, created_at desc);

alter table stock_transfers   enable row level security;
alter table stock_adjustments enable row level security;
-- No write policies: both tables are written only by the RPCs below.

-- Same role + live-account gate as the other money tables (0017).
drop trigger if exists trg_guard_write on stock_transfers;
create trigger trg_guard_write before insert on stock_transfers
  for each row execute function public.guard_money_write('admin,inventory', 'move stock between branches');
drop trigger if exists trg_guard_write on stock_adjustments;
create trigger trg_guard_write before insert on stock_adjustments
  for each row execute function public.guard_money_write('admin,inventory', 'adjust stock');


-- ------------------------------------------------------------
-- 6. Stock levels only move through the engine
-- ------------------------------------------------------------
-- SECURITY INVOKER on purpose: inside the SECURITY DEFINER engine
-- functions current_user is the function owner, so the engine passes; a
-- direct REST write arrives as `authenticated` and is refused.
create or replace function public.lock_stock_balance()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    if TG_OP = 'INSERT' and coalesce(NEW.qty_balance, 0) <> 0 then
      raise exception 'Opening stock can''t be typed in directly — create the item first, then use Adjust Stock so the stock gets a cost and a branch.'
        using errcode = 'insufficient_privilege';
    elsif TG_OP = 'UPDATE' and NEW.qty_balance is distinct from OLD.qty_balance then
      raise exception 'Stock levels only change through purchases, production, sales, transfers and stock adjustments.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_lock_stock on materials;
create trigger trg_lock_stock before insert or update on materials
  for each row execute function public.lock_stock_balance();
drop trigger if exists trg_lock_stock on finished_goods;
create trigger trg_lock_stock before insert or update on finished_goods
  for each row execute function public.lock_stock_balance();


-- ------------------------------------------------------------
-- 7. Per-branch stock levels
-- ------------------------------------------------------------
-- Quantities only — no costs — so every role may read them: a cashier can
-- tell a customer "Ikeja has 12". A product is listed at a branch once that
-- branch has ever held it; the default branch lists everything, so a brand
-- new product still shows up as out of stock somewhere.
create or replace function public.stock_levels(p_branch uuid default null)
returns table (
  branch_id    uuid,
  branch_name  text,
  product_kind text,
  product_id   uuid,
  name         text,
  unit         text,
  qty          numeric,
  min_level    numeric
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tenant uuid := public.current_tenant_id();
  v_def    uuid;
begin
  if v_tenant is null then
    raise exception 'No tenant context';
  end if;
  v_def := public.default_branch_id(v_tenant);

  return query
  with br as (
    select b.id, b.name from branches b
     where b.tenant_id = v_tenant
       and (p_branch is null or b.id = p_branch)
       and (b.is_active or b.id = p_branch)
  ),
  layers as (
    select pi.branch_id as bid, 'material'::text as k, pi.material_id as pid, sum(pi.qty_remaining) as q
      from purchase_items pi where pi.tenant_id = v_tenant
     group by pi.branch_id, pi.material_id
    union all
    select fb.branch_id, 'finished_good'::text, fb.finished_good_id, sum(fb.qty_remaining)
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
  select br.id, br.name, p.k, p.pid, p.nm, p.un, coalesce(l.q, 0)::numeric, p.mn::numeric
    from br
   cross join products p
    left join layers l on l.bid = br.id and l.k = p.k and l.pid = p.pid
   where l.pid is not null or br.id = v_def
   order by br.name, p.k, p.nm;
end $$;


-- ------------------------------------------------------------
-- 8. The engine, branch-aware
-- ------------------------------------------------------------
-- Signatures gain a trailing `p_branch uuid default null`. The old
-- signatures are dropped first: leaving them would create overloads that
-- PostgREST can't choose between.
drop function if exists public.create_purchase(uuid, date, uuid, numeric, jsonb);
drop function if exists public.record_production(uuid, date, numeric, numeric, jsonb);
drop function if exists public.create_sale(uuid, date, uuid, numeric, jsonb, numeric);

-- ---------- CREATE PURCHASE ----------
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
                               cost_price, amount, branch_id, origin)
    values (v_tenant, v_po, v_mat, v_qty, v_qty, v_cost, v_amount, v_branch, 'purchase');

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

-- ---------- RECORD PRODUCTION ----------
create or replace function public.record_production(
  p_finished_good uuid,
  p_date          date,
  p_expenses      numeric,
  p_qty           numeric,
  p_materials     jsonb,
  p_branch        uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_branch   uuid;
  v_run      uuid;
  v_mat      jsonb;
  v_material uuid;
  v_need     numeric;
  v_take     numeric;
  v_batch    record;
  v_material_cost numeric := 0;
  v_unit_cost numeric;
  v_markup   numeric;
  v_selling  numeric;
  v_name     text;
  v_unit     text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Quantity produced must be above zero.'; end if;
  if coalesce(p_expenses, 0) < 0 then raise exception 'Production expenses can''t be negative.'; end if;
  v_branch := public.resolve_branch(p_branch);
  perform public.assert_same_tenant('finished_goods', p_finished_good);

  insert into production_runs(tenant_id, branch_id, finished_good_id, production_date, expenses, qty_produced, created_by)
  values (v_tenant, v_branch, p_finished_good, coalesce(p_date, current_date), coalesce(p_expenses, 0), p_qty, auth.uid())
  returning id into v_run;

  for v_mat in select * from jsonb_array_elements(coalesce(p_materials, '[]'::jsonb))
  loop
    v_material := (v_mat->>'material_id')::uuid;
    v_need     := (v_mat->>'qty')::numeric;
    if v_need is null or v_need <= 0 then
      raise exception 'Every material line needs a quantity above zero.';
    end if;
    perform public.assert_same_tenant('materials', v_material);

    -- FIFO within THIS branch; rows locked so a concurrent run can't draw
    -- the same batch twice.
    for v_batch in
      select id, qty_remaining, cost_price
        from purchase_items
       where tenant_id = v_tenant and branch_id = v_branch
         and material_id = v_material and qty_remaining > 0
       order by created_at asc, id asc
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
                         unit_cost, selling_price, branch_id, origin)
  values (v_tenant, v_run, p_finished_good, p_qty, p_qty, v_unit_cost, v_selling, v_branch, 'production');

  update finished_goods
     set qty_balance = qty_balance + p_qty, selling_price = v_selling
   where id = p_finished_good and tenant_id = v_tenant;

  insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
  values (v_tenant, v_branch, 'finished_good', p_finished_good, 'PRODUCTION', p_qty, v_run, auth.uid());

  return v_run;
end $$;

-- ---------- CREATE SALE ----------
create or replace function public.create_sale(
  p_customer     uuid,
  p_date         date,
  p_payment_type uuid,
  p_amount_paid  numeric,
  p_items        jsonb,
  p_vat_rate     numeric default 0,   -- accepted for compatibility; ignored (see below)
  p_branch       uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_branch    uuid;
  v_sale      uuid;
  v_item      jsonb;
  v_fg        uuid;
  v_qty       numeric;
  v_price     numeric;
  v_line      numeric;
  v_subtotal  numeric := 0;
  v_vat_rate  numeric := 0;
  v_vat       numeric := 0;
  v_total     numeric := 0;
  v_cogs      numeric := 0;
  v_sale_item uuid;
  v_need      numeric;
  v_take      numeric;
  v_batch     record;
  v_avail     numeric;
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

  -- VAT comes from the company's own settings. Trusting the client's rate
  -- would let anyone zero-rate a sale through the API.
  select case when vat_enabled then coalesce(vat_rate, 0) else 0 end
    into v_vat_rate from tenants where id = v_tenant;

  insert into sales_orders(tenant_id, branch_id, customer_id, transaction_date, payment_type_id, created_by)
  values (v_tenant, v_branch, p_customer, coalesce(p_date, current_date), p_payment_type, auth.uid())
  returning id into v_sale;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_fg    := (v_item->>'finished_good_id')::uuid;
    v_qty   := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every sale line needs a quantity above zero.';
    end if;
    if v_price is null or v_price < 0 then
      raise exception 'Selling price can''t be negative.';
    end if;
    perform public.assert_same_tenant('finished_goods', v_fg);

    v_line := v_qty * v_price;
    v_subtotal := v_subtotal + v_line;

    -- What THIS branch holds — not the company total.
    select coalesce(sum(qty_remaining), 0) into v_avail
      from fg_batches
     where tenant_id = v_tenant and branch_id = v_branch and finished_good_id = v_fg;
    if v_avail < v_qty then
      select name, unit into v_name, v_unit from finished_goods where id = v_fg;
      raise exception 'Only % % of % left at % — can''t sell %.',
        v_avail, coalesce(v_unit, ''), v_name, public.branch_name(v_branch), v_qty;
    end if;

    insert into sale_items(tenant_id, sales_order_id, finished_good_id, quantity, unit_price, amount)
    values (v_tenant, v_sale, v_fg, v_qty, v_price, v_line)
    returning id into v_sale_item;

    v_need := v_qty;
    for v_batch in
      select id, qty_remaining, unit_cost from fg_batches
       where tenant_id = v_tenant and branch_id = v_branch
         and finished_good_id = v_fg and qty_remaining > 0
       order by produced_at asc, id asc
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
      select name into v_name from finished_goods where id = v_fg;
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

-- ---------- PAYMENTS ----------
-- Same signatures, so these replace in place. They used to accept a
-- negative amount, an overpayment, a voided sale, or another company's
-- sale ID (writing a payment row against it before noticing).
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
  v_row    record;
  v_paid   numeric;
  v_status pay_status;
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

  insert into sale_payments(tenant_id, sales_order_id, payment_date, amount_paid, payment_type_id, reference, notes)
  values (v_tenant, p_sale, current_date, p_amount, p_payment_type, p_reference, p_notes);

  select coalesce(sum(amount_paid), 0) into v_paid
    from sale_payments where sales_order_id = p_sale and tenant_id = v_tenant;
  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid >= v_row.total_amount then 'full'
                   else 'part' end;

  update sales_orders
     set amount_paid = v_paid, balance = v_row.total_amount - v_paid, payment_status = v_status
   where id = p_sale and tenant_id = v_tenant;
end $$;

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
  v_row    record;
  v_paid   numeric;
  v_status pay_status;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment has to be more than zero.';
  end if;
  perform public.assert_same_tenant('payment_types', p_payment_type);

  select * into v_row from purchase_orders where id = p_purchase and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase not found.'; end if;
  if v_row.voided then raise exception 'This purchase has been voided — it can''t take a payment.'; end if;
  if p_amount > v_row.balance + 0.005 then
    raise exception 'That''s more than the ₦% still owed on this purchase.', v_row.balance;
  end if;

  insert into purchase_payments(tenant_id, purchase_order_id, payment_date, amount_paid, payment_type_id, reference, notes)
  values (v_tenant, p_purchase, current_date, p_amount, p_payment_type, p_reference, p_notes);

  select coalesce(sum(amount_paid), 0) into v_paid
    from purchase_payments where purchase_order_id = p_purchase and tenant_id = v_tenant;
  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid >= v_row.total_amount then 'full'
                   else 'part' end;

  update purchase_orders
     set total_paid = v_paid, balance = v_row.total_amount - v_paid, payment_status = v_status
   where id = p_purchase and tenant_id = v_tenant;
end $$;

-- ---------- VOIDS ----------
-- void_sale restores stock to the exact batches it drew from, so it already
-- lands back at the right branch. The other two get clearer messages now
-- that stock can also leave a batch by transfer.
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
    select 1 from purchase_items
     where purchase_order_id = p_purchase and tenant_id = v_tenant
       and qty_remaining < qty
  ) then
    raise exception 'Can''t void: some of these materials have already been used in production or sent to another branch.';
  end if;

  for v_item in
    select material_id, qty, branch_id from purchase_items
     where purchase_order_id = p_purchase and tenant_id = v_tenant
  loop
    update materials set qty_balance = qty_balance - v_item.qty
     where id = v_item.material_id and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_item.branch_id, 'material', v_item.material_id, 'ADJUSTMENT', -v_item.qty, p_purchase, auth.uid());
  end loop;

  update purchase_items set qty_remaining = 0
   where purchase_order_id = p_purchase and tenant_id = v_tenant;

  update purchase_orders set voided = true, voided_at = now() where id = p_purchase;
end $$;

create or replace function public.void_production(p_run uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row   record;
  v_batch record;
  v_cons  record;
begin
  select * into v_row from production_runs where id = p_run and tenant_id = v_tenant for update;
  if not found then raise exception 'Production run not found'; end if;
  if v_row.voided then raise exception 'Production run is already voided'; end if;

  select * into v_batch from fg_batches
   where production_run_id = p_run and tenant_id = v_tenant
   limit 1 for update;

  if found and v_batch.qty_remaining < v_batch.qty then
    raise exception 'Can''t void: some of this batch has already been sold or sent to another branch.';
  end if;

  for v_cons in
    select pc.material_id, pc.purchase_item_id, pc.qty, pi.branch_id
      from production_consumption pc
      left join purchase_items pi on pi.id = pc.purchase_item_id
     where pc.production_run_id = p_run and pc.tenant_id = v_tenant
  loop
    if v_cons.purchase_item_id is not null then
      update purchase_items set qty_remaining = qty_remaining + v_cons.qty
       where id = v_cons.purchase_item_id and tenant_id = v_tenant;
    end if;

    update materials set qty_balance = qty_balance + v_cons.qty
     where id = v_cons.material_id and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, coalesce(v_cons.branch_id, v_row.branch_id), 'material', v_cons.material_id,
            'ADJUSTMENT', v_cons.qty, p_run, auth.uid());
  end loop;

  if v_batch.id is not null then
    update finished_goods set qty_balance = qty_balance - v_batch.qty
     where id = v_batch.finished_good_id and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_batch.branch_id, 'finished_good', v_batch.finished_good_id, 'ADJUSTMENT', -v_batch.qty, p_run, auth.uid());

    delete from fg_batches where id = v_batch.id and tenant_id = v_tenant;
  end if;

  update production_runs set voided = true, voided_at = now() where id = p_run;
end $$;


-- ------------------------------------------------------------
-- 9. Moving stock between branches
-- ------------------------------------------------------------
-- FIFO out of the sending branch; each chunk arrives at the receiving
-- branch as its own layer with the SAME unit cost and the same age, so a
-- product's margin is identical wherever it's finally sold. The company
-- total doesn't change — only where the stock sits.
create or replace function public.transfer_stock(
  p_from    uuid,
  p_to      uuid,
  p_kind    text,
  p_product uuid,
  p_qty     numeric,
  p_note    text default null
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
    select name, unit into v_name, v_unit from materials where id = p_product and tenant_id = v_tenant;
  else
    select name, unit into v_name, v_unit from finished_goods where id = p_product and tenant_id = v_tenant;
  end if;
  if v_name is null then raise exception 'That item does not belong to this company.'; end if;

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
       order by created_at asc, id asc
         for update
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_layer.qty_remaining);
      update purchase_items set qty_remaining = qty_remaining - v_take where id = v_layer.id;
      insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining,
                                 cost_price, amount, branch_id, origin, created_at, stock_transfer_id)
      values (v_tenant, null, p_product, v_take, v_take,
              v_layer.cost_price, v_take * v_layer.cost_price, p_to, 'transfer', v_layer.created_at, v_id);
      v_cost := v_cost + v_take * v_layer.cost_price;
      v_need := v_need - v_take;
    end loop;
  else
    for v_layer in
      select * from fg_batches
       where tenant_id = v_tenant and branch_id = p_from
         and finished_good_id = p_product and qty_remaining > 0
       order by produced_at asc, id asc
         for update
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_layer.qty_remaining);
      update fg_batches set qty_remaining = qty_remaining - v_take where id = v_layer.id;
      insert into fg_batches(tenant_id, production_run_id, finished_good_id, qty, qty_remaining,
                             unit_cost, selling_price, produced_at, branch_id, origin, stock_transfer_id)
      values (v_tenant, null, p_product, v_take, v_take,
              v_layer.unit_cost, v_layer.selling_price, v_layer.produced_at, p_to, 'transfer', v_id);
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
-- 10. Opening stock and stock counts
-- ------------------------------------------------------------
-- Positive: new stock arrives at the branch as a costed layer (opening
-- balances, found stock). Negative: stock leaves FIFO (damage, theft, a
-- count that came up short) and the cost of what left is recorded.
create or replace function public.adjust_stock(
  p_branch    uuid,
  p_kind      text,
  p_product   uuid,
  p_qty_delta numeric,
  p_unit_cost numeric default null,
  p_reason    text default null
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
  v_cost   numeric;
  v_need   numeric;
  v_take   numeric;
  v_spent  numeric := 0;
  v_layer  record;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_kind not in ('material', 'finished_good') then raise exception 'Unknown stock type.'; end if;
  if p_qty_delta is null or p_qty_delta = 0 then raise exception 'Enter how much to add or remove.'; end if;
  if p_unit_cost is not null and p_unit_cost < 0 then raise exception 'Unit cost can''t be negative.'; end if;
  v_branch := public.resolve_branch(p_branch);

  if p_kind = 'material' then
    select name, unit into v_name, v_unit from materials where id = p_product and tenant_id = v_tenant;
  else
    select name, unit, selling_price, default_markup into v_name, v_unit, v_price, v_markup
      from finished_goods where id = p_product and tenant_id = v_tenant;
  end if;
  if v_name is null then raise exception 'That item does not belong to this company.'; end if;

  -- The guard trigger on this insert enforces role + live account.
  insert into stock_adjustments(tenant_id, branch_id, product_kind, product_id, qty_delta, reason, created_by)
  values (v_tenant, v_branch, p_kind, p_product, p_qty_delta, nullif(trim(p_reason), ''), auth.uid())
  returning id into v_id;

  if p_qty_delta > 0 then
    -- No cost given: use the latest known cost for this item anywhere in the
    -- company, or for a product with no history, price ÷ markup.
    if p_kind = 'material' then
      v_cost := coalesce(p_unit_cost,
        (select cost_price from purchase_items where material_id = p_product and tenant_id = v_tenant
          order by created_at desc limit 1), 0);
      insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining,
                                 cost_price, amount, branch_id, origin)
      values (v_tenant, null, p_product, p_qty_delta, p_qty_delta,
              v_cost, p_qty_delta * v_cost, v_branch, 'adjustment');
      update materials set qty_balance = qty_balance + p_qty_delta where id = p_product;
    else
      v_cost := coalesce(p_unit_cost,
        (select unit_cost from fg_batches where finished_good_id = p_product and tenant_id = v_tenant
          order by produced_at desc limit 1),
        round(coalesce(v_price, 0) / nullif(v_markup, 0), 2), 0);
      insert into fg_batches(tenant_id, production_run_id, finished_good_id, qty, qty_remaining,
                             unit_cost, selling_price, branch_id, origin)
      values (v_tenant, null, p_product, p_qty_delta, p_qty_delta,
              v_cost, coalesce(v_price, 0), v_branch, 'adjustment');
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
      raise exception 'Only % % of % at % — can''t remove %.',
        -p_qty_delta - v_need, coalesce(v_unit, ''), v_name, public.branch_name(v_branch), -p_qty_delta;
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
-- 11. An admin chooses which branch they're working at
-- ------------------------------------------------------------
create or replace function public.set_my_branch(p_branch uuid)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if public.current_role() <> 'admin' then
    raise exception 'Only an admin can switch branches — ask an admin to move you under Settings → Team.';
  end if;
  perform public.assert_active_branch(p_branch);
  update profiles set branch_id = p_branch where id = auth.uid();
end $$;


-- ------------------------------------------------------------
-- 11b. Branches are retired, never stranded or deleted
-- ------------------------------------------------------------
-- Transfers refuse an inactive branch, so deactivating one that still holds
-- stock would leave that stock counted in the company total with no way to
-- move or sell it. And deleting a branch would silently NULL the branch on
-- every sale it ever made.
create or replace function public.guard_branch_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_stock numeric; v_others int;
begin
  if NEW.tenant_id is distinct from OLD.tenant_id then
    raise exception 'A branch cannot be moved to another company.';
  end if;
  if OLD.is_active and not NEW.is_active then
    select coalesce((select sum(qty_remaining) from purchase_items where branch_id = OLD.id), 0)
         + coalesce((select sum(qty_remaining) from fg_batches     where branch_id = OLD.id), 0)
      into v_stock;
    if v_stock > 0 then
      raise exception '% still holds stock — transfer it to another branch before deactivating.', OLD.name;
    end if;
    select count(*) into v_others from branches
     where tenant_id = OLD.tenant_id and is_active and id <> OLD.id;
    if v_others = 0 then
      raise exception 'A company needs at least one active branch.';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_branch on branches;
create trigger trg_guard_branch before update on branches
  for each row execute function public.guard_branch_change();

-- SECURITY INVOKER so the SQL Editor can still clean up; the app cannot.
create or replace function public.guard_branch_delete()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    raise exception 'Deactivate the branch instead of deleting it — its sales and stock history need to stay attached.'
      using errcode = 'insufficient_privilege';
  end if;
  return OLD;
end $$;

drop trigger if exists trg_guard_branch_delete on branches;
create trigger trg_guard_branch_delete before delete on branches
  for each row execute function public.guard_branch_delete();


-- ------------------------------------------------------------
-- 12. Staff see their own branch; admin and accounts see all
-- ------------------------------------------------------------
-- Rebuilds the *_read policies from 0017 for every table that is about a
-- place, adding the branch test. Child rows follow their parent.
do $$
declare s record;
begin
  for s in
    select * from (values
      ('sales_orders',           'admin,sales,accounts',     'public.can_see_branch(branch_id)'),
      ('sale_items',             'admin,sales,accounts',     'exists (select 1 from sales_orders so where so.id = sales_order_id and public.can_see_branch(so.branch_id))'),
      ('sale_payments',          'admin,sales,accounts',     'exists (select 1 from sales_orders so where so.id = sales_order_id and public.can_see_branch(so.branch_id))'),
      ('purchase_orders',        'admin,inventory,accounts', 'public.can_see_branch(branch_id)'),
      ('purchase_items',         'admin,inventory,accounts', 'public.can_see_branch(branch_id)'),
      ('purchase_payments',      'admin,inventory,accounts', 'exists (select 1 from purchase_orders po where po.id = purchase_order_id and public.can_see_branch(po.branch_id))'),
      ('production_runs',        'admin,inventory,accounts', 'public.can_see_branch(branch_id)'),
      ('production_consumption', 'admin,inventory,accounts', 'exists (select 1 from production_runs pr where pr.id = production_run_id and public.can_see_branch(pr.branch_id))'),
      ('fg_batches',             'admin,inventory,accounts', 'public.can_see_branch(branch_id)'),
      ('stock_movements',        'admin,inventory,accounts', 'public.can_see_branch(branch_id)'),
      ('stock_transfers',        'admin,inventory,accounts', '(public.can_see_branch(from_branch_id) or public.can_see_branch(to_branch_id))'),
      ('stock_adjustments',      'admin,inventory,accounts', 'public.can_see_branch(branch_id)')
    ) as t(tbl, roles, pred)
  loop
    execute format('drop policy if exists %I on %I;', s.tbl || '_read', s.tbl);
    execute format(
      'create policy %I on %I for select using (tenant_id = public.current_tenant_id() and public.has_role(variadic string_to_array(%L, '','')) and %s);',
      s.tbl || '_read', s.tbl, s.roles, s.pred);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 13. Dashboards, branch-aware
-- ------------------------------------------------------------
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
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today), 0),
      'today_count', (
        select count(*) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today),
      'my_today_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today and created_by = v_uid), 0),
      'my_today_count', (
        select count(*) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today and created_by = v_uid),
      'today_unpaid', coalesce((
        select sum(balance) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today), 0),
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
                                    'qty', sm.quantity, 'kind', sm.product_kind, 'at', sm.created_at) as x
            from stock_movements sm
           where sm.tenant_id = v_tenant and sm.branch_id = v_branch
           order by sm.created_at desc limit 8) s)
    ) into v_out;

  -- ============ OWNER / ACCOUNTS: every branch ============
  else
    select v_common || jsonb_build_object(
      'total_sales',     coalesce((select sum(total_amount) from sales_orders    where tenant_id = v_tenant and not voided), 0),
      'sales_count',     (select count(*)                   from sales_orders    where tenant_id = v_tenant and not voided),
      'gross_profit',    coalesce((select sum(gross_profit) from sales_orders    where tenant_id = v_tenant and not voided), 0),
      'outstanding',     coalesce((select sum(balance)      from sales_orders    where tenant_id = v_tenant and not voided), 0),
      'total_purchases', coalesce((select sum(total_amount) from purchase_orders where tenant_id = v_tenant and not voided), 0),
      'purchase_count',  (select count(*)                   from purchase_orders where tenant_id = v_tenant and not voided),
      'creditors',       coalesce((select sum(balance)      from purchase_orders where tenant_id = v_tenant and not voided), 0),
      'total_expenses',  coalesce((select sum(amount)       from expenses        where tenant_id = v_tenant), 0),
      'expense_count',   (select count(*)                   from expenses        where tenant_id = v_tenant),
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
                                         and so.transaction_date = v_today), 0),
                   'month', coalesce((select sum(so.total_amount) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date >= date_trunc('month', v_today)), 0),
                   'month_profit', coalesce((select sum(so.gross_profit) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date >= date_trunc('month', v_today)), 0),
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
-- 14. Product profitability: finance-only, filterable by branch
-- ------------------------------------------------------------
-- 0016 had no role check, so any signed-in staff member could pull every
-- product's COGS and margin.
drop function if exists public.report_product_profitability(date, date);

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
  select
    sc.finished_good_id,
    fg.name,
    sum(sc.qty),
    sum(sc.qty * sc.selling_price),
    sum(sc.qty * sc.unit_cost),
    sum(sc.qty * (sc.selling_price - sc.unit_cost)),
    case when sum(sc.qty * sc.selling_price) > 0
         then round(100 * sum(sc.qty * (sc.selling_price - sc.unit_cost)) / sum(sc.qty * sc.selling_price), 2)
         else 0 end
  from sales_consumption sc
  join sale_items     si on si.id = sc.sale_item_id
  join sales_orders   so on so.id = si.sales_order_id
  join finished_goods fg on fg.id = sc.finished_good_id
  where sc.tenant_id = public.current_tenant_id()
    and so.voided = false
    and (p_from   is null or so.transaction_date >= p_from)
    and (p_to     is null or so.transaction_date <= p_to)
    and (p_branch is null or so.branch_id = p_branch)
  group by sc.finished_good_id, fg.name
  order by sum(sc.qty * (sc.selling_price - sc.unit_cost)) desc;
end $$;


-- ------------------------------------------------------------
-- 15. Invited staff always land on a branch
-- ------------------------------------------------------------
-- Same as 0007 except the invite's branch falls back to the company's
-- default instead of NULL.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_tenant_id uuid;
  new_branch_id uuid;
  company text;
  ttype tenant_type;
  base_slug text;
  v_invite record;
begin
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
  base_slug := lower(regexp_replace(company, '[^a-zA-Z0-9]+', '-', 'g'))
               || '-' || substr(new.id::text, 1, 6);

  insert into tenants (name, slug, type)
    values (company, base_slug, ttype)
    returning id into new_tenant_id;

  insert into branches (tenant_id, name)
    values (new_tenant_id, 'Main')
    returning id into new_branch_id;

  insert into profiles (id, tenant_id, branch_id, role, full_name, email)
    values (new.id, new_tenant_id, new_branch_id, 'admin',
            new.raw_user_meta_data ->> 'full_name', new.email);

  insert into payment_types (tenant_id, name) values
    (new_tenant_id, 'Cash'), (new_tenant_id, 'Bank Transfer'), (new_tenant_id, 'Credit');
  insert into customer_types (tenant_id, name) values
    (new_tenant_id, 'Corporate'), (new_tenant_id, 'Private');
  insert into expense_types (tenant_id, name) values
    (new_tenant_id, 'Transport'), (new_tenant_id, 'Salary'), (new_tenant_id, 'Rent');

  return new;
end $$;


-- ------------------------------------------------------------
-- 16. Grants
-- ------------------------------------------------------------
grant execute on function public.create_purchase(uuid, date, uuid, numeric, jsonb, uuid)            to authenticated;
grant execute on function public.record_production(uuid, date, numeric, numeric, jsonb, uuid)       to authenticated;
grant execute on function public.create_sale(uuid, date, uuid, numeric, jsonb, numeric, uuid)       to authenticated;
grant execute on function public.transfer_stock(uuid, uuid, text, uuid, numeric, text)              to authenticated;
grant execute on function public.adjust_stock(uuid, text, uuid, numeric, numeric, text)             to authenticated;
grant execute on function public.set_my_branch(uuid)                                                to authenticated;
grant execute on function public.stock_levels(uuid)                                                 to authenticated;
grant execute on function public.dashboard_summary()                                                to authenticated;
grant execute on function public.report_product_profitability(date, date, uuid)                    to authenticated;
