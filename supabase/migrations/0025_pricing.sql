-- ============================================================
-- StockFlow — Price lists, quantity breaks, and discount limits
--
-- Until now create_sale accepted any unit_price >= 0 the app sent, with no
-- idea what that product "should" cost — a cashier typing ₦1 and a genuine
-- wholesale price looked identical to the server.
--
-- After this migration:
--   • Businesses can set up price lists (Retail, Wholesale, Distributor…),
--     each with its own price per product and, optionally, quantity
--     breaks ("12+ at ₦2,400").
--   • A customer's price comes from: their own list, then their customer
--     type's list, then the business's default list, then the product's
--     plain selling price — in that order.
--   • The server works out the discount for itself (list price vs. what
--     was actually charged) and checks it against a per-role limit
--     (tenants.pricing_rules). Over the limit needs an admin's PIN.
--   • Selling below cost is warned about (or blocked outright, if the
--     business turns that on) — worked out from the FIFO cost the sale
--     actually drew, the same number the P&L uses.
--   • Nothing changes for a business that never touches this: with no
--     price lists configured, every product's list price is just its
--     plain selling price, so a normal sale has a 0% discount and never
--     needs approval.
--
-- Run AFTER 0001–0024.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Price lists
-- ------------------------------------------------------------
create table if not exists price_lists (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  is_default boolean not null default false,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);
-- One default list per company — resolve_price() relies on there being
-- at most one to fall back to.
create unique index if not exists uq_price_lists_one_default
  on price_lists (tenant_id) where is_default;

create table if not exists price_list_items (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  price_list_id    uuid not null references price_lists(id) on delete cascade,
  finished_good_id uuid not null references finished_goods(id) on delete cascade,
  -- Quantity breaks: the row with the largest min_qty at or below the
  -- quantity sold wins. min_qty 1 is the list's plain price for that
  -- product. Not yet exposed as more than one row in the UI — the
  -- database is ready for it, Settings just doesn't offer a second
  -- breakpoint yet.
  min_qty          numeric(14,3) not null default 1 check (min_qty > 0),
  price            numeric(14,2) not null check (price >= 0)
);
create unique index if not exists uq_price_list_items_break
  on price_list_items (price_list_id, finished_good_id, min_qty);
create index if not exists idx_price_list_items_product
  on price_list_items (tenant_id, finished_good_id);

alter table customer_types add column if not exists price_list_id uuid references price_lists(id) on delete set null;
alter table customers      add column if not exists price_list_id uuid references price_lists(id) on delete set null;

alter table price_lists      enable row level security;
alter table price_list_items enable row level security;

-- Everyone who sells or produces needs to see prices; only an admin sets
-- them up — the same shape as customer_types/payment_types (0017).
drop policy if exists price_lists_read on price_lists;
create policy price_lists_read on price_lists for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales','inventory','accounts'));
drop policy if exists price_lists_write on price_lists;
create policy price_lists_write on price_lists for all
  using (tenant_id = public.current_tenant_id() and public.current_role() = 'admin' and public.tenant_is_live())
  with check (tenant_id = public.current_tenant_id() and public.current_role() = 'admin' and public.tenant_is_live());

drop policy if exists price_list_items_read on price_list_items;
create policy price_list_items_read on price_list_items for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales','inventory','accounts'));
drop policy if exists price_list_items_write on price_list_items;
create policy price_list_items_write on price_list_items for all
  using (tenant_id = public.current_tenant_id() and public.current_role() = 'admin' and public.tenant_is_live())
  with check (tenant_id = public.current_tenant_id() and public.current_role() = 'admin' and public.tenant_is_live());

-- A price list is a paid feature; the tables above stay usable by direct
-- SQL (support, migrations) regardless.
create or replace function public.guard_price_list_feature()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    perform public.require_feature('price_tiers', 'Price lists');
  end if;
  return NEW;
end $$;
drop trigger if exists trg_guard_price_feature on price_lists;
create trigger trg_guard_price_feature before insert on price_lists
  for each row execute function public.guard_price_list_feature();


-- ------------------------------------------------------------
-- 2. What a sale actually charged, vs. what the list said
-- ------------------------------------------------------------
alter table sale_items add column if not exists list_price      numeric(14,2);
alter table sale_items add column if not exists discount_amount numeric(14,2) not null default 0;
alter table sale_items add column if not exists discount_reason text;

alter table sales_orders add column if not exists price_list_id  uuid references price_lists(id) on delete set null;
alter table sales_orders add column if not exists discount_total numeric(14,2) not null default 0;
alter table sales_orders add column if not exists approved_by    uuid references auth.users(id);

-- Per-role discount ceiling before a manager PIN is needed, and what to do
-- about a sale priced below its own cost. Admin's own limit is still read
-- from here, but create_sale never actually enforces it against them.
alter table tenants add column if not exists pricing_rules jsonb not null default
  '{"max_discount_pct": {"sales": 5, "accounts": 10, "inventory": 0, "admin": 100}, "below_cost": "warn"}'::jsonb;

-- An admin's own PIN, for approving another cashier's over-the-limit
-- discount. Hashed with a per-admin random salt — a lightweight gate
-- against a coworker glancing at a shared screen, not a login credential,
-- so plain md5(salt||pin) is a deliberate, dependency-free choice (no
-- pgcrypto contrib module needed in the PGlite test runtime either).
alter table profiles add column if not exists approval_pin_hash text;
alter table profiles add column if not exists approval_pin_salt text;

