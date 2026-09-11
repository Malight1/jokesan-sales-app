-- ============================================================
-- StockFlow — Role-shaped dashboard
--
-- The dashboard was one component shown to all four roles, with a single
-- line of difference (it hid the reminder card from `inventory`). So a
-- cashier signed in and saw the company's gross profit and total expenses.
--
-- It also fired nine queries on mount — the full sales list, the full
-- customer list and the whole expense ledger among them. Once those reads
-- were correctly paged instead of silently capped at 1,000 rows, that
-- became the *entire* history downloaded to the till before first paint.
--
-- This replaces all of it with one aggregate, computed here, shaped by who
-- is asking. A cashier physically cannot receive the P&L: it is never put
-- in the payload.
--
-- Run AFTER 0001–0017.
-- ============================================================

create or replace function public.dashboard_summary()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tenant uuid       := public.current_tenant_id();
  v_role   user_role  := public.current_role();
  v_uid    uuid       := auth.uid();
  v_today  date       := current_date;
  v_out    jsonb;
  v_common jsonb;
begin
  if v_tenant is null then
    raise exception 'No tenant context';
  end if;

  -- ---- Shared by every role: stock health and account state ----
  -- Everyone has Stock Alerts on their menu, and everyone should know when
  -- the account is about to stop working.
  select jsonb_build_object(
    'role', v_role,
    'account_live', public.tenant_is_live(),
    'low_goods_count', (
      select count(*) from finished_goods
       where tenant_id = v_tenant and qty_balance <= min_stock_level),
    'low_materials_count', (
      select count(*) from materials
       where tenant_id = v_tenant and qty_balance <= min_stock_level),
    'low_stock', (
      select coalesce(jsonb_agg(x order by x->>'name'), '[]'::jsonb) from (
        -- Each branch is parenthesised: an unparenthesised LIMIT binds to the
        -- whole UNION, which would have capped both lists at 10 combined.
        (select jsonb_build_object(
                  'kind', 'finished_good', 'name', name,
                  'qty', qty_balance, 'unit', unit, 'min', min_stock_level) as x
           from finished_goods
          where tenant_id = v_tenant and qty_balance <= min_stock_level
          order by qty_balance
          limit 10)
        union all
        (select jsonb_build_object(
                  'kind', 'material', 'name', name,
                  'qty', qty_balance, 'unit', unit, 'min', min_stock_level)
           from materials
          where tenant_id = v_tenant and qty_balance <= min_stock_level
          order by qty_balance
          limit 10)
      ) s)
  ) into v_common;

  -- ============================================================
  -- CASHIER — today's till, and only their own numbers.
  -- No margin, no expenses, no company totals.
  -- ============================================================
  if v_role = 'sales' then
    select v_common || jsonb_build_object(
      'today_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today), 0),
      'today_count', (
        select count(*) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today),
      'my_today_total', coalesce((
        select sum(total_amount) from sales_orders
         where tenant_id = v_tenant and not voided
           and transaction_date = v_today and created_by = v_uid), 0),
      'my_today_count', (
        select count(*) from sales_orders
         where tenant_id = v_tenant and not voided
           and transaction_date = v_today and created_by = v_uid),
      'today_unpaid', coalesce((
        select sum(balance) from sales_orders
         where tenant_id = v_tenant and not voided and transaction_date = v_today), 0),
      'my_recent', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', so.id, 'date', so.transaction_date,
                   'total', so.total_amount, 'balance', so.balance,
                   'status', so.payment_status,
                   'customer', coalesce(
                     nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), ''),
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
           where tenant_id = v_tenant and not voided
             and transaction_date >= v_today - 6
           group by transaction_date) s)
    ) into v_out;

  -- ============================================================
  -- STOREKEEPER — stock, production, purchases. No money at all.
  -- ============================================================
  elsif v_role = 'inventory' then
    select v_common || jsonb_build_object(
      'out_of_stock_count', (
        select count(*) from (
          (select 1 from finished_goods where tenant_id = v_tenant and qty_balance <= 0)
          union all
          (select 1 from materials      where tenant_id = v_tenant and qty_balance <= 0)) s),
      'production_this_month', coalesce((
        select sum(qty_produced) from production_runs
         where tenant_id = v_tenant and not voided
           and production_date >= date_trunc('month', v_today)), 0),
      'production_runs_this_month', (
        select count(*) from production_runs
         where tenant_id = v_tenant and not voided
           and production_date >= date_trunc('month', v_today)),
      'open_purchases', (
        select count(*) from purchase_orders
         where tenant_id = v_tenant and not voided and balance > 0),
      'recent_production', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', pr.id, 'date', pr.production_date,
                   'product', fg.name, 'qty', pr.qty_produced) as x
            from production_runs pr
            join finished_goods fg on fg.id = pr.finished_good_id
           where pr.tenant_id = v_tenant and not pr.voided
           order by pr.created_at desc limit 6) s),
      'recent_movements', (
        select coalesce(jsonb_agg(x), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', sm.id, 'type', sm.movement_type,
                   'qty', sm.quantity, 'kind', sm.product_kind,
                   'at', sm.created_at) as x
            from stock_movements sm
           where sm.tenant_id = v_tenant
           order by sm.created_at desc limit 8) s)
    ) into v_out;

  -- ============================================================
  -- OWNER / ACCOUNTS — the full financial picture.
  -- ============================================================
  else
    select v_common || jsonb_build_object(
      'total_sales',    coalesce((select sum(total_amount) from sales_orders where tenant_id = v_tenant and not voided), 0),
      'sales_count',    (select count(*)                   from sales_orders where tenant_id = v_tenant and not voided),
      'gross_profit',   coalesce((select sum(gross_profit) from sales_orders where tenant_id = v_tenant and not voided), 0),
      'outstanding',    coalesce((select sum(balance)      from sales_orders where tenant_id = v_tenant and not voided), 0),
      'total_purchases',coalesce((select sum(total_amount) from purchase_orders where tenant_id = v_tenant and not voided), 0),
      'purchase_count', (select count(*)                   from purchase_orders where tenant_id = v_tenant and not voided),
      'creditors',      coalesce((select sum(balance)      from purchase_orders where tenant_id = v_tenant and not voided), 0),
      'total_expenses', coalesce((select sum(amount)       from expenses where tenant_id = v_tenant), 0),
      'expense_count',  (select count(*)                   from expenses where tenant_id = v_tenant),
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
                   'customer', coalesce(
                     nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), ''),
                     c.company_store, 'Walk-in')) as x
            from sales_orders so
            left join customers c on c.id = so.customer_id
           where so.tenant_id = v_tenant and not so.voided
           order by so.created_at desc limit 6) s),
      -- Debtors overdue 14+ days and not nudged in the last 3.
      'reminders', (
        select coalesce(jsonb_agg(x order by (x->>'balance')::numeric desc), '[]'::jsonb) from (
          select jsonb_build_object(
                   'id', c.id,
                   'name', coalesce(
                     nullif(trim(coalesce(c.first_name,'') || ' ' || coalesce(c.last_name,'')), ''),
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
           -- without an ORDER BY the LIMIT would return an arbitrary eight,
           -- so the biggest debts could silently never surface
           order by sum(so.balance) desc
           limit 8) s)
    ) into v_out;
  end if;

  return v_out;
end $$;

grant execute on function public.dashboard_summary() to authenticated;
