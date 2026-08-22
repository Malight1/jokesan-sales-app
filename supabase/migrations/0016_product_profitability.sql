-- ============================================================
-- StockFlow — Product profitability report
--
-- Margin per finished good, computed from the FIFO layers the engine
-- actually consumed (sales_consumption.unit_cost), not from a guessed
-- average. This is the one report that shows what the costing engine is
-- FOR, so it has to read the real cost rows.
--
-- Aggregated server-side on purpose: sales_consumption is the highest-volume
-- table in the schema, and pulling it into the browser to group it would hit
-- the same PostgREST row cap that was silently truncating the other reports.
--
-- Voided sales are excluded — void_sale restores stock but deliberately
-- leaves its consumption rows in place for the audit trail, so they must be
-- filtered out here or every voided sale would still count as margin.
--
-- Output column names are deliberately distinct from every column in the
-- joined tables (sales_orders already has cogs / gross_profit), so the
-- planner can't hit an ambiguous reference.
--
-- Run AFTER 0001–0015.
-- ============================================================

create or replace function public.report_product_profitability(
  p_from date default null,
  p_to   date default null
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
language sql
stable
security definer
set search_path = public
as $$
  select
    sc.finished_good_id,
    fg.name,
    sum(sc.qty),
    sum(sc.qty * sc.selling_price),
    sum(sc.qty * sc.unit_cost),
    sum(sc.qty * (sc.selling_price - sc.unit_cost)),
    case
      when sum(sc.qty * sc.selling_price) > 0
        then round(
          100 * sum(sc.qty * (sc.selling_price - sc.unit_cost))
              / sum(sc.qty * sc.selling_price), 2)
      else 0
    end
  from sales_consumption sc
  join sale_items   si on si.id = sc.sale_item_id
  join sales_orders so on so.id = si.sales_order_id
  join finished_goods fg on fg.id = sc.finished_good_id
  where sc.tenant_id = public.current_tenant_id()
    and so.voided = false
    and (p_from is null or so.transaction_date >= p_from)
    and (p_to   is null or so.transaction_date <= p_to)
  group by sc.finished_good_id, fg.name
  order by sum(sc.qty * (sc.selling_price - sc.unit_cost)) desc;
$$;

grant execute on function public.report_product_profitability(date, date) to authenticated;
