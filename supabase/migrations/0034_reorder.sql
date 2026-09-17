-- ============================================================
-- StockFlow — Smart reorder suggestions for raw materials (Phase 7a)
--
-- reorder_suggestions() is plain SQL end to end, deliberately — the plan's
-- own words are "so the numbers can be checked." It returns one row per
-- material at the caller's branch: how much is used per day (a genuine
-- 90-day daily series, weighted 60/40 towards the last 30 days), how
-- variable that usage is (a real population standard deviation over that
-- same daily series, not an approximation), how long the material's last
-- supplier takes to deliver, and how much to order to cover lead time plus
-- a safety margin plus a chosen number of extra days of cover.
--
-- Scope: materials only. The plan's second half of this phase — a
-- "produce" suggestion for finished goods, checked against the BOM's
-- feasibility ("can make 140 of the 200 needed; short 20kg SLS") — needs
-- real recipe-feasibility logic this migration doesn't build. Documented
-- as deliberately deferred; see HANDOVER.md.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Settings the formula needs
-- ------------------------------------------------------------

alter table tenants add column if not exists reorder_z numeric(4,2) not null default 1.65;
  -- z for a ~95% service level by default (80% -> 0.84, 90% -> 1.28, 95% -> 1.65, 99% -> 2.33).
  -- The percent-to-z mapping is UI-only (src/lib/features.ts-style constant on the frontend);
  -- the database only ever stores and uses the raw z number.
alter table tenants add column if not exists reorder_cover_days int not null default 14;
alter table tenants add column if not exists reorder_default_lead_days int not null default 7;
  -- Used only for a material that's never completed a full order-to-receipt
  -- cycle (6b) and was never quick-purchased either, so suppliers.lead_time_days
  -- has nothing to learn from yet.

create index if not exists idx_sm_reorder on stock_movements (tenant_id, product_kind, movement_type, branch_id, product_id, created_at);


-- ------------------------------------------------------------
-- 2. reorder_suggestions(p_branch) — read-only, one row per material
-- ------------------------------------------------------------

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
-- 3. create_reorder_purchase_orders — turns suggestions into real,
--    ordinary purchase orders (6b's create_purchase_order), one per
--    supplier, grouping every suggested material that shares one.
-- ------------------------------------------------------------

create or replace function public.create_reorder_purchase_orders(p_material_ids uuid[] default null, p_branch uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_branch  uuid;
  v_created jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_group   record;
  v_po      uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('admin', 'inventory') then
    raise exception 'Your role is not allowed to create purchase orders.' using errcode = 'insufficient_privilege';
  end if;
  v_branch := public.resolve_branch(p_branch);

  create temporary table tmp_reorder on commit drop as
    select * from public.reorder_suggestions(v_branch)
     where suggested_qty > 0
       and (p_material_ids is null or product_id = any(p_material_ids));

  select coalesce(jsonb_agg(jsonb_build_object('material_id', product_id, 'name', name)), '[]'::jsonb)
    into v_skipped
    from tmp_reorder where supplier_id is null;

  for v_group in
    select supplier_id, max(lead_time_days) as lead_time_days,
           jsonb_agg(jsonb_build_object(
             'material_id', product_id, 'qty', suggested_qty,
             'unit_cost', coalesce((
               select pi.cost_price from purchase_items pi
                where pi.material_id = tmp_reorder.product_id and pi.tenant_id = v_tenant
                order by pi.created_at desc limit 1
             ), 0)
           )) as lines
      from tmp_reorder
     where supplier_id is not null
     group by supplier_id
  loop
    v_po := public.create_purchase_order(v_group.supplier_id, v_group.lines,
                                          current_date + v_group.lead_time_days::int, v_branch);
    v_created := v_created || jsonb_build_object('supplier_id', v_group.supplier_id, 'purchase_order_id', v_po);
  end loop;

  return jsonb_build_object('created', v_created, 'skipped', v_skipped);
end $$;
