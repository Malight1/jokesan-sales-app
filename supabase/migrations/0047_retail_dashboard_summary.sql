-- ============================================================
-- StockFlow — dashboard_summary() gets a retail branch.
--
-- A retail owner asks a different question than a manufacturer: today's
-- takings first (daily cadence), not month-to-date. This adds the same
-- daily-cadence fields the cashier branch already computes — today_total,
-- yesterday_total, today_unpaid, week_trend — but at TENANT scope rather
-- than my_branch_id() scope (an owner wants the whole business's takings,
-- not just their own branch), plus the two new retail_stock_value() /
-- retail_movers() figures from 0046. Purely additive: every existing
-- field for every role is untouched, this only adds keys to the
-- admin/accounts ("owner") response, and only for a retail tenant.
--
-- IMPORTANT: dashboard_summary() has been redefined four times (0018,
-- 0020, 0023, 0024). This migration is based on 0024's body — the actual
-- current definition. If it is ever touched again, rebase on the
-- CURRENT function body (pg_get_functiondef), not on any one migration
-- file — the same rule that already applied to handle_new_user() twice
-- in this project.
-- Run AFTER 0001–0046.
-- ============================================================

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
  v_btype  text;
  v_out    jsonb;
  v_common jsonb;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.my_branch_id();
  select type = 'multi_branch', business_type into v_multi, v_btype from tenants where id = v_tenant;

  select jsonb_build_object(
    'role',          v_role,
    'business_type', v_btype,
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

  if v_role = 'sales' then
    select v_common || jsonb_build_object(
      'today_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today), 0)
        - coalesce((
        select sum(total) from sale_returns
         where tenant_id = v_tenant and branch_id = v_branch and not voided and return_date = v_today), 0),
      'today_count', (
        select count(*) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today),
      'my_today_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today and created_by = v_uid), 0)
        - coalesce((
        select sum(sr.total) from sale_returns sr join sales_orders so on so.id = sr.sales_order_id
         where sr.tenant_id = v_tenant and not sr.voided and sr.return_date = v_today and so.created_by = v_uid), 0),
      'my_today_count', (
        select count(*) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today and created_by = v_uid),
      'today_unpaid', coalesce((
        select sum(balance) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today), 0),
      'yesterday_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and branch_id = v_branch and not voided and transaction_date = v_today - 1), 0)
        - coalesce((
        select sum(total) from sale_returns
         where tenant_id = v_tenant and branch_id = v_branch and not voided and return_date = v_today - 1), 0),
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

  elsif v_role = 'inventory' then
    select v_common || jsonb_build_object(
      'out_of_stock_count', (
        select count(*) from public.stock_levels(v_branch) s where s.qty <= 0),
      'stock_items', (
        select count(*) from public.stock_levels(v_branch) s),
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
                                    'qty', sm.quantity, 'kind', sm.product_kind, 'at', sm.created_at,
                                    'name', coalesce(
                                      (select m.name from materials m where m.id = sm.product_id),
                                      (select g.name from finished_goods g where g.id = sm.product_id))) as x
            from stock_movements sm
           where sm.tenant_id = v_tenant and sm.branch_id = v_branch
           order by sm.created_at desc limit 8) s)
    ) into v_out;

  else
    select v_common || jsonb_build_object(
      'total_sales',     coalesce((select sum(total_amount - returned_total) from sales_orders where tenant_id = v_tenant and not voided), 0),
      'sales_count',     (select count(*)                   from sales_orders    where tenant_id = v_tenant and not voided),
      'gross_profit',    coalesce((select sum(gross_profit - returned_profit) from sales_orders where tenant_id = v_tenant and not voided), 0),
      'outstanding',     coalesce((select sum(balance)      from sales_orders    where tenant_id = v_tenant and not voided), 0),
      'total_purchases', coalesce((select sum(total_amount - returned_total) from purchase_orders where tenant_id = v_tenant and not voided), 0),
      'purchase_count',  (select count(*)                   from purchase_orders where tenant_id = v_tenant and not voided),
      'creditors',       coalesce((select sum(balance)      from purchase_orders where tenant_id = v_tenant and not voided and balance > 0), 0),
      'total_expenses',  coalesce((select sum(amount)       from expenses        where tenant_id = v_tenant), 0),
      'expense_count',   (select count(*)                   from expenses        where tenant_id = v_tenant),
      'month_sales',       coalesce((select sum(total_amount) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr where sr.tenant_id = v_tenant and not sr.voided
                                      and sr.return_date >= date_trunc('month', v_today)), 0),
      'month_sales_count', (select count(*) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today)),
      'month_profit',      coalesce((select sum(gross_profit) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.subtotal - sr.cogs_reversed) from sale_returns sr where sr.tenant_id = v_tenant and not sr.voided
                                      and sr.return_date >= date_trunc('month', v_today)), 0),
      'month_expenses',    coalesce((select sum(amount) from expenses where tenant_id = v_tenant
                                      and expense_date >= date_trunc('month', v_today)), 0),
      'last_month_sales',  coalesce((select sum(total_amount) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today) - interval '1 month'
                                      and transaction_date <= (v_today - interval '1 month')::date), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr where sr.tenant_id = v_tenant and not sr.voided
                                      and sr.return_date >= date_trunc('month', v_today) - interval '1 month'
                                      and sr.return_date <= (v_today - interval '1 month')::date), 0),
      'last_month_profit', coalesce((select sum(gross_profit) from sales_orders where tenant_id = v_tenant and not voided
                                      and transaction_date >= date_trunc('month', v_today) - interval '1 month'
                                      and transaction_date <= (v_today - interval '1 month')::date), 0)
                          - coalesce((select sum(sr.subtotal - sr.cogs_reversed) from sale_returns sr where sr.tenant_id = v_tenant and not sr.voided
                                      and sr.return_date >= date_trunc('month', v_today) - interval '1 month'
                                      and sr.return_date <= (v_today - interval '1 month')::date), 0),
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
      'by_branch', (
        select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', b.id,
                   'name', b.name,
                   'today', coalesce((select sum(so.total_amount) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date = v_today), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr
                                       where sr.tenant_id = v_tenant and sr.branch_id = b.id and not sr.voided
                                         and sr.return_date = v_today), 0),
                   'month', coalesce((select sum(so.total_amount) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.total) from sale_returns sr
                                       where sr.tenant_id = v_tenant and sr.branch_id = b.id and not sr.voided
                                         and sr.return_date >= date_trunc('month', v_today)), 0),
                   'month_profit', coalesce((select sum(so.gross_profit) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided
                                         and so.transaction_date >= date_trunc('month', v_today)), 0)
                          - coalesce((select sum(sr.subtotal - sr.cogs_reversed) from sale_returns sr
                                       where sr.tenant_id = v_tenant and sr.branch_id = b.id and not sr.voided
                                         and sr.return_date >= date_trunc('month', v_today)), 0),
                   'outstanding', coalesce((select sum(so.balance) from sales_orders so
                                       where so.tenant_id = v_tenant and so.branch_id = b.id and not so.voided), 0),
                   'low_stock', (select count(*) from public.stock_levels(b.id) s where s.qty <= s.min_level)
                 ) as x
            from branches b
           where b.tenant_id = v_tenant and b.is_active) s)
    ) into v_out;

    -- Retail: the owner asks "what did I take today", not "what did I
    -- take this month" — the same daily-cadence fields the cashier
    -- branch above already computes, but at TENANT scope (every branch
    -- combined), plus the two retail_stock_value()/retail_movers()
    -- figures from 0046. Additive only — every field above still exists.
    if v_btype = 'retail' then
      v_out := v_out || jsonb_build_object(
        'today_total', coalesce((
          select sum(total_amount) from sales_orders
           where tenant_id = v_tenant and not voided and transaction_date = v_today), 0)
          - coalesce((
          select sum(total) from sale_returns
           where tenant_id = v_tenant and not voided and return_date = v_today), 0),
        'yesterday_total', coalesce((
          select sum(total_amount) from sales_orders
           where tenant_id = v_tenant and not voided and transaction_date = v_today - 1), 0)
          - coalesce((
          select sum(total) from sale_returns
           where tenant_id = v_tenant and not voided and return_date = v_today - 1), 0),
        'today_unpaid', coalesce((
          select sum(balance) from sales_orders
           where tenant_id = v_tenant and not voided and transaction_date = v_today), 0),
        'week_trend', (
          select coalesce(jsonb_agg(x order by x->>'day'), '[]'::jsonb) from (
            select jsonb_build_object('day', transaction_date::text, 'total', sum(total_amount)) as x
              from sales_orders
             where tenant_id = v_tenant and not voided and transaction_date >= v_today - 6
             group by transaction_date) s),
        'stock_value', public.retail_stock_value(),
        'movers', public.retail_movers(30)
      );
    end if;
  end if;

  return v_out;
end $$;