create or replace function public.set_approval_pin(p_pin text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_salt text := md5(random()::text || clock_timestamp()::text);
begin
  if public.current_role() <> 'admin' then
    raise exception 'Only an admin can set an approval PIN.' using errcode = 'insufficient_privilege';
  end if;
  if p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'Use a 4 to 6 digit PIN.';
  end if;
  update profiles set approval_pin_salt = v_salt, approval_pin_hash = md5(v_salt || p_pin) where id = auth.uid();
end $$;

create or replace function public.has_approval_pin()
returns boolean language sql stable security definer set search_path = public as $$
  select approval_pin_hash is not null from profiles where id = auth.uid()
$$;

create or replace function public.verify_approval_pin(p_admin uuid, p_pin text)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from profiles
     where id = p_admin and tenant_id = public.current_tenant_id() and role = 'admin'
       and approval_pin_hash is not null and p_pin is not null
       and approval_pin_hash = md5(approval_pin_salt || p_pin)
  )
$$;


-- ------------------------------------------------------------
-- 3. Which price a customer gets
-- ------------------------------------------------------------
-- Order: the customer's own list, then their customer type's list, then
-- the company's default list, then the product's plain selling price.
-- Internal only (not exposed to the API) — the frontend previews prices
-- from the same tables directly; this is create_sale's own authority.
create or replace function public.resolve_price(p_fg uuid, p_customer uuid, p_qty numeric)
returns table (unit_price numeric, price_list_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_list    uuid;
  v_price   numeric;
  v_default numeric;
begin
  if p_customer is not null then
    select c.price_list_id into v_list from customers c where c.id = p_customer and c.tenant_id = v_tenant;
    if v_list is null then
      select ct.price_list_id into v_list
        from customers c join customer_types ct on ct.id = c.customer_type_id
       where c.id = p_customer and c.tenant_id = v_tenant;
    end if;
  end if;
  if v_list is null then
    select id into v_list from price_lists where tenant_id = v_tenant and is_default and is_active limit 1;
  end if;

  if v_list is not null then
    select pli.price into v_price
      from price_list_items pli
     where pli.price_list_id = v_list and pli.finished_good_id = p_fg and pli.min_qty <= p_qty
     order by pli.min_qty desc limit 1;
  end if;

  select selling_price into v_default from finished_goods where id = p_fg and tenant_id = v_tenant;
  return query select coalesce(v_price, v_default, 0), v_list;
end $$;


-- ------------------------------------------------------------
-- 4. create_sale: price-aware, with a discount ceiling
-- ------------------------------------------------------------
drop function if exists public.create_sale(uuid, date, uuid, numeric, jsonb, numeric, uuid);

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

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item.';
  end if;
  perform public.assert_same_tenant('customers', p_customer);
  perform public.assert_same_tenant('payment_types', p_payment_type);

  select case when vat_enabled then coalesce(vat_rate, 0) else 0 end, coalesce(allow_expired_sale, false),
         coalesce(pricing_rules->>'below_cost', 'warn')
    into v_vat_rate, v_allow, v_below_cost from tenants where id = v_tenant;

  insert into sales_orders(tenant_id, branch_id, customer_id, transaction_date, payment_type_id, created_by)
  values (v_tenant, v_branch, p_customer, v_date, p_payment_type, auth.uid())
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
                           list_price, discount_amount, discount_reason)
    values (v_tenant, v_sale, v_fg, v_qty, v_price, v_line, v_list_price, v_line_discount, v_reason)
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
    insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id)
    values (v_tenant, v_sale, v_paid, p_payment_type);
  end if;

  if v_total_discount > 0 then
    perform public.log_audit('discount', 'sales_orders', v_sale::text,
      jsonb_build_object('discount_total', v_total_discount, 'discount_pct', v_discount_pct, 'approved_by', v_approved_by));
  end if;

  return v_sale;
end $$;


-- ------------------------------------------------------------
-- 5. Reporting: where the discounts are going
-- ------------------------------------------------------------
create or replace function public.report_discounts(
  p_from   date default null,
  p_to     date default null,
  p_branch uuid default null
)
returns table (
  reason         text,
  line_count     bigint,
  qty            numeric,
  discount_value numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('accounts') then
    raise exception 'Only admin and accounts can see the discounts report.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select coalesce(si.discount_reason, '(no reason given)'),
         count(*), sum(si.quantity), sum(si.discount_amount)
    from sale_items si
    join sales_orders so on so.id = si.sales_order_id
   where si.tenant_id = public.current_tenant_id()
     and so.voided = false
     and si.discount_amount > 0
     and (p_from   is null or so.transaction_date >= p_from)
     and (p_to     is null or so.transaction_date <= p_to)
     and (p_branch is null or so.branch_id = p_branch)
   group by coalesce(si.discount_reason, '(no reason given)')
   order by sum(si.discount_amount) desc;
end $$;


-- ------------------------------------------------------------
-- 6. Grants
-- ------------------------------------------------------------
revoke execute on function public.resolve_price(uuid, uuid, numeric)      from public, anon, authenticated;
revoke execute on function public.guard_price_list_feature()               from public, anon, authenticated;
-- Internal only: a callable RPC here would let anyone brute-force a PIN
-- by guessing repeatedly with no rate limit. create_sale calls it as the
-- function owner, which needs no grant of its own.
revoke execute on function public.verify_approval_pin(uuid, text)          from public, anon, authenticated;

grant execute on function public.set_approval_pin(text)                    to authenticated;
grant execute on function public.has_approval_pin()                        to authenticated;
grant execute on function public.create_sale(uuid, date, uuid, numeric, jsonb, numeric, uuid, numeric, jsonb) to authenticated;
grant execute on function public.report_discounts(date, date, uuid)        to authenticated;
