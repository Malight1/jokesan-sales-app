-- ============================================================
-- StockFlow — per-product stock value at cost, on stock_levels().
--
-- Products.tsx and Inventory.tsx have shown "Stock Value" as
-- selling_price * qty since they existed, which is retail price, not
-- money tied up. retail_stock_value() (0046) already gets this right at
-- tenant level for the dashboard; this brings the same figure to the
-- per-product table, using the same money gate as expiry_overview()
-- (0022) and retail_stock_value(): null (not 0) for anyone who isn't
-- accounts/admin, so the frontend can tell "no access" from "genuinely
-- nothing on the shelf".
--
-- Cost lives in two different places depending on product kind — this is
-- exactly why stock_levels() already branches its `layers` CTE by kind:
--   - a material's layers are its own purchase_items rows (materials have
--     no separate batch table; qty_remaining/cost_price live right there)
--   - a finished good's layers are its fg_batches rows (qty_remaining/
--     unit_cost), whether the batch came from production or a purchase
--     (0045) — origin is irrelevant to what it's worth sitting on the shelf
--
-- Run AFTER 0001–0047.
-- ============================================================

-- Return type changes, so drop first (same reason 0022 did the same thing
-- to 0020's version). dashboard_summary and everything else that reads
-- stock_levels() only touches qty/min_level/sellable_qty and keeps working.
drop function if exists public.stock_levels(uuid);

create or replace function public.stock_levels(p_branch uuid default null)
returns table (
  branch_id      uuid,
  branch_name    text,
  product_kind   text,
  product_id     uuid,
  name           text,
  unit           text,
  qty            numeric,
  min_level      numeric,
  sellable_qty   numeric,
  value_at_cost  numeric
)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
declare
  v_tenant uuid := public.current_tenant_id();
  v_def    uuid;
  v_allow  boolean;
  v_money  boolean := public.has_role('accounts');
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
           sum(pi.qty_remaining) as q, sum(pi.qty_remaining) as s,
           sum(pi.qty_remaining * pi.cost_price) as v
      from purchase_items pi where pi.tenant_id = v_tenant
     group by pi.branch_id, pi.material_id
    union all
    select fb.branch_id, 'finished_good'::text, fb.finished_good_id,
           sum(fb.qty_remaining),
           coalesce(sum(fb.qty_remaining) filter (
             where public.batch_is_sellable(fb.status, fb.expiry_date, current_date, coalesce(v_allow, false))), 0),
           sum(fb.qty_remaining * fb.unit_cost)
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
         coalesce(l.q, 0)::numeric, p.mn::numeric, coalesce(l.s, 0)::numeric,
         case when v_money then coalesce(round(l.v, 2), 0) end
    from br
   cross join products p
    left join layers l on l.bid = br.id and l.k = p.k and l.pid = p.pid
   where l.pid is not null or br.id = v_def
   order by br.name, p.k, p.nm;
end $$;

grant execute on function public.stock_levels(uuid) to authenticated;
