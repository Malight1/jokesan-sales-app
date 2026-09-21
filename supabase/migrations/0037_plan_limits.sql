-- ============================================================
-- StockFlow — Real plan enforcement (Phase 8)
--
-- Until now the pricing page named features as Growth/Business perks —
-- quotes, units of measure, delivery notes, real purchase orders, smart
-- reorder, automatic payment confirmation, branch count, team size — that
-- weren't actually restricted anywhere. Every plan (including a lapsed
-- one, as long as it isn't fully suspended) could use all of it. Only
-- batch/expiry tracking (0022) and price lists (0025) were ever really
-- enforced.
--
-- After this migration, matching what PLANS in src/lib/api.ts now
-- promises:
--   • Growth+: quotes, units of measure, delivery notes, real purchase
--     orders (order-before-receiving), smart reorder suggestions.
--   • Business+: automatic payment confirmation (connecting a Paystack
--     account), on top of the existing Business-only custom fields,
--     e-invoicing readiness and the AI assistant.
--   • A genuine per-plan branch and team-seat cap: Starter 1 branch / 1
--     seat, Growth 3 branches / 5 seats, Business unlimited / 15 seats.
--
-- Every gate here follows the plan's own "voids reverse a computed
-- effect, never raw history" spirit: nothing already created is touched.
-- A tenant that's already over a new cap (more branches or team members
-- than their plan now allows) keeps everything that already exists —
-- they just can't add another one until they upgrade. The gate is on
-- INSERT only.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Per-plan caps — kept next to plan_level()/feature_level() (0021),
--    which this deliberately mirrors rather than duplicates ad hoc.
-- ------------------------------------------------------------
create or replace function public.plan_user_limit(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'starter'    then 1
    when 'growth'     then 5
    when 'business'   then 15
    when 'enterprise' then 999
    when 'trial'      then 999   -- a trial gets everything so people can try it
    else 1 end
$$;

create or replace function public.plan_branch_limit(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'starter'    then 1
    when 'growth'     then 3
    when 'business'   then 999
    when 'enterprise' then 999
    when 'trial'      then 999
    else 1 end
$$;

grant execute on function public.plan_user_limit(text)   to authenticated;
grant execute on function public.plan_branch_limit(text) to authenticated;


-- ------------------------------------------------------------
-- 2. Seat and branch caps — counting triggers, not require_feature(),
--    since these are numeric limits, not a plan/feature lookup. Guarded
--    the same way guard_price_list_feature() (0025) guards a direct
--    table write: only a real end-user REST call is current_user
--    'authenticated'/'anon' — a SECURITY DEFINER engine function (like
--    handle_new_user inserting a brand-new tenant's first branch) runs
--    as the function owner and never trips this at all.
-- ------------------------------------------------------------
create or replace function public.guard_seat_limit()
returns trigger language plpgsql set search_path = public as $$
declare
  v_plan  text;
  v_limit int;
  v_used  int;
begin
  if current_user in ('authenticated', 'anon') then
    select plan::text into v_plan from tenants where id = NEW.tenant_id;
    v_limit := public.plan_user_limit(v_plan);
    select count(*) into v_used from (
      select id from profiles      where tenant_id = NEW.tenant_id and is_active
      union all
      select id from staff_invites where tenant_id = NEW.tenant_id and status = 'pending'
    ) s;
    if v_used >= v_limit then
      raise exception 'Your plan allows % team member%. Upgrade under Settings → Billing to add more.',
        v_limit, case when v_limit = 1 then '' else 's' end
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_seat_limit on staff_invites;
create trigger trg_guard_seat_limit before insert on staff_invites
  for each row execute function public.guard_seat_limit();

create or replace function public.guard_branch_limit()
returns trigger language plpgsql set search_path = public as $$
declare
  v_plan  text;
  v_limit int;
  v_used  int;
begin
  if current_user in ('authenticated', 'anon') then
    select plan::text into v_plan from tenants where id = NEW.tenant_id;
    v_limit := public.plan_branch_limit(v_plan);
    select count(*) into v_used from branches where tenant_id = NEW.tenant_id and is_active;
    if v_used >= v_limit then
      raise exception 'Your plan allows % branch%. Upgrade under Settings → Billing to add more.',
        v_limit, case when v_limit = 1 then '' else 'es' end
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_branch_limit on branches;
create trigger trg_guard_branch_limit before insert on branches
  for each row execute function public.guard_branch_limit();


-- ------------------------------------------------------------
-- 3. Units of measure — a direct table write (no RPC of its own), so it's
--    gated the exact same way guard_price_list_feature() (0025) gates
--    price_lists.
-- ------------------------------------------------------------
create or replace function public.guard_units_feature()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('authenticated', 'anon') then
    perform public.require_feature('units', 'Units of measure');
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_units_feature on product_units;
create trigger trg_guard_units_feature before insert on product_units
  for each row execute function public.guard_units_feature();


-- ------------------------------------------------------------
-- 4. Quotes, real purchase orders, delivery notes, smart reorder —
--    require_feature() added to each RPC's own creation entry point.
--    Bodies copied verbatim from 0028/0029/0031/0034 (checked against
--    the live migration files, not reconstructed from memory) with only
--    the one new line inserted each — the same discipline as every
--    "re-copy a whole function" migration in this project.
-- ------------------------------------------------------------

create or replace function public.create_quote(
  p_customer   uuid,
  p_kind       text,
  p_items      jsonb,
  p_valid_until date default null,
  p_notes      text default null,
  p_terms      text default null,
  p_branch     uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_branch   uuid;
  v_quote    uuid;
  v_doc_no   text;
  v_vat_rate numeric := 0;
  v_item     jsonb;
  v_fg       uuid;
  v_qty      numeric;
  v_price    numeric;
  v_list     uuid;
  v_list_price numeric;
  v_line     numeric;
  v_subtotal numeric := 0;
  v_list_value numeric := 0;
  v_discount numeric := 0;
  v_vat      numeric := 0;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('quotes', 'Quotes and proforma invoices');
  if p_kind not in ('quote', 'proforma') then raise exception 'Unknown document kind %.', p_kind; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A quote needs at least one item.';
  end if;
  v_branch := public.resolve_branch(p_branch);

  select case when vat_enabled then coalesce(vat_rate, 0) else 0 end into v_vat_rate
    from tenants where id = v_tenant;

  v_doc_no := public.next_doc_no(v_tenant, case when p_kind = 'proforma' then 'PF' else 'QT' end);

  insert into quotes (tenant_id, branch_id, doc_no, customer_id, kind, valid_until, notes, terms, created_by)
  values (v_tenant, v_branch, v_doc_no, p_customer, p_kind, p_valid_until, p_notes, p_terms, auth.uid())
  returning id into v_quote;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_fg    := (v_item->>'finished_good_id')::uuid;
    v_qty   := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every quote line needs a quantity above zero.'; end if;
    if v_price is null or v_price < 0 then raise exception 'Price can''t be negative.'; end if;
    perform public.assert_same_tenant('finished_goods', v_fg);

    select rp.unit_price, rp.price_list_id into v_list_price, v_list from public.resolve_price(v_fg, p_customer, v_qty) rp;
    v_line := v_qty * v_price;
    v_subtotal   := v_subtotal + v_line;
    v_list_value := v_list_value + (v_qty * v_list_price);
    v_discount   := v_discount + greatest((v_qty * v_list_price) - v_line, 0);

    insert into quote_items (tenant_id, quote_id, finished_good_id, quantity, list_price, unit_price, discount_amount, amount)
    values (v_tenant, v_quote, v_fg, v_qty, v_list_price, v_price, greatest((v_qty * v_list_price) - v_line, 0), v_line);
  end loop;

  v_vat := round(v_subtotal * v_vat_rate / 100, 2);

  update quotes
     set subtotal = v_subtotal, list_value = v_list_value, discount_total = v_discount,
         vat_rate = v_vat_rate, vat_amount = v_vat, total = v_subtotal + v_vat
   where id = v_quote;

  return v_quote;
end $$;

create or replace function public.create_purchase_order(
  p_supplier uuid,
  p_lines    jsonb,          -- [{material_id, qty, unit_cost}]
  p_expected date default null,
  p_branch   uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid;
  v_po     uuid;
  v_line   jsonb;
  v_mat    uuid;
  v_qty    numeric;
  v_cost   numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('purchase_orders', 'Ordering stock before it arrives');
  v_branch := public.resolve_branch(p_branch);

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A purchase order needs at least one line.';
  end if;
  perform public.assert_same_tenant('suppliers', p_supplier);

  insert into purchase_orders(tenant_id, branch_id, supplier_id, purchase_date, doc_no, status, expected_date, ordered_at, created_by)
  values (v_tenant, v_branch, p_supplier, current_date, public.next_doc_no(v_tenant, 'PO'), 'ordered', p_expected, now(), auth.uid())
  returning id into v_po;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_mat  := (v_line->>'material_id')::uuid;
    v_qty  := (v_line->>'qty')::numeric;
    v_cost := (v_line->>'unit_cost')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every line needs a quantity above zero.'; end if;
    if v_cost is null or v_cost < 0 then raise exception 'Cost can''t be negative.'; end if;
    perform public.assert_same_tenant('materials', v_mat);

    insert into purchase_order_lines(tenant_id, purchase_order_id, material_id, qty_ordered, unit_cost)
    values (v_tenant, v_po, v_mat, v_qty, v_cost);
  end loop;

  return v_po;
end $$;

create or replace function public.create_delivery_note(
  p_sale         uuid,
  p_items        jsonb,        -- [{sale_item_id, qty}]
  p_driver_name  text default null,
  p_vehicle_no   text default null,
  p_destination  text default null,
  p_note         text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_so       record;
  v_delivery uuid;
  v_doc_no   text;
  v_item     jsonb;
  v_si       record;
  v_qty      numeric;
  v_already  numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('admin', 'sales') then
    raise exception 'Your role is not allowed to create a delivery note.' using errcode = 'insufficient_privilege';
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — deliveries are read-only until billing is sorted out.';
  end if;
  perform public.require_feature('deliveries', 'Delivery notes and waybills');

  select * into v_so from sales_orders where id = p_sale and tenant_id = v_tenant;
  if not found then raise exception 'Sale not found.'; end if;
  if v_so.voided then raise exception 'This sale has been voided.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A delivery note needs at least one item.';
  end if;

  v_doc_no := public.next_doc_no(v_tenant, 'DN');
  insert into deliveries (tenant_id, branch_id, sales_order_id, doc_no, driver_name, vehicle_no, destination, note, created_by)
  values (v_tenant, v_so.branch_id, p_sale, v_doc_no,
          nullif(trim(p_driver_name), ''), nullif(trim(p_vehicle_no), ''), nullif(trim(p_destination), ''), nullif(trim(p_note), ''),
          auth.uid())
  returning id into v_delivery;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_si from sale_items where id = (v_item->>'sale_item_id')::uuid and sales_order_id = p_sale and tenant_id = v_tenant;
    if not found then raise exception 'That line does not belong to this sale.'; end if;

    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every delivery line needs a quantity above zero.'; end if;

    select coalesce(sum(di.qty), 0) into v_already
      from delivery_items di join deliveries d on d.id = di.delivery_id
     where di.sale_item_id = v_si.id and d.status <> 'failed';
    if v_qty > (v_si.quantity - v_already) then
      raise exception 'Only % still to deliver on this line — % was sold, % already on a delivery note.',
        v_si.quantity - v_already, v_si.quantity, v_already;
    end if;

    insert into delivery_items (tenant_id, delivery_id, sale_item_id, qty) values (v_tenant, v_delivery, v_si.id, v_qty);
  end loop;

  return v_delivery;
end $$;

create or replace function public.reorder_suggestions(p_branch uuid default null)
returns table (
  product_kind   text,
  product_id     uuid,
  name           text,
  unit           text,
  branch_id      uuid,
  daily_usage    numeric,
  daily_stddev   numeric,
  on_hand        numeric,
  on_order       numeric,
  lead_time_days numeric,
  supplier_id    uuid,
  supplier_name  text,
  safety_stock   numeric,
  reorder_point  numeric,
  cover_days     int,
  suggested_qty  numeric,
  reason         text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_branch  uuid;
  v_z       numeric;
  v_cover   int;
  v_default_lead numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('admin', 'inventory') then
    raise exception 'Your role is not allowed to view reorder suggestions.' using errcode = 'insufficient_privilege';
  end if;
  perform public.require_feature('smart_reorder', 'Smart reorder suggestions');
  v_branch := public.resolve_branch(p_branch);

  select t.reorder_z, t.reorder_cover_days, t.reorder_default_lead_days
    into v_z, v_cover, v_default_lead
    from tenants t where t.id = v_tenant;

  return query
  with days as (
    select gs::date as d from generate_series(current_date - 89, current_date, interval '1 day') gs
  ),
  mats as (
    -- Qualified on purpose: this function's own OUT parameters are named
    -- name/unit/branch_id (its RETURNS TABLE list), which PL/pgSQL exposes
    -- as implicit variables in scope here — an unqualified "name" or
    -- "unit" column reference would be ambiguous against them.
    select materials.id, materials.name, materials.unit from materials where materials.tenant_id = v_tenant
  ),
  daily_use as (
    select m.id as material_id, d.d,
           coalesce(-sum(sm.quantity), 0) as used
      from mats m
      cross join days d
      left join stock_movements sm
        on sm.tenant_id = v_tenant and sm.branch_id = v_branch
       and sm.product_kind = 'material' and sm.product_id = m.id
       and sm.movement_type = 'PRODUCTION' and sm.quantity < 0
       and sm.created_at::date = d.d
     group by m.id, d.d
  ),
  stats as (
    select material_id,
           avg(used) filter (where d >= current_date - 29) as avg30,
           avg(used) as avg90,
           stddev_pop(used) as sd
      from daily_use
     group by material_id
  ),
  on_hand_calc as (
    -- Qualified for the same reason as mats above — branch_id is also one
    -- of this function's own OUT parameters.
    select purchase_items.material_id, sum(purchase_items.qty_remaining) as qty
      from purchase_items
     where purchase_items.tenant_id = v_tenant and purchase_items.branch_id = v_branch
     group by purchase_items.material_id
  ),
  on_order_calc as (
    select pol.material_id, sum(pol.qty_ordered - pol.qty_received) as qty
      from purchase_order_lines pol
      join purchase_orders po on po.id = pol.purchase_order_id
     where po.tenant_id = v_tenant and po.branch_id = v_branch and po.status in ('ordered', 'partial')
     group by pol.material_id
  ),
  -- Wherever the material's stock actually came from last — a quick
  -- purchase or a receipt against an order (6b) — is who to reorder from.
  last_supplier as (
    select distinct on (pi.material_id)
           pi.material_id, po.supplier_id, pi.cost_price
      from purchase_items pi
      join purchase_orders po on po.id = pi.purchase_order_id
     where pi.tenant_id = v_tenant
     order by pi.material_id, pi.created_at desc
  )
  select
    'material'::text,
    m.id,
    m.name,
    m.unit,
    v_branch,
    round(coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0), 3),
    round(coalesce(st.sd, 0), 3),
    coalesce(oh.qty, 0),
    coalesce(oo.qty, 0),
    coalesce(sup.lead_time_days, v_default_lead),
    ls.supplier_id,
    coalesce(nullif(trim(sup.company_store), ''), nullif(trim(coalesce(sup.first_name, '') || ' ' || coalesce(sup.last_name, '')), '')),
    round(v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric, 2),
    round(coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) * coalesce(sup.lead_time_days, v_default_lead)
          + v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric, 2),
    v_cover,
    greatest(0, ceil(
      coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) * (coalesce(sup.lead_time_days, v_default_lead) + v_cover)
      + v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric
      - coalesce(oh.qty, 0) - coalesce(oo.qty, 0)
    )),
    case
      when coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) <= 0 then 'No recent usage recorded — nothing suggested.'
      else format(
        'You use about %s %s a day. %s %s left ≈ %s days. %s takes %s days. Order %s %s to cover %s days.',
        round(coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0), 1), coalesce(m.unit, 'units'),
        coalesce(oh.qty, 0), coalesce(m.unit, 'units'),
        round(coalesce(oh.qty, 0) / nullif(0.6 * st.avg30 + 0.4 * st.avg90, 0), 1),
        coalesce(nullif(trim(sup.company_store), ''), nullif(trim(coalesce(sup.first_name, '') || ' ' || coalesce(sup.last_name, '')), ''), 'your supplier'),
        coalesce(sup.lead_time_days, v_default_lead),
        greatest(0, ceil(
          coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) * (coalesce(sup.lead_time_days, v_default_lead) + v_cover)
          + v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric
          - coalesce(oh.qty, 0) - coalesce(oo.qty, 0)
        )), coalesce(m.unit, 'units'), v_cover
      )
    end
    from mats m
    left join stats st on st.material_id = m.id
    left join on_hand_calc oh on oh.material_id = m.id
    left join on_order_calc oo on oo.material_id = m.id
    left join last_supplier ls on ls.material_id = m.id
    left join suppliers sup on sup.id = ls.supplier_id
   order by m.name;
end $$;


-- ------------------------------------------------------------
-- 5. Automatic payment confirmation — gated at the point a business
--    connects its own Paystack account (payments-connect Edge Function).
--    Once connected, a later downgrade doesn't retroactively break
--    existing pay links, matching the "nothing already created is
--    touched" rule above — see that function's own comment.
-- ------------------------------------------------------------
-- (No SQL change here — see supabase/functions/payments-connect/index.ts,
--  updated alongside this migration to call require_feature('auto_payments', ...)
--  via RPC right after confirming the caller is an admin.)
