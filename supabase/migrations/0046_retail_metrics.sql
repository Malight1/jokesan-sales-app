-- ============================================================
-- StockFlow — Retail dashboard metrics: cash tied up in stock (at
-- cost), fast movers, and dead stock. None of this existed before —
-- Reports.tsx's stock-value figure is selling_price * qty_balance
-- (retail price, not cost) computed client-side, and reorder_suggestions
-- is materials/PRODUCTION-only and feature-gated.
--
-- Modelled directly on two existing house patterns rather than
-- inventing a new one:
--   - Money gating: expiry_overview() (0022) returns NULL (not 0) for
--     money fields when the caller isn't accounts/admin, via
--     `case when v_money then <expr> end`, so the frontend can tell
--     "no access" from "genuinely zero" instead of collapsing them.
--   - The daily-usage series: reorder_suggestions() (0037) — a
--     generate_series of days, joined to stock_movements — but here
--     over SALE movements on finished_good, not PRODUCTION on material.
-- Run AFTER 0001–0045.
-- ============================================================

create or replace function public.retail_stock_value(p_branch uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_money  boolean := public.has_role('accounts');
  v_scope  uuid;
  v_out    jsonb;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_scope := case when v_money then p_branch else public.my_branch_id() end;

  select jsonb_build_object(
    'value_at_cost', case when v_money then coalesce(round(sum(fb.qty_remaining * fb.unit_cost), 2), 0) end,
    'units_on_hand', coalesce(sum(fb.qty_remaining), 0),
    'product_count', count(distinct fb.finished_good_id) filter (where fb.qty_remaining > 0)
  ) into v_out
  from fg_batches fb
  where fb.tenant_id = v_tenant and fb.qty_remaining > 0
    and (v_scope is null or fb.branch_id = v_scope);

  return v_out;
end $$;

create or replace function public.retail_movers(p_days int default 30, p_branch uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid;
  v_days   int := greatest(coalesce(p_days, 30), 1);
  v_out    jsonb;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.resolve_branch(p_branch);

  with days as (
    select gs::date as d from generate_series(current_date - (v_days - 1), current_date, interval '1 day') gs
  ),
  prods as (
    -- Qualified on purpose, same reason as reorder_suggestions (0037):
    -- this function's OUT shape isn't a RETURNS TABLE here, but "name"
    -- would still be ambiguous against jsonb_build_object keys below if
    -- left bare — keep it qualified for the same clarity.
    select finished_goods.id, finished_goods.name, finished_goods.unit
      from finished_goods where finished_goods.tenant_id = v_tenant
  ),
  daily_sales as (
    select p.id as product_id, d.d,
           coalesce(-sum(sm.quantity), 0) as sold
      from prods p
      cross join days d
      left join stock_movements sm
        on sm.tenant_id = v_tenant and sm.branch_id = v_branch
       and sm.product_kind = 'finished_good' and sm.product_id = p.id
       and sm.movement_type = 'SALE' and sm.quantity < 0
       and sm.created_at::date = d.d
     group by p.id, d.d
  ),
  totals as (
    select product_id, sum(sold) as total_sold, max(d) filter (where sold > 0) as last_sale_date
      from daily_sales group by product_id
  ),
  on_hand as (
    select fb.finished_good_id as product_id, sum(fb.qty_remaining) as qty
      from fg_batches fb
     where fb.tenant_id = v_tenant and fb.branch_id = v_branch
     group by fb.finished_good_id
  ),
  combined as (
    select p.id, p.name, p.unit,
           coalesce(t.total_sold, 0) as total_sold,
           coalesce(o.qty, 0) as on_hand,
           t.last_sale_date
      from prods p
      left join totals t on t.product_id = p.id
      left join on_hand o on o.product_id = p.id
  )
  select jsonb_build_object(
    'period_days', v_days,
    'fast_movers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', x.id, 'name', x.name, 'unit', x.unit,
               'qty_sold', x.total_sold, 'on_hand', x.on_hand,
               'days_of_cover', case when x.total_sold > 0 then round(x.on_hand / (x.total_sold::numeric / v_days), 1) end
             ) order by x.total_sold desc)
        from (select * from combined where total_sold > 0 order by total_sold desc limit 10) x
    ), '[]'::jsonb),
    'dead_stock', coalesce((
      select jsonb_agg(jsonb_build_object(
               'product_id', x.id, 'name', x.name, 'unit', x.unit, 'on_hand', x.on_hand,
               'days_since_sale', case when x.last_sale_date is null then null else (current_date - x.last_sale_date) end
             ) order by x.on_hand desc)
        from (select * from combined where on_hand > 0 and total_sold = 0 order by on_hand desc limit 10) x
    ), '[]'::jsonb)
  ) into v_out;

  return v_out;
end $$;

grant execute on function public.retail_stock_value(uuid)    to authenticated;
grant execute on function public.retail_movers(int, uuid)    to authenticated;
