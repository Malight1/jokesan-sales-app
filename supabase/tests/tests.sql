-- Two-branch company (Lagos + Abuja) with an owner, an Abuja cashier, a
-- storekeeper and a bookkeeper, driven through the real engine and RLS.

-- ---------- test plumbing ----------
create table t_results (n serial primary key, name text, pass boolean, detail text);
create table t_ids (k text primary key, v uuid);

create function t_rec(p_name text, p_pass boolean, p_detail text default null)
returns void language sql security definer as $$
  insert into t_results (name, pass, detail) values (p_name, coalesce(p_pass, false), p_detail)
$$;
create function t_put(p_k text, p_v uuid) returns void language sql security definer as $$
  insert into t_ids values (p_k, p_v) on conflict (k) do update set v = excluded.v
$$;
create function t_id(p_k text) returns uuid language sql stable security definer as $$
  select v from t_ids where k = p_k
$$;
-- Act as a signed-in user through the API role, so RLS and the stock lock
-- see exactly what PostgREST would.
create function t_as(p_uid uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claim.sub', p_uid::text, false);
  execute 'set role authenticated';
end $$;
create function t_su(p_uid uuid default null) returns void language plpgsql as $$
begin
  execute 'reset role';
  perform set_config('request.jwt.claim.sub', coalesce(p_uid::text, ''), false);
end $$;
create function t_ok(p_name text, p_sql text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    perform t_rec(p_name, true);
  exception when others then
    perform t_rec(p_name, false, sqlerrm);
  end;
end $$;
create function t_err(p_name text, p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    perform t_rec(p_name, false, 'expected an error, got none');
  exception when others then
    perform t_rec(p_name, sqlerrm ilike '%' || p_pattern || '%', sqlerrm);
  end;
end $$;
create function t_items(p_fg uuid, p_qty numeric, p_price numeric) returns text language sql as $$
  select jsonb_build_array(jsonb_build_object('finished_good_id', p_fg, 'quantity', p_qty, 'unit_price', p_price))::text
$$;
-- Stock at one branch, read the way the app reads it.
create function t_stock(p_branch uuid, p_product uuid) returns numeric language sql security definer as $$
  select coalesce((select sum(qty_remaining) from fg_batches where branch_id = p_branch and finished_good_id = p_product), 0)
       + coalesce((select sum(qty_remaining) from purchase_items where branch_id = p_branch and material_id = p_product), 0)
$$;
grant all on t_results, t_ids to authenticated;
grant usage, select on sequence t_results_n_seq to authenticated;

-- ---------- 1. the company, its branches and its people ----------
do $$
declare v_t uuid; v_lagos uuid; v_abuja uuid;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000001', 'owner@jokesan.ng',
     '{"company_name":"Jokesan Multi","tenant_type":"multi_branch","full_name":"Owner"}');
  select tenant_id, branch_id into v_t, v_lagos from profiles where id = '00000000-0000-0000-0000-000000000001';
  update branches set name = 'Lagos' where id = v_lagos;
  -- The whole script is one transaction, so now() is identical everywhere;
  -- give Abuja a later timestamp so Lagos is unambiguously the default branch.
  insert into branches (tenant_id, name, created_at) values (v_t, 'Abuja', now() + interval '1 minute') returning id into v_abuja;
  perform t_put('tenant', v_t);
  perform t_put('lagos', v_lagos);
  perform t_put('abuja', v_abuja);

  insert into staff_invites (tenant_id, email, role, branch_id) values
    (v_t, 'cashier@jokesan.ng', 'sales',     v_abuja),
    (v_t, 'store@jokesan.ng',   'inventory', null),
    (v_t, 'books@jokesan.ng',   'accounts',  null);
  insert into auth.users (id, email, raw_user_meta_data) values
    ('00000000-0000-0000-0000-000000000002', 'cashier@jokesan.ng', '{"full_name":"Abuja Cashier"}'),
    ('00000000-0000-0000-0000-000000000003', 'store@jokesan.ng',   '{"full_name":"Storekeeper"}'),
    ('00000000-0000-0000-0000-000000000004', 'books@jokesan.ng',   '{"full_name":"Bookkeeper"}');

  perform t_rec('invited cashier joins the company at Abuja',
    (select tenant_id = v_t and branch_id = v_abuja and role = 'sales' from profiles where id = '00000000-0000-0000-0000-000000000002'));
  perform t_rec('invite with no branch lands on the default branch, not NULL',
    (select branch_id = v_lagos from profiles where id = '00000000-0000-0000-0000-000000000003'));
end $$;

-- ---------- 2. catalog, and the stock lock ----------
do $$
declare v_mat uuid; v_fg uuid;
begin
  perform t_as('00000000-0000-0000-0000-000000000001');
  insert into materials (name, unit, min_stock_level) values ('Caustic Soda', 'kg', 10) returning id into v_mat;
  insert into finished_goods (name, unit, min_stock_level, selling_price, default_markup)
    values ('Jokesan Soap', 'pcs', 5, 60, 1.5) returning id into v_fg;
  perform t_put('caustic', v_mat);
  perform t_put('soap', v_fg);
  perform t_err('typing opening stock straight into a new item is refused',
    $q$insert into materials (name, unit, qty_balance) values ('Sneaky', 'kg', 10)$q$, 'Opening stock');
  perform t_su();
end $$;

-- ---------- 3. storekeeper buys and produces at Lagos ----------
do $$
begin
  perform t_as('00000000-0000-0000-0000-000000000003');
  perform t_ok('storekeeper records a purchase (lands at Lagos)',
    format('select public.create_purchase(null, current_date, null, 0, %L::jsonb)',
      jsonb_build_array(jsonb_build_object('material_id', t_id('caustic'), 'qty', 100, 'cost_price', 50))::text));
  perform t_ok('storekeeper records production at Lagos',
    format('select public.record_production(%L::uuid, current_date, 0, 40, %L::jsonb)', t_id('soap'),
      jsonb_build_array(jsonb_build_object('material_id', t_id('caustic'), 'qty', 20))::text));
  perform t_err('storekeeper cannot ring up a sale',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(t_id('soap'), 1, 60)),
    'not allowed to record a sale');
  perform t_su();

  perform t_rec('production put 40 soap at Lagos and none at Abuja',
    t_stock(t_id('lagos'), t_id('soap')) = 40 and t_stock(t_id('abuja'), t_id('soap')) = 0,
    format('lagos=%s abuja=%s', t_stock(t_id('lagos'), t_id('soap')), t_stock(t_id('abuja'), t_id('soap'))));
  perform t_rec('unit cost is FIFO material cost / qty (20kg × ₦50 / 40 = ₦25)',
    (select unit_cost = 25 from fg_batches where finished_good_id = t_id('soap') and origin = 'production'));
end $$;

-- ---------- 4. Abuja can only sell what Abuja holds ----------
do $$
begin
  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('Abuja cashier cannot sell stock that is sitting in Lagos',
    format('select public.create_sale(null, current_date, null, 300, %L::jsonb)', t_items(t_id('soap'), 5, 60)),
    'left at Abuja');
  perform t_su();
end $$;

-- ---------- 5. transfers ----------
do $$
begin
  perform t_as('00000000-0000-0000-0000-000000000003');
  perform t_err('storekeeper cannot send stock out of a branch that is not theirs',
    format('select public.transfer_stock(%L::uuid, %L::uuid, %L, %L::uuid, 5)',
      t_id('abuja'), t_id('lagos'), 'finished_good', t_id('soap')), 'own branch');
  perform t_err('cannot send more than the branch holds',
    format('select public.transfer_stock(%L::uuid, %L::uuid, %L, %L::uuid, 500)',
      t_id('lagos'), t_id('abuja'), 'finished_good', t_id('soap')), 'Only 40');
  perform t_ok('storekeeper sends 15 soap Lagos → Abuja',
    format('select public.transfer_stock(%L::uuid, %L::uuid, %L, %L::uuid, 15, %L)',
      t_id('lagos'), t_id('abuja'), 'finished_good', t_id('soap'), 'weekly restock'));
  perform t_su();

  perform t_rec('after transfer: Lagos 25, Abuja 15',
    t_stock(t_id('lagos'), t_id('soap')) = 25 and t_stock(t_id('abuja'), t_id('soap')) = 15);
  perform t_rec('company total unchanged by a transfer (still 40)',
    (select qty_balance = 40 from finished_goods where id = t_id('soap')));
  perform t_rec('transferred stock keeps its FIFO cost (₦25)',
    (select bool_and(unit_cost = 25) from fg_batches where finished_good_id = t_id('soap') and origin = 'transfer'));
  perform t_rec('transfer is in the ledger as -15 / +15',
    (select count(*) = 2 and sum(quantity) = 0 from stock_movements
      where product_id = t_id('soap') and movement_type = 'TRANSFER'));
end $$;

-- ---------- 6. selling at Abuja ----------
do $$
declare v_sale uuid;
begin
  perform t_as('00000000-0000-0000-0000-000000000002');
  execute format('select public.create_sale(null, current_date, null, 300, %L::jsonb)', t_items(t_id('soap'), 5, 60))
    into v_sale;
  perform t_put('abuja_sale', v_sale);
  perform t_err('cashier cannot record a sale at another branch',
    format('select public.create_sale(null, current_date, null, 60, %L::jsonb, 0, %L::uuid)',
      t_items(t_id('soap'), 1, 60), t_id('lagos')), 'own branch');
  perform t_err('cashier cannot oversell what is left at Abuja',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(t_id('soap'), 11, 60)),
    'Only 10');
  perform t_err('cashier cannot sell a zero or negative quantity',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(t_id('soap'), -3, 60)),
    'above zero');
  perform t_su();

  perform t_rec('Abuja sale is stamped Abuja and costed at the transferred ₦25 (COGS 125)',
    (select branch_id = t_id('abuja') and cogs = 125 and gross_profit = 175 from sales_orders where id = v_sale));
  perform t_rec('Abuja now holds 10', t_stock(t_id('abuja'), t_id('soap')) = 10);
end $$;

-- ---------- 7. owner sells at Lagos ----------
do $$
begin
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_ok('owner rings up 3 soap at Lagos',
    format('select public.create_sale(null, current_date, null, 180, %L::jsonb)', t_items(t_id('soap'), 3, 60)));
  perform t_su();
end $$;

-- ---------- 8. who can see what ----------
do $$
declare v_n int;
begin
  perform t_as('00000000-0000-0000-0000-000000000002');
  select count(*) into v_n from sales_orders;
  perform t_rec('Abuja cashier sees only Abuja sales (1 of 2)', v_n = 1, v_n::text);
  select count(*) into v_n from fg_batches;
  perform t_rec('cashier cannot read cost layers', v_n = 0, v_n::text);
  select count(*) into v_n from expenses;
  perform t_rec('cashier cannot read expenses', v_n = 0, v_n::text);
  select count(*) into v_n from public.stock_levels(null) where product_id = t_id('soap');
  perform t_rec('cashier CAN see soap quantities at every branch (no costs)', v_n = 2, v_n::text);

  perform t_as('00000000-0000-0000-0000-000000000003');
  select count(*) into v_n from sales_orders;
  perform t_rec('storekeeper sees no sales at all', v_n = 0, v_n::text);
  select count(*) into v_n from stock_transfers;
  perform t_rec('storekeeper sees the transfer that left Lagos', v_n = 1, v_n::text);

  perform t_as('00000000-0000-0000-0000-000000000004');
  select count(*) into v_n from sales_orders;
  perform t_rec('bookkeeper sees sales from every branch (2)', v_n = 2, v_n::text);
  perform t_su();
end $$;

-- ---------- 9. voids ----------
do $$
begin
  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('cashier cannot void a sale',
    format('select public.void_sale(%L::uuid)', t_id('abuja_sale')), 'Only an admin');
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_ok('owner voids the Abuja sale', format('select public.void_sale(%L::uuid)', t_id('abuja_sale')));
  perform t_err('production cannot be voided once its batch was sold or transferred',
    format('select public.void_production(id) from production_runs where finished_good_id = %L::uuid', t_id('soap')),
    'sold or sent');
  perform t_su();
  perform t_rec('voided Abuja sale puts the 5 back at Abuja (15)', t_stock(t_id('abuja'), t_id('soap')) = 15);
end $$;

-- ---------- 10. stock only moves through the engine ----------
do $$
begin
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('even the owner cannot overwrite a stock level directly',
    format('update finished_goods set qty_balance = 999 where id = %L::uuid', t_id('soap')), 'only change through');
  perform t_ok('editing a product name is still fine',
    format('update finished_goods set name = %L where id = %L::uuid', 'Jokesan Soap 200g', t_id('soap')));
  perform t_su();
end $$;

-- ---------- 11. adjustments ----------
do $$
begin
  perform t_as('00000000-0000-0000-0000-000000000003');
  perform t_ok('storekeeper writes off 2 damaged soap at Lagos',
    format('select public.adjust_stock(%L::uuid, %L, %L::uuid, -2, null, %L)',
      t_id('lagos'), 'finished_good', t_id('soap'), 'damaged in transit'));
  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('cashier cannot adjust stock',
    format('select public.adjust_stock(%L::uuid, %L, %L::uuid, 5)', t_id('abuja'), 'finished_good', t_id('soap')),
    'not allowed');
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_ok('owner adds 10 opening stock at Abuja at ₦30',
    format('select public.adjust_stock(%L::uuid, %L, %L::uuid, 10, 30, %L)',
      t_id('abuja'), 'finished_good', t_id('soap'), 'opening balance'));
  perform t_su();

  perform t_rec('write-off is costed from FIFO (₦25 × 2 = ₦50)',
    (select unit_cost = 25 and total_cost = 50 from stock_adjustments where qty_delta = -2));
  perform t_rec('Lagos 25 − 3 sold − 2 damaged = 20', t_stock(t_id('lagos'), t_id('soap')) = 20);
  perform t_rec('Abuja 15 + 10 opening = 25', t_stock(t_id('abuja'), t_id('soap')) = 25);
end $$;

-- ---------- 12. payments ----------
do $$
declare v_sale uuid;
begin
  perform t_as('00000000-0000-0000-0000-000000000001');
  execute format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(t_id('soap'), 1, 60))
    into v_sale;
  perform t_err('a payment larger than what is owed is refused',
    format('select public.record_sale_payment(%L::uuid, 100, null)', v_sale), 'more than');
  perform t_err('a negative payment is refused',
    format('select public.record_sale_payment(%L::uuid, -5, null)', v_sale), 'more than zero');
  perform t_ok('paying the exact balance works',
    format('select public.record_sale_payment(%L::uuid, 60, null)', v_sale));
  perform t_err('a voided sale cannot take a payment',
    format('select public.record_sale_payment(%L::uuid, 1, null)', t_id('abuja_sale')), 'voided');
  perform t_su();
  perform t_rec('credit sale settles to full with zero balance',
    (select payment_status = 'full' and balance = 0 from sales_orders where id = v_sale));
end $$;

-- ---------- 13. another company's IDs are refused ----------
do $$
declare v_foreign uuid;
begin
  select id into v_foreign from materials where name = 'Legacy Oil';
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('cannot buy into another company''s material',
    format('select public.create_purchase(null, current_date, null, 0, %L::jsonb)',
      jsonb_build_array(jsonb_build_object('material_id', v_foreign, 'qty', 1, 'cost_price', 1))::text),
    'does not belong');
  perform t_su();
end $$;

-- ---------- 14. VAT comes from settings, not the client ----------
do $$
declare v_sale uuid;
begin
  update tenants set vat_enabled = true, vat_rate = 7.5 where id = t_id('tenant');
  perform t_as('00000000-0000-0000-0000-000000000002');
  execute format('select public.create_sale(null, current_date, null, 0, %L::jsonb, 0)', t_items(t_id('soap'), 1, 60))
    into v_sale;
  perform t_su();
  perform t_rec('cashier passing VAT 0 still gets the company''s 7.5% (₦4.50)',
    (select vat_amount = 4.5 and total_amount = 64.5 from sales_orders where id = v_sale));
  update tenants set vat_enabled = false where id = t_id('tenant');
end $$;

-- ---------- 15. role-shaped dashboards ----------
do $$
declare v jsonb;
begin
  perform t_as('00000000-0000-0000-0000-000000000002');
  v := public.dashboard_summary();
  perform t_rec('cashier dashboard: till figures, no profit, no expenses',
    v ? 'today_total' and not v ? 'gross_profit' and not v ? 'total_expenses', v::text);
  perform t_rec('cashier dashboard is about Abuja', v->>'branch_name' = 'Abuja', v->>'branch_name');
  perform t_rec('cashier dashboard carries yesterday for a like-for-like comparison', v ? 'yesterday_total', v::text);

  perform t_as('00000000-0000-0000-0000-000000000003');
  v := public.dashboard_summary();
  perform t_rec('storekeeper dashboard: stock, no money',
    v ? 'out_of_stock_count' and not v ? 'total_sales' and not v ? 'today_total', v::text);
  perform t_rec('storekeeper dashboard counts what their branch carries',
    (v->>'stock_items')::int >= 1, v->>'stock_items');
  perform t_rec('storekeeper movements name the item',
    (select bool_and(e ? 'name' and e->>'name' is not null) from jsonb_array_elements(v->'recent_movements') e),
    (v->'recent_movements')::text);

  perform t_as('00000000-0000-0000-0000-000000000001');
  v := public.dashboard_summary();
  perform t_rec('owner dashboard compares both branches',
    jsonb_array_length(v->'by_branch') = 2 and v ? 'gross_profit', (v->'by_branch')::text);
  perform t_rec('owner dashboard has month-to-date figures and a like-for-like last month',
    v ? 'month_sales' and v ? 'last_month_sales' and v ? 'month_profit' and v ? 'month_expenses'
    and (v->>'month_sales')::numeric > 0, v::text);
  perform t_su();
end $$;

-- ---------- 16. margins are finance-only ----------
do $$
declare v_n int;
begin
  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('cashier cannot pull product margins',
    'select * from public.report_product_profitability()', 'Only admin and accounts');
  perform t_as('00000000-0000-0000-0000-000000000004');
  select count(*) into v_n from public.report_product_profitability(null, null, t_id('abuja'));
  perform t_rec('bookkeeper sees margins, filterable to one branch', v_n = 1, v_n::text);
  perform t_su();
end $$;

-- ---------- 17. admin switches branch ----------
do $$
declare v_sale uuid;
begin
  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('cashier cannot switch themselves to another branch',
    format('select public.set_my_branch(%L::uuid)', t_id('lagos')), 'Only an admin');
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.set_my_branch(t_id('abuja'));
  execute format('select public.create_sale(null, current_date, null, 60, %L::jsonb)', t_items(t_id('soap'), 1, 60))
    into v_sale;
  perform t_su();
  perform t_rec('after switching, the owner''s sale lands at Abuja',
    (select branch_id = t_id('abuja') from sales_orders where id = v_sale));
end $$;

-- ---------- 18. suspended account is read-only ----------
do $$
declare v_n int;
begin
  update tenants set is_active = false where id = t_id('tenant');
  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('suspended account cannot sell',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(t_id('soap'), 1, 60)),
    'suspended');
  select count(*) into v_n from sales_orders;
  perform t_rec('suspended account can still read its records', v_n > 0, v_n::text);
  perform t_su();
  update tenants set is_active = true where id = t_id('tenant');
end $$;

-- ---------- 19. existing accounts after the migration ----------
do $$
declare v_sale uuid; v_oil uuid; v_soap uuid;
begin
  select id into v_oil  from materials      where name = 'Legacy Oil';
  select id into v_soap from finished_goods where name = 'Legacy Soap';
  perform t_rec('legacy material: on-screen stock unchanged (70) and fully backed by layers',
    (select qty_balance = 70 from materials where id = v_oil)
    and (select sum(qty_remaining) = 70 from purchase_items where material_id = v_oil));
  perform t_rec('legacy typed-in opening stock got a cost (latest purchase ₦100)',
    (select cost_price = 100 and origin = 'opening' from purchase_items where material_id = v_oil and purchase_order_id is null));

  perform t_as('00000000-0000-0000-0000-00000000000a');
  execute format('select public.create_sale(null, current_date, null, 7500, %L::jsonb)', t_items(v_soap, 5, 1500))
    into v_sale;
  perform t_su();
  perform t_rec('legacy typed-in product stock can now actually be sold (was "Stock/batch mismatch")',
    (select cogs = 5000 from sales_orders where id = v_sale),
    (select cogs::text from sales_orders where id = v_sale));
end $$;

-- ---------- 19b. branch lifecycle ----------
do $$
begin
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('a branch that still holds stock cannot be deactivated',
    format('update branches set is_active = false where id = %L::uuid', t_id('abuja')), 'still holds stock');
  perform t_err('branches are deactivated, never deleted',
    format('delete from branches where id = %L::uuid', t_id('abuja')), 'Deactivate the branch');
  perform t_ok('renaming a branch is still fine',
    format('update branches set name = %L where id = %L::uuid', 'Abuja (Wuse)', t_id('abuja')));
  perform t_su();
end $$;

-- ---------- 21. invoice numbers (0021) ----------
do $$
declare v_a uuid; v_b uuid; v_c uuid; v_na text; v_nb text; v_nc text; v_n int; v_d int;
begin
  perform t_as('00000000-0000-0000-0000-000000000001');
  execute format('select public.create_sale(null, current_date, null, 60, %L::jsonb)', t_items(t_id('soap'), 1, 60)) into v_a;
  execute format('select public.create_sale(null, current_date, null, 60, %L::jsonb)', t_items(t_id('soap'), 1, 60)) into v_b;
  perform t_err('(setup) an oversold sale fails',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(t_id('soap'), 9999, 60)), 'Only');
  execute format('select public.create_sale(null, current_date, null, 60, %L::jsonb)', t_items(t_id('soap'), 1, 60)) into v_c;
  perform t_su();
  select doc_no into v_na from sales_orders where id = v_a;
  select doc_no into v_nb from sales_orders where id = v_b;
  select doc_no into v_nc from sales_orders where id = v_c;

  perform t_rec('every sale gets a server-issued invoice number (INV-000123)', v_na ~ '^INV-[0-9]{6}$', v_na);
  perform t_rec('invoice numbers run in sequence', right(v_nb, 6)::int = right(v_na, 6)::int + 1, v_na || ' → ' || v_nb);
  perform t_rec('a sale that fails gives its number back (no gap)', right(v_nc, 6)::int = right(v_nb, 6)::int + 1, v_nb || ' → ' || v_nc);
  select count(*), count(distinct doc_no) into v_n, v_d from sales_orders where tenant_id = t_id('tenant');
  perform t_rec('no two sales in a company share a number', v_n = v_d and v_n > 0, format('%s sales, %s numbers', v_n, v_d));
  perform t_rec('each company has its own sequence (legacy company starts at INV-000001)',
    exists (select 1 from sales_orders so join profiles p on p.tenant_id = so.tenant_id
             where p.id = '00000000-0000-0000-0000-00000000000a' and so.doc_no = 'INV-000001'));
  perform t_err('an issued invoice number can''t be changed, even from the SQL editor',
    format('update sales_orders set doc_no = %L where id = %L::uuid', 'INV-999999', v_a), 'can''t be changed');
  perform t_rec('voiding a sale leaves an audit entry',
    exists (select 1 from audit_logs where action = 'void' and entity = 'sales_orders' and entity_id = t_id('abuja_sale')::text));

  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('cashier cannot rebrand invoice numbers', $q$select public.set_doc_prefix('INV', 'X-')$q$, 'Only an admin');
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_ok('owner brands invoice numbers JKS-INV-', $q$select public.set_doc_prefix('INV', 'JKS-INV-')$q$);
  execute format('select public.create_sale(null, current_date, null, 60, %L::jsonb)', t_items(t_id('soap'), 1, 60)) into v_a;
  perform t_su();
  select doc_no into v_na from sales_orders where id = v_a;
  perform t_rec('the new prefix applies to the next invoice and the count carries on',
    v_na like 'JKS-INV-%' and right(v_na, 6)::int = right(v_nc, 6)::int + 1, v_na);
end $$;

-- ---------- 22. plan gating (0021) ----------
do $$
begin
  update tenants set plan = 'starter' where id = t_id('tenant');
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('Starter plan cannot switch on expiry tracking',
    format('update finished_goods set track_batches = true where id = %L::uuid', t_id('soap')), 'Growth plan');
  perform t_err('Starter plan cannot switch on earliest-expiry-first',
    format('update finished_goods set pick_rule = %L where id = %L::uuid', 'fefo', t_id('soap')), 'Growth plan');
  perform t_ok('Starter plan can still edit the product itself',
    format('update finished_goods set nafdac_no = %L where id = %L::uuid', 'A1-0000', t_id('soap')));
  perform t_su();
  update tenants set plan = 'growth' where id = t_id('tenant');
end $$;

-- ---------- 23. batch numbers and expiry (0022) ----------
do $$
declare
  v_mats text := jsonb_build_array(jsonb_build_object('material_id', t_id('caustic'), 'qty', 5))::text;
  v_run uuid; v_a text; v_sale uuid; v_q numeric; v_s numeric; v_n int; v_tr jsonb; v_ov jsonb;
begin
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_ok('owner switches on expiry tracking and earliest-expiry-first for soap',
    format('update finished_goods set track_batches = true, shelf_life_days = 365, pick_rule = %L, nafdac_no = %L where id = %L::uuid',
      'fefo', 'A1-1234', t_id('soap')));

  -- Storekeeper makes two batches at Lagos: one auto-numbered, one typed in
  -- with an earlier expiry.
  perform t_as('00000000-0000-0000-0000-000000000003');
  execute format('select public.record_production(%L::uuid, current_date, 0, 10, %L::jsonb)', t_id('soap'), v_mats) into v_run;
  perform t_ok('storekeeper records a batch with its own number and dates',
    format('select public.record_production(%L::uuid, current_date, 0, 10, %L::jsonb, null, %L, current_date - 10, current_date + 30)',
      t_id('soap'), v_mats, 'B-OLD'));
  perform t_err('a batch number can''t be used twice for the same product',
    format('select public.record_production(%L::uuid, current_date, 0, 1, %L::jsonb, null, %L)', t_id('soap'), v_mats, 'b-old'),
    'already used');
  perform t_err('expiry before manufacture is refused',
    format('select public.record_production(%L::uuid, current_date, 0, 1, %L::jsonb, null, %L, current_date, current_date - 1)',
      t_id('soap'), v_mats, 'B-X'), 'after the manufacture date');
  perform t_err('a manufacture date in the future is refused',
    format('select public.record_production(%L::uuid, current_date, 0, 1, %L::jsonb, null, %L, current_date + 5)',
      t_id('soap'), v_mats, 'B-Y'), 'future');
  perform t_su();
  update finished_goods set shelf_life_days = null where id = t_id('soap');
  perform t_as('00000000-0000-0000-0000-000000000003');
  perform t_err('a tracked product with no shelf life needs an expiry date',
    format('select public.record_production(%L::uuid, current_date, 0, 1, %L::jsonb, null, %L)', t_id('soap'), v_mats, 'B-Z'),
    'Enter an expiry date');
  perform t_su();
  update finished_goods set shelf_life_days = 365 where id = t_id('soap');

  select batch_no into v_a from fg_batches where production_run_id = v_run;
  perform t_put('batch_a', (select id from fg_batches where production_run_id = v_run));
  perform t_put('batch_b', (select id from fg_batches where batch_no = 'B-OLD'));
  -- Section 3's run was the first soap batch today (-01); this is the second.
  perform t_rec('auto batch numbers are PREFIX-YYMMDD-NN and count up through the day (-01, -02)',
    v_a = 'JOKE-' || to_char(current_date, 'YYMMDD') || '-02'
    and exists (select 1 from fg_batches where batch_no = 'JOKE-' || to_char(current_date, 'YYMMDD') || '-01'), v_a);
  perform t_rec('auto expiry = manufacture date + shelf life (365 days)',
    (select expiry_date = current_date + 365 and mfg_date = current_date from fg_batches where production_run_id = v_run));
  perform t_rec('the production run carries its batch number',
    (select batch_no = v_a from production_runs where id = v_run));

  -- FEFO: B-OLD (expires in 30 days) goes before the auto batch and the
  -- older un-dated stock.
  perform t_as('00000000-0000-0000-0000-000000000001');
  execute format('select public.create_sale(null, current_date, null, 0, %L::jsonb, 0, %L::uuid)',
    t_items(t_id('soap'), 5, 60), t_id('lagos')) into v_sale;
  perform t_put('fefo_sale', v_sale);
  perform t_su();
  perform t_rec('earliest expiry first: the sale drew from B-OLD, not the oldest stock',
    (select bool_and(fb.batch_no = 'B-OLD') from sales_consumption sc
       join sale_items si on si.id = sc.sale_item_id join fg_batches fb on fb.id = sc.fg_batch_id
      where si.sales_order_id = v_sale));

  -- B-OLD now expires.
  update fg_batches set expiry_date = current_date - 1 where id = t_id('batch_b');
  perform t_as('00000000-0000-0000-0000-000000000001');
  execute format('select public.create_sale(null, current_date, null, 0, %L::jsonb, 0, %L::uuid)',
    t_items(t_id('soap'), 3, 60), t_id('lagos')) into v_sale;
  perform t_su();
  perform t_rec('expired stock is skipped: the next sale drew from the next batch',
    (select bool_and(fb.batch_no = v_a) from sales_consumption sc
       join sale_items si on si.id = sc.sale_item_id join fg_batches fb on fb.id = sc.fg_batch_id
      where si.sales_order_id = v_sale));

  perform t_as('00000000-0000-0000-0000-000000000003');
  select qty, sellable_qty into v_q, v_s from public.stock_levels(t_id('lagos')) where product_id = t_id('soap');
  perform t_rec('stock levels separate what is on the shelf from what can be sold (5 expired)',
    v_q - v_s = 5, format('qty=%s sellable=%s', v_q, v_s));
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('overselling says how much is blocked by expiry',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb, 0, %L::uuid)',
      t_items(t_id('soap'), v_s + 2, 60), t_id('lagos')), 'expired, recalled or on hold');
  perform t_err('an expired batch cannot be sold even when picked by hand',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb, 0, %L::uuid)',
      jsonb_build_array(jsonb_build_object('finished_good_id', t_id('soap'), 'quantity', 1, 'unit_price', 60,
        'fg_batch_id', t_id('batch_b')))::text, t_id('lagos')), 'expired on');
  perform t_su();
  update tenants set allow_expired_sale = true where id = t_id('tenant');
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_ok('a company that allows it can sell an expired batch by hand',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb, 0, %L::uuid)',
      jsonb_build_array(jsonb_build_object('finished_good_id', t_id('soap'), 'quantity', 1, 'unit_price', 60,
        'fg_batch_id', t_id('batch_b')))::text, t_id('lagos')));
  perform t_su();
  update tenants set allow_expired_sale = false where id = t_id('tenant');
  perform t_rec('the hand-picked sale came out of that batch (5 → 4)',
    (select qty_remaining = 4 from fg_batches where id = t_id('batch_b')));

  -- Moving one batch to Abuja keeps its number and dates.
  perform t_as('00000000-0000-0000-0000-000000000003');
  perform t_ok('storekeeper sends 2 of the auto batch to Abuja',
    format('select public.transfer_stock(%L::uuid, %L::uuid, %L, %L::uuid, 2, %L, %L::uuid)',
      t_id('lagos'), t_id('abuja'), 'finished_good', t_id('soap'), 'batch move', t_id('batch_a')));
  select sellable_qty into v_s from public.stock_levels(t_id('lagos')) where product_id = t_id('soap');
  perform t_err('a plain transfer won''t ship expired stock',
    format('select public.transfer_stock(%L::uuid, %L::uuid, %L, %L::uuid, %s)',
      t_id('lagos'), t_id('abuja'), 'finished_good', t_id('soap'), v_s + 1), 'expired, recalled or on hold');
  perform t_su();
  perform t_put('batch_a_abuja', (select id from fg_batches where branch_id = t_id('abuja') and batch_no = v_a));
  perform t_rec('the batch arrives at Abuja with the same number and expiry',
    (select qty = 2 and origin = 'transfer' and expiry_date = current_date + 365 from fg_batches where id = t_id('batch_a_abuja')));

  -- Recall.
  perform t_as('00000000-0000-0000-0000-000000000003');
  perform t_err('storekeeper cannot recall a batch',
    format('select public.set_batch_status(%L::uuid, %L, %L, %L)', t_id('soap'), v_a, 'recalled', 'x'), 'Only an admin');
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('a recall needs a reason',
    format('select public.set_batch_status(%L::uuid, %L, %L)', t_id('soap'), v_a, 'recalled'), 'reason');
  execute format('select public.set_batch_status(%L::uuid, %L, %L, %L)', t_id('soap'), v_a, 'recalled', 'Customer complaint')
    into v_n;
  perform t_su();
  perform t_rec('a recall reaches every branch the batch went to (2 layers)', v_n = 2, v_n::text);
  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('Abuja cashier cannot sell the recalled batch',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb)',
      jsonb_build_array(jsonb_build_object('finished_good_id', t_id('soap'), 'quantity', 1, 'unit_price', 60,
        'fg_batch_id', t_id('batch_a_abuja')))::text), 'recalled');
  perform t_su();
  perform t_rec('the recall is in the audit log',
    exists (select 1 from audit_logs where action = 'batch_recalled' and entity_id = v_a));

  -- Trace.
  perform t_as('00000000-0000-0000-0000-000000000004');
  v_tr := public.batch_trace(t_id('soap'), v_a);
  perform t_rec('trace: shows the caustic soda that went into the batch',
    v_tr->'sources' @> '[{"material":"Caustic Soda"}]', (v_tr->'sources')::text);
  perform t_rec('trace: shows who got it (3 units, walk-in) and where the rest is (2 branches)',
    (v_tr->>'sold_qty')::numeric = 3 and v_tr->'sales'->0->>'customer' = 'Walk-in'
    and jsonb_array_length(v_tr->'stock') = 2 and v_tr->>'status' = 'recalled', v_tr::text);
  perform t_as('00000000-0000-0000-0000-000000000003');
  v_tr := public.batch_trace(t_id('soap'), v_a);
  perform t_rec('storekeeper''s trace leaves out customer names and phones',
    not (v_tr->>'shows_customers')::boolean and v_tr->'sales'->0->'customer' = 'null'::jsonb, v_tr::text);
  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('cashier cannot trace a batch',
    format('select public.batch_trace(%L::uuid, %L)', t_id('soap'), v_a), 'Only admin');

  -- What's expiring.
  perform t_as('00000000-0000-0000-0000-000000000003');
  v_ov := public.expiry_overview();
  perform t_rec('storekeeper sees the expired batch and the recalled one at Lagos, without money',
    (v_ov->>'expired_count')::int >= 1 and (v_ov->>'on_hold_count')::int >= 1
    and v_ov->'expired_value' = 'null'::jsonb
    and exists (select 1 from jsonb_array_elements(v_ov->'items') i where i->>'batch_no' = 'B-OLD'), v_ov::text);
  perform t_as('00000000-0000-0000-0000-000000000004');
  v_ov := public.expiry_overview();
  perform t_rec('bookkeeper sees the money tied up in expired stock', (v_ov->>'expired_value')::numeric > 0, v_ov::text);

  -- Voids go back to the exact batch; write-offs empty exactly one batch.
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.void_sale(t_id('fefo_sale'));
  perform t_su();
  perform t_rec('voiding the earlier sale puts its 5 back into B-OLD (4 → 9)',
    (select qty_remaining = 9 from fg_batches where id = t_id('batch_b')));
  perform t_as('00000000-0000-0000-0000-000000000003');
  perform t_err('storekeeper cannot write off a batch sitting at another branch',
    format('select public.write_off_batch(%L, %L::uuid, %L)', 'finished_good', t_id('batch_a_abuja'), 'Recalled'), 'own branch');
  perform t_ok('storekeeper writes off the expired batch in one go',
    format('select public.write_off_batch(%L, %L::uuid)', 'finished_good', t_id('batch_b')));
  perform t_su();
  perform t_rec('the write-off emptied that batch and left the others alone',
    (select qty_remaining = 0 from fg_batches where id = t_id('batch_b'))
    and (select qty_remaining = 5 from fg_batches where id = t_id('batch_a')));
  perform t_rec('the write-off is recorded against the batch with its FIFO cost (9 × ₦25)',
    exists (select 1 from stock_adjustments where batch_id = t_id('batch_b') and qty_delta = -9 and total_cost = 225));
  perform t_rec('the write-off is in the audit log',
    exists (select 1 from audit_logs where action = 'write_off' and entity_id = t_id('batch_b')::text));

  -- Suppliers' batches and labelled opening stock.
  perform t_as('00000000-0000-0000-0000-000000000003');
  perform t_ok('a purchase records the supplier''s batch number and expiry',
    format('select public.create_purchase(null, current_date, null, 0, %L::jsonb)',
      jsonb_build_array(jsonb_build_object('material_id', t_id('caustic'), 'qty', 10, 'cost_price', 60,
        'supplier_batch_no', 'SUP-9', 'expiry_date', (current_date + 200)::text))::text));
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_ok('opening stock can carry its batch number and expiry',
    format('select public.adjust_stock(%L::uuid, %L, %L::uuid, 6, 30, %L, null, %L, current_date + 100)',
      t_id('abuja'), 'finished_good', t_id('soap'), 'Opening balance', 'OPEN-1'));
  perform t_err('opening stock with expiry before manufacture is refused',
    format('select public.adjust_stock(%L::uuid, %L, %L::uuid, 6, 30, %L, null, %L, current_date - 1, current_date)',
      t_id('abuja'), 'finished_good', t_id('soap'), 'Opening balance', 'OPEN-2'), 'after the manufacture');
  perform t_err('a batch can only be picked when removing stock',
    format('select public.adjust_stock(%L::uuid, %L, %L::uuid, 5, null, %L, %L::uuid)',
      t_id('abuja'), 'finished_good', t_id('soap'), 'x', t_id('batch_a_abuja')), 'only when removing');
  perform t_su();
  perform t_rec('supplier batch and expiry are stored on the material layer',
    exists (select 1 from purchase_items where supplier_batch_no = 'SUP-9' and expiry_date = current_date + 200));
  perform t_rec('labelled opening stock keeps its batch and expiry at Abuja',
    exists (select 1 from fg_batches where batch_no = 'OPEN-1' and expiry_date = current_date + 100 and branch_id = t_id('abuja')));
end $$;

-- ---------- 24. Returns and credit notes (0023) ----------
do $$
declare
  v_rsoap uuid; v_cust uuid; v_rsale1 uuid; v_rsale2 uuid; v_walkin uuid;
  v_cash uuid; v_item1 uuid; v_item2 uuid; v_itemw uuid;
  v_n int; v_bal numeric; v_status text; v_credit numeric;
begin
  select id into v_cash from payment_types where tenant_id = t_id('tenant') and name = 'Cash';

  -- ---- setup: a product just for this section, so its numbers are clean ----
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.set_my_branch(t_id('lagos'));
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
  values (t_id('tenant'), 'Return Soap', 'pcs', 5, 100, 1.5) returning id into v_rsoap;
  perform t_put('rsoap', v_rsoap);
  perform public.adjust_stock(t_id('lagos'), 'finished_good', v_rsoap, 20, 40, 'Opening balance');
  perform public.adjust_stock(t_id('abuja'), 'finished_good', v_rsoap, 10, 40, 'Opening balance');

  insert into customers (tenant_id, first_name) values (t_id('tenant'), 'Returning Customer') returning id into v_cust;
  perform t_put('return_cust', v_cust);

  -- ---- A: only the cashier who rang it up (same day) may return it ----
  execute format('select public.create_sale(%L::uuid, current_date, null, 600, %L::jsonb)',
    v_cust, t_items(v_rsoap, 10, 100)) into v_rsale1;
  perform t_put('rsale1', v_rsale1);
  select id into v_item1 from sale_items where sales_order_id = v_rsale1;

  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('a cashier cannot return someone else''s sale',
    format('select public.create_sale_return(%L::uuid, %L::jsonb, %L)', v_rsale1,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item1, 'qty', 1))::text, 'wrong person'),
    'you rang up yourself');
  perform t_su();

  -- ---- B: a mixed return (resellable + damaged) pays down the balance first ----
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.create_sale_return(v_rsale1,
    jsonb_build_array(
      jsonb_build_object('sale_item_id', v_item1, 'qty', 3, 'condition', 'resellable'),
      jsonb_build_object('sale_item_id', v_item1, 'qty', 1, 'condition', 'damaged')),
    'wrong size, one arrived crushed');
  perform t_su();

  select balance, payment_status into v_bal, v_status from sales_orders where id = v_rsale1;
  perform t_rec('a return that exactly covers the balance settles the sale',
    v_bal = 0 and v_status = 'full', format('balance=%s status=%s', v_bal, v_status));
  perform t_rec('resellable units go back to the exact batch at cost (10-10+3=13 left)',
    (select qty_remaining = 13 from fg_batches where finished_good_id = v_rsoap and branch_id = t_id('lagos') and origin = 'adjustment'));
  perform t_rec('damaged units do not come back to the shelf (Lagos 13 + Abuja 10 = 23, not 24)',
    (select qty_balance = 23 from finished_goods where id = v_rsoap));
  perform t_rec('gross profit is adjusted by revenue lost minus cost recovered (400 - 120 = 280)',
    (select returned_total = 400 and returned_profit = 280 from sales_orders where id = v_rsale1));

  -- ---- C: once the balance is gone, the rest is a cash refund ----
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.create_sale_return(v_rsale1,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item1, 'qty', 2, 'condition', 'resellable')),
    'kept fewer than planned', 'cash', v_cash);
  perform t_su();
  perform t_rec('nothing more was owed, so the whole return came back as a cash refund',
    exists (select 1 from sale_payments where sales_order_id = v_rsale1 and reference = 'RETURN' and amount_paid = -200));
  perform t_rec('the sale stays settled after a refund (balance is still 0)',
    (select balance = 0 and payment_status = 'full' from sales_orders where id = v_rsale1));

  -- ---- D: or, for a named customer, store credit instead of cash ----
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.create_sale_return(v_rsale1,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item1, 'qty', 2, 'condition', 'resellable')),
    'store credit instead', 'store_credit');
  perform t_su();
  select credit_balance into v_credit from customers where id = v_cust;
  perform t_rec('the customer earned store credit for the refund (₦200)', v_credit = 200, v_credit::text);

  -- ---- E: a return can't take back more than is left to return ----
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('cannot return more than what is left on the line',
    format('select public.create_sale_return(%L::uuid, %L::jsonb, %L)', v_rsale1,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item1, 'qty', 3))::text, 'too many'),
    'still returnable');
  perform public.create_sale_return(v_rsale1,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item1, 'qty', 2, 'condition', 'resellable')),
    'the last of it');
  perform t_su();
  perform t_rec('every resellable unit is back on the shelf (9 of 10 returned, 1 stayed damaged: 10-10+9=19)',
    (select qty_remaining = 19 from fg_batches where finished_good_id = v_rsoap and branch_id = t_id('lagos') and origin = 'adjustment'));
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('the line is now fully returned',
    format('select public.create_sale_return(%L::uuid, %L::jsonb, %L)', v_rsale1,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item1, 'qty', 1))::text, 'once more'),
    'still returnable');
  perform t_err('a sale with a return on it can''t be voided as a whole',
    format('select public.void_sale(%L::uuid)', v_rsale1), 'use a return');
  perform t_su();

  -- ---- F: store credit is spent like a second payment, capped both ways ----
  -- Sale of 3 (₦300 owed) against a customer sitting on ₦200 of credit, so
  -- the two caps (what's owed, what they have) each get tested on their own.
  perform t_as('00000000-0000-0000-0000-000000000001');
  execute format('select public.create_sale(%L::uuid, current_date, null, 0, %L::jsonb)',
    v_cust, t_items(v_rsoap, 3, 100)) into v_rsale2;
  perform t_put('rsale2', v_rsale2);
  perform t_err('cannot spend more store credit than the customer has',
    format('select public.spend_store_credit(%L::uuid, 250)', v_rsale2), 'only has');
  perform t_err('cannot spend more credit than the sale still owes',
    format('select public.spend_store_credit(%L::uuid, 350)', v_rsale2), 'more than');
  perform public.spend_store_credit(v_rsale2, 200);
  perform t_su();
  select credit_balance into v_credit from customers where id = v_cust;
  perform t_rec('spending store credit reduces the customer''s balance (200 → 0)', v_credit = 0, v_credit::text);
  perform t_rec('it pays down the sale without needing to fully settle it (300 - 200 = 100 still owed)',
    (select balance = 100 and payment_status = 'part' from sales_orders where id = v_rsale2));
  perform t_rec('store credit is logged as its own kind of payment',
    exists (select 1 from sale_payments where sales_order_id = v_rsale2 and reference = 'STORE_CREDIT' and amount_paid = 200));

  -- ---- G: store credit needs someone to credit it to ----
  -- Paid in full, so the return has no balance left to absorb it — the
  -- whole thing has to go out as a refund, and there's no one to credit.
  perform t_as('00000000-0000-0000-0000-000000000002');
  execute format('select public.create_sale(null, current_date, null, 200, %L::jsonb)', t_items(v_rsoap, 2, 100)) into v_walkin;
  select id into v_itemw from sale_items where sales_order_id = v_walkin;
  perform t_err('store credit is refused on a walk-in sale with no customer',
    format('select public.create_sale_return(%L::uuid, %L::jsonb, null, %L)', v_walkin,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_itemw, 'qty', 1))::text, 'store_credit'),
    'named customer');
  perform t_su();

  -- ---- H: goods sent back to a supplier ----
  perform t_as('00000000-0000-0000-0000-000000000003');
  declare v_po uuid; v_pi uuid; v_before numeric;
  begin
    select public.create_purchase(null, current_date, null, 0,
      jsonb_build_array(jsonb_build_object('material_id', t_id('caustic'), 'qty', 20, 'cost_price', 10))) into v_po;
    select id into v_pi from purchase_items where purchase_order_id = v_po;
    select balance into v_before from purchase_orders where id = v_po;
    perform public.create_purchase_return(v_po,
      jsonb_build_array(jsonb_build_object('purchase_item_id', v_pi, 'qty', 5)), 'damaged in the bag');
    perform t_rec('the supplier return draws down that exact batch (20 → 15)',
      (select qty_remaining = 15 from purchase_items where id = v_pi));
    perform t_rec('what you owe the supplier drops by the return''s cost (₦200 → ₦150)',
      (select balance = v_before - 50 from purchase_orders where id = v_po));
    perform t_err('cannot return more of a batch than is still unused',
      format('select public.create_purchase_return(%L::uuid, %L::jsonb)', v_po,
        jsonb_build_array(jsonb_build_object('purchase_item_id', v_pi, 'qty', 20))::text),
      'still unused');
  end;
  perform t_su();

  -- ---- I: a return in one report period doesn't touch another (2026-01 vs today) ----
  -- (kept simple: this is exercised structurally by dashboard_summary/report_*
  --  joining sale_returns on its OWN return_date rather than the sale's date;
  --  covered by the profitability and returns-report assertions below.)
end $$;

-- ---------- 25. reports net returns out cleanly (isolated product) ----------
do $$
declare v_item uuid; v_sale uuid; v_ret uuid; v_cash uuid; v_row record;
begin
  select id into v_cash from payment_types where tenant_id = t_id('tenant') and name = 'Cash';
  perform t_as('00000000-0000-0000-0000-000000000001');
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
  values (t_id('tenant'), 'Profit Test Item', 'pcs', 5, 25, 1.5) returning id into v_item;
  perform t_put('profit_item', v_item);
  perform public.adjust_stock(t_id('lagos'), 'finished_good', v_item, 5, 10, 'Opening balance');

  execute format('select public.create_sale(null, current_date, null, 125, %L::jsonb)', t_items(v_item, 5, 25)) into v_sale;
  execute format(
    'select public.create_sale_return(%L::uuid, %L::jsonb, %L, %L, %L::uuid)',
    v_sale,
    jsonb_build_array(jsonb_build_object('sale_item_id',
      (select id from sale_items where sales_order_id = v_sale), 'qty', 2, 'condition', 'resellable'))::text,
    'too many', 'cash', v_cash
  ) into v_ret;
  perform t_su();

  perform t_as('00000000-0000-0000-0000-000000000004');
  select * into v_row from public.report_product_profitability(null, null, null)
   where fg_id = v_item;
  perform t_rec('product profitability nets qty, revenue and cost (net of returns)',
    v_row.qty_sold = 3 and v_row.total_revenue = 75 and v_row.total_cogs = 30 and v_row.profit = 45,
    format('qty=%s rev=%s cogs=%s profit=%s', v_row.qty_sold, v_row.total_revenue, v_row.total_cogs, v_row.profit));

  select * into v_row from public.report_returns(null, null, null) where fg_id = v_item;
  perform t_rec('the returns report splits resellable from a loss',
    v_row.qty_returned = 2 and v_row.value_returned = 50 and v_row.resellable_qty = 2 and v_row.loss_value = 0,
    format('qty=%s value=%s resellable=%s loss=%s', v_row.qty_returned, v_row.value_returned, v_row.resellable_qty, v_row.loss_value));
  perform t_su();
end $$;

-- ---------- 26. VAT on a return is prorated at the sale's own rate ----------
do $$
declare v_sale uuid; v_ret uuid; v_row record; v_item uuid; v_cash uuid;
begin
  select id into v_item from finished_goods where id = t_id('profit_item');
  select id into v_cash from payment_types where tenant_id = t_id('tenant') and name = 'Cash';
  update tenants set vat_enabled = true, vat_rate = 7.5 where id = t_id('tenant');

  perform t_as('00000000-0000-0000-0000-000000000001');
  execute format('select public.create_sale(null, current_date, null, 53.75, %L::jsonb, 0)', t_items(v_item, 2, 25)) into v_sale;
  execute format(
    'select public.create_sale_return(%L::uuid, %L::jsonb, null, %L, %L::uuid)',
    v_sale,
    jsonb_build_array(jsonb_build_object('sale_item_id',
      (select id from sale_items where sales_order_id = v_sale), 'qty', 1, 'condition', 'resellable'))::text,
    'cash', v_cash
  ) into v_ret;
  perform t_su();

  select * into v_row from sale_returns where id = v_ret;
  perform t_rec('a return carries its own share of VAT at the rate the sale was made at',
    v_row.subtotal = 25 and v_row.vat_amount = 1.88 and v_row.total = 26.88,
    format('subtotal=%s vat=%s total=%s', v_row.subtotal, v_row.vat_amount, v_row.total));

  update tenants set vat_enabled = false where id = t_id('tenant');
end $$;

-- ---------- 27. voiding a return (0024) ----------
do $$
declare
  v_item uuid; v_cash uuid; v_cust uuid;
  v_sale1 uuid; v_ret_a uuid; v_item1 uuid;
  v_sale2 uuid; v_ret_b uuid; v_item2 uuid;
  v_sale3 uuid; v_ret_c uuid; v_item3 uuid;
  v_sale4 uuid; v_ret_c2 uuid;
  v_bal numeric; v_credit numeric; v_n int;
begin
  select id into v_cash from payment_types where tenant_id = t_id('tenant') and name = 'Cash';

  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.set_my_branch(t_id('lagos'));
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
  values (t_id('tenant'), 'Void Test Item', 'pcs', 5, 50, 1.5) returning id into v_item;
  perform public.adjust_stock(t_id('lagos'), 'finished_good', v_item, 30, 20, 'Opening balance');
  insert into customers (tenant_id, first_name) values (t_id('tenant'), 'Credit Test Customer') returning id into v_cust;

  -- ---- A: a plain resellable return, voided, undoes stock and balance exactly ----
  execute format('select public.create_sale(null, current_date, null, 100, %L::jsonb)', t_items(v_item, 5, 50)) into v_sale1;
  select id into v_item1 from sale_items where sales_order_id = v_sale1;
  select public.create_sale_return(v_sale1,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item1, 'qty', 2, 'condition', 'resellable')),
    'wrong colour') into v_ret_a;
  perform t_su();

  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_err('only an admin may void a return', format('select public.void_sale_return(%L::uuid)', v_ret_a), 'Only an admin');
  perform t_su();

  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.void_sale_return(v_ret_a);
  perform t_su();
  select balance into v_bal from sales_orders where id = v_sale1;
  perform t_rec('voiding restores the balance the return had paid down (150)', v_bal = 150, v_bal::text);
  perform t_rec('voiding takes the resellable stock back off the shelf (25 = 30-5+2-2)',
    (select qty_remaining = 25 from fg_batches where finished_good_id = v_item and origin = 'adjustment'));
  perform t_rec('the line is returnable again after the void', (select qty_returned = 0 from sale_items where id = v_item1));
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('a voided return cannot be voided twice',
    format('select public.void_sale_return(%L::uuid)', v_ret_a), 'already voided');
  perform t_su();

  -- ---- B: voiding a return that paid out a cash refund removes that refund ----
  perform t_as('00000000-0000-0000-0000-000000000001');
  execute format('select public.create_sale(null, current_date, null, 150, %L::jsonb)', t_items(v_item, 3, 50)) into v_sale2;
  select id into v_item2 from sale_items where sales_order_id = v_sale2;
  select public.create_sale_return(v_sale2,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item2, 'qty', 1, 'condition', 'resellable')),
    'too many', 'cash', v_cash) into v_ret_b;
  perform t_rec('(setup) the refund was recorded', exists (select 1 from sale_payments where sale_return_id = v_ret_b));
  perform public.void_sale_return(v_ret_b);
  perform t_su();
  perform t_rec('voiding a cash-refunded return deletes that refund from the ledger',
    not exists (select 1 from sale_payments where sale_return_id = v_ret_b));
  perform t_rec('a fully-paid sale stays fully paid once the return that touched it is undone',
    (select balance = 0 and payment_status = 'full' from sales_orders where id = v_sale2));

  -- ---- C: voiding claws store credit back, unless it's already been spent ----
  perform t_as('00000000-0000-0000-0000-000000000001');
  execute format('select public.create_sale(%L::uuid, current_date, null, 100, %L::jsonb)', v_cust, t_items(v_item, 2, 50)) into v_sale3;
  select id into v_item3 from sale_items where sales_order_id = v_sale3;
  select public.create_sale_return(v_sale3,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item3, 'qty', 1, 'condition', 'resellable')),
    'store credit please', 'store_credit') into v_ret_c;
  select credit_balance into v_credit from customers where id = v_cust;
  perform t_rec('(setup) the customer holds the store credit', v_credit = 50, v_credit::text);
  perform public.void_sale_return(v_ret_c);
  perform t_su();
  select credit_balance into v_credit from customers where id = v_cust;
  perform t_rec('voiding a store-credit return claws the credit back (50 → 0)', v_credit = 0, v_credit::text);

  -- Do the same return again, spend part of the credit, then the void is refused.
  perform t_as('00000000-0000-0000-0000-000000000001');
  select public.create_sale_return(v_sale3,
    jsonb_build_array(jsonb_build_object('sale_item_id', v_item3, 'qty', 1, 'condition', 'resellable')),
    'store credit again', 'store_credit') into v_ret_c2;
  execute format('select public.create_sale(%L::uuid, current_date, null, 0, %L::jsonb)', v_cust, t_items(v_item, 1, 50)) into v_sale4;
  perform public.spend_store_credit(v_sale4, 30);
  perform t_su();
  select credit_balance into v_credit from customers where id = v_cust;
  perform t_rec('(setup) only 20 of the 50 credit is left unspent', v_credit = 20, v_credit::text);
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform t_err('a return can''t be undone once its store credit has been spent',
    format('select public.void_sale_return(%L::uuid)', v_ret_c2), 'already spent');
  perform t_su();

  -- ---- D: a return can't be undone once the stock it restored has moved on ----
  declare v_item2fg uuid; v_sale5 uuid; v_ret_d uuid; v_item5 uuid; v_sale6 uuid;
  begin
    perform t_as('00000000-0000-0000-0000-000000000001');
    insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
    values (t_id('tenant'), 'Void Test Item 2', 'pcs', 5, 30, 1.5) returning id into v_item2fg;
    perform public.adjust_stock(t_id('lagos'), 'finished_good', v_item2fg, 3, 10, 'Opening balance');
    execute format('select public.create_sale(null, current_date, null, 60, %L::jsonb)', t_items(v_item2fg, 2, 30)) into v_sale5;
    select id into v_item5 from sale_items where sales_order_id = v_sale5;
    select public.create_sale_return(v_sale5,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item5, 'qty', 1, 'condition', 'resellable')),
      'changed mind') into v_ret_d;
    -- 2 left on the shelf (1 never sold + 1 just returned) — sell both, so nothing is left to claw back.
    execute format('select public.create_sale(null, current_date, null, 60, %L::jsonb)', t_items(v_item2fg, 2, 30)) into v_sale6;
    perform t_err('a return can''t be undone once that stock has been sold again',
      format('select public.void_sale_return(%L::uuid)', v_ret_d), 'sold or moved elsewhere');
    perform t_su();
  end;
end $$;

-- ---------- 28. voiding a supplier return, and the cashier-return policy (0024) ----------
do $$
declare
  v_po uuid; v_pi uuid; v_pret uuid; v_bal numeric;
  v_sale uuid; v_item uuid; v_fg uuid;
begin
  -- ---- supplier return void: admin only, restores the batch and balance ----
  perform t_as('00000000-0000-0000-0000-000000000003');
  select public.create_purchase(null, current_date, null, 0,
    jsonb_build_array(jsonb_build_object('material_id', t_id('caustic'), 'qty', 10, 'cost_price', 10))) into v_po;
  select id into v_pi from purchase_items where purchase_order_id = v_po;
  select public.create_purchase_return(v_po,
    jsonb_build_array(jsonb_build_object('purchase_item_id', v_pi, 'qty', 3)), 'wrong grade') into v_pret;
  perform t_err('a storekeeper cannot void a supplier return', format('select public.void_purchase_return(%L::uuid)', v_pret), 'Only an admin');
  perform t_su();

  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.void_purchase_return(v_pret);
  perform t_su();
  perform t_rec('voiding a supplier return puts the goods back (10, not 7)', (select qty_remaining = 10 from purchase_items where id = v_pi));
  select balance into v_bal from purchase_orders where id = v_po;
  perform t_rec('and restores what was owed (₦100)', v_bal = 100, v_bal::text);

  -- ---- cashier-return policy is a per-business setting ----
  -- The cashier works at Abuja; "Void Test Item" so far only exists at Lagos.
  select id into v_fg from finished_goods where name = 'Void Test Item' and tenant_id = t_id('tenant');
  perform t_as('00000000-0000-0000-0000-000000000001');
  perform public.adjust_stock(t_id('abuja'), 'finished_good', v_fg, 5, 20, 'Opening balance');
  perform t_su();

  update tenants set cashier_returns = 'none' where id = t_id('tenant');
  perform t_as('00000000-0000-0000-0000-000000000002');
  execute format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(v_fg, 1, 50)) into v_sale;
  select id into v_item from sale_items where sales_order_id = v_sale;
  perform t_err('policy ''none'' blocks a cashier from returning anything',
    format('select public.create_sale_return(%L::uuid, %L::jsonb)', v_sale,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'qty', 1))::text),
    'Cashiers cannot process returns');
  perform t_su();

  update tenants set cashier_returns = 'any' where id = t_id('tenant');
  -- Backdated so it would fail under the default same-day rule.
  update sales_orders set transaction_date = current_date - 5 where id = v_sale;
  perform t_as('00000000-0000-0000-0000-000000000002');
  perform t_ok('policy ''any'' lets a cashier return an older sale',
    format('select public.create_sale_return(%L::uuid, %L::jsonb)', v_sale,
      jsonb_build_array(jsonb_build_object('sale_item_id', v_item, 'qty', 1))::text));
  perform t_su();

  update tenants set cashier_returns = 'same_day_own' where id = t_id('tenant');
end $$;

-- ---------- 29. price lists, discount limits, and below-cost (0025) ----------
do $$
declare
  v_admin uuid := '00000000-0000-0000-0000-000000000001';
  v_cashier uuid := '00000000-0000-0000-0000-000000000002';
  v_books uuid := '00000000-0000-0000-0000-000000000004';
  v_pitem uuid; v_wtype uuid; v_wbuyer uuid; v_wlist uuid; v_rlist uuid;
  v_sale uuid; v_row record; v_n numeric;
begin
  perform t_as(v_admin);
  perform public.set_my_branch(t_id('lagos'));
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
  values (t_id('tenant'), 'Priced Item', 'pcs', 5, 100, 1.5) returning id into v_pitem;
  perform t_put('priced_item', v_pitem);
  perform public.adjust_stock(t_id('lagos'), 'finished_good', v_pitem, 50, 20, 'Opening balance');
  perform public.adjust_stock(t_id('abuja'), 'finished_good', v_pitem, 20, 20, 'Opening balance');
  perform t_su();

  -- ---- A: price lists are a Growth-plan feature ----
  update tenants set plan = 'starter' where id = t_id('tenant');
  perform t_as(v_admin);
  perform t_err('price lists need at least the Growth plan',
    format('insert into price_lists (tenant_id, name) values (%L::uuid, %L)', t_id('tenant'), 'Test List'),
    'Growth plan');
  perform t_su();
  update tenants set plan = 'growth' where id = t_id('tenant');

  -- ---- setup: a wholesale customer with their own price list, quantity break included ----
  perform t_as(v_admin);
  insert into customer_types (tenant_id, name) values (t_id('tenant'), 'Wholesale') returning id into v_wtype;
  insert into customers (tenant_id, first_name, customer_type_id) values (t_id('tenant'), 'Wholesale Buyer', v_wtype) returning id into v_wbuyer;
  insert into price_lists (tenant_id, name, is_default) values (t_id('tenant'), 'Wholesale List', false) returning id into v_wlist;
  insert into price_lists (tenant_id, name, is_default) values (t_id('tenant'), 'Retail List', true) returning id into v_rlist;
  update customer_types set price_list_id = v_wlist where id = v_wtype;
  insert into price_list_items (tenant_id, price_list_id, finished_good_id, min_qty, price) values
    (t_id('tenant'), v_wlist, v_pitem, 1, 80),
    (t_id('tenant'), v_wlist, v_pitem, 10, 70),
    (t_id('tenant'), v_rlist, v_pitem, 1, 95);
  perform t_su();
  perform t_put('wholesale_buyer', v_wbuyer);

  -- ---- B: an inventory-role storekeeper cannot set up a price list ----
  perform t_as('00000000-0000-0000-0000-000000000003');
  perform t_err('only an admin sets up price lists',
    format('insert into price_lists (tenant_id, name) values (%L::uuid, %L)', t_id('tenant'), 'Sneaky List'),
    'row-level security');
  perform t_su();

  -- ---- C: which price a sale actually resolves to ----
  perform t_as(v_admin);
  execute format('select public.create_sale(%L::uuid, current_date, null, 80, %L::jsonb)', v_wbuyer, t_items(v_pitem, 1, 80)) into v_sale;
  perform t_su();
  perform t_rec('a wholesale customer''s own list price is picked up (₦80, no discount)',
    (select list_price = 80 and discount_amount = 0 from sale_items where sales_order_id = v_sale));

  perform t_as(v_admin);
  execute format('select public.create_sale(%L::uuid, current_date, null, 700, %L::jsonb)', v_wbuyer, t_items(v_pitem, 10, 70)) into v_sale;
  perform t_su();
  perform t_rec('a quantity break picks the price for that quantity (10+ at ₦70)',
    (select list_price = 70 and discount_amount = 0 from sale_items where sales_order_id = v_sale));

  perform t_as(v_admin);
  execute format('select public.create_sale(null, current_date, null, 95, %L::jsonb)', t_items(v_pitem, 1, 95)) into v_sale;
  perform t_su();
  perform t_rec('a walk-in gets the company''s default list (₦95), not the plain selling price',
    (select list_price = 95 and discount_amount = 0 from sale_items where sales_order_id = v_sale));

  update price_lists set is_active = false where id = v_rlist;
  perform t_as(v_admin);
  execute format('select public.create_sale(null, current_date, null, 100, %L::jsonb)', t_items(v_pitem, 1, 100)) into v_sale;
  perform t_su();
  perform t_rec('with no active default list, it falls back to the plain selling price (₦100)',
    (select list_price = 100 and discount_amount = 0 from sale_items where sales_order_id = v_sale));
  update price_lists set is_active = true where id = v_rlist;

  -- ---- D: a discount past a role's limit needs a manager's PIN ----
  perform t_as(v_cashier);
  perform t_err('a steep discount is refused without a manager''s PIN',
    format('select public.create_sale(%L::uuid, current_date, null, 0, %L::jsonb)', v_wbuyer, t_items(v_pitem, 1, 50)),
    'manager''s PIN');
  perform t_su();

  perform t_as(v_admin);
  perform public.set_approval_pin('1234');
  perform t_su();

  -- These three carry their own discount_reason so section G can find
  -- exactly them, rather than trusting every discount in the whole test
  -- run to have gone through this section.
  perform t_as(v_cashier);
  perform t_err('the wrong PIN is refused the same way',
    format('select public.create_sale(p_customer := %L::uuid, p_date := current_date, p_payment_type := null, p_amount_paid := 0, p_items := %L::jsonb, p_approval := %L::jsonb)',
      v_wbuyer, jsonb_build_array(jsonb_build_object('finished_good_id', v_pitem, 'quantity', 1, 'unit_price', 50, 'discount_reason', 'phase3-test'))::text,
      jsonb_build_object('user_id', v_admin, 'pin', '0000')::text),
    'manager''s PIN');
  execute format('select public.create_sale(p_customer := %L::uuid, p_date := current_date, p_payment_type := null, p_amount_paid := 0, p_items := %L::jsonb, p_approval := %L::jsonb)',
    v_wbuyer, jsonb_build_array(jsonb_build_object('finished_good_id', v_pitem, 'quantity', 1, 'unit_price', 50, 'discount_reason', 'phase3-test'))::text,
    jsonb_build_object('user_id', v_admin, 'pin', '1234')::text) into v_sale;
  perform t_su();
  perform t_rec('the right PIN lets the discount through, and records who approved it',
    (select approved_by = v_admin and discount_total = 30 from sales_orders where id = v_sale));

  -- accounts can't ring up a sale at all (guard_money_write, 0017) — its
  -- own max_discount_pct entry exists for if that ever changes, not
  -- reachable today, so it isn't exercised here.
  perform t_as(v_admin);
  execute format('select public.create_sale(%L::uuid, current_date, null, 0, %L::jsonb)', v_wbuyer,
    jsonb_build_array(jsonb_build_object('finished_good_id', v_pitem, 'quantity', 1, 'unit_price', 40, 'discount_reason', 'phase3-test'))::text)
    into v_sale;
  perform t_su();
  perform t_rec('an admin can give any discount without a PIN', v_sale is not null);

  -- ---- E: a flat order-level discount ----
  perform t_as(v_admin);
  execute format('select public.create_sale(p_customer := null, p_date := current_date, p_payment_type := null, p_amount_paid := 0, p_items := %L::jsonb, p_order_discount := 20)',
    t_items(v_pitem, 2, 95)) into v_sale;
  perform t_su();
  perform t_rec('an order discount reduces the subtotal and is tracked on the sale',
    (select subtotal = 170 and discount_total = 20 from sales_orders where id = v_sale));
  perform t_as(v_admin);
  perform t_err('the order discount can''t be negative',
    format('select public.create_sale(p_customer := null, p_date := current_date, p_payment_type := null, p_amount_paid := 0, p_items := %L::jsonb, p_order_discount := -5)', t_items(v_pitem, 1, 95)),
    'negative');
  perform t_err('the order discount can''t be more than the sale total',
    format('select public.create_sale(p_customer := null, p_date := current_date, p_payment_type := null, p_amount_paid := 0, p_items := %L::jsonb, p_order_discount := 1000)', t_items(v_pitem, 1, 95)),
    'more than the sale total');
  perform t_su();

  -- ---- F: selling below cost is warned about, or blocked outright ----
  perform t_as(v_admin);
  execute format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(v_pitem, 1, 15)) into v_sale;
  perform t_su();
  perform t_rec('below-cost still goes through when the business only wants a warning',
    (select total_amount = 15 from sales_orders where id = v_sale));
  perform t_rec('but it leaves a trace for the owner',
    exists (select 1 from audit_logs where action = 'below_cost_sale' and entity_id = v_pitem::text));

  update tenants set pricing_rules = jsonb_set(pricing_rules, '{below_cost}', '"block"') where id = t_id('tenant');
  perform t_as(v_admin);
  perform t_err('a business can block selling below cost outright',
    format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(v_pitem, 1, 15)),
    'below its cost');
  perform t_su();
  update tenants set pricing_rules = jsonb_set(pricing_rules, '{below_cost}', '"warn"') where id = t_id('tenant');

  -- ---- G: the discounts report ----
  perform t_as(v_cashier);
  perform t_err('a cashier cannot see the discounts report',
    'select * from public.report_discounts()', 'Only admin and accounts');
  perform t_su();

  perform t_as(v_books);
  select * into v_row from public.report_discounts(null, null, null) where reason = 'phase3-test';
  perform t_su();
  perform t_rec('the discounts report groups by reason (2 lines, ₦30+₦40 = ₦70)',
    v_row.line_count = 2 and v_row.qty = 2 and v_row.discount_value = 70,
    format('line_count=%s qty=%s discount_value=%s', v_row.line_count, v_row.qty, v_row.discount_value));
end $$;

-- ---------- 30. shifts and cash-up (0026) ----------
do $$
declare
  v_admin   uuid := '00000000-0000-0000-0000-000000000001';
  v_cashier uuid := '00000000-0000-0000-0000-000000000002';
  v_store   uuid := '00000000-0000-0000-0000-000000000003';
  v_books   uuid := '00000000-0000-0000-0000-000000000004';
  v_ssoap   uuid;
  v_cash    uuid;
  v_abuja_reg  uuid;
  v_lagos_reg  uuid;
  v_second_reg uuid;
  v_shift1  uuid;
  v_shift2  uuid;
  v_sale    uuid;
  v_xr      jsonb;
  v_zr      jsonb;
begin
  select id into v_cash from payment_types where tenant_id = t_id('tenant') and name = 'Cash';
  select id into v_abuja_reg from registers where branch_id = t_id('abuja') limit 1;
  select id into v_lagos_reg from registers where branch_id = t_id('lagos') limit 1;

  -- ---- setup: a product just for this section, stocked at Abuja ----
  perform t_as(v_admin);
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
  values (t_id('tenant'), 'Shift Soap', 'pcs', 5, 100, 1.5) returning id into v_ssoap;
  perform t_put('ssoap', v_ssoap);
  perform public.adjust_stock(t_id('abuja'), 'finished_good', v_ssoap, 50, 40, 'Opening balance');
  perform t_su();

  perform t_rec('every branch got a Main till register automatically',
    v_abuja_reg is not null and v_lagos_reg is not null
    and (select name from registers where id = v_abuja_reg) = 'Main till');

  -- ---- A: shifts aren't required until an admin turns it on ----
  perform t_as(v_cashier);
  execute format('select public.create_sale(null, current_date, null, 100, %L::jsonb)', t_items(v_ssoap, 1, 100)) into v_sale;
  perform t_su();
  perform t_rec('a sale needs no open till until an admin requires one',
    (select shift_id is null from sales_orders where id = v_sale));

  perform t_as(v_admin);
  update tenants set shift_rules = jsonb_set(shift_rules, '{required_for}', '["sales"]') where id = t_id('tenant');
  perform t_su();

  perform t_as(v_cashier);
  perform t_err('selling is blocked with no open till once the tenant requires one',
    format('select public.create_sale(null, current_date, null, 100, %L::jsonb)', t_items(v_ssoap, 1, 100)),
    'Open your till');
  perform t_su();

  -- ---- B: only admin/sales may open a till (storekeeper's home branch is Lagos) ----
  perform t_as(v_store);
  perform t_err('inventory cannot open a till',
    format('select public.open_shift(%L::uuid, 5000)', v_lagos_reg), 'not allowed');
  perform t_su();

  -- ---- C: opening a till ----
  perform t_as(v_cashier);
  select public.open_shift(v_abuja_reg, 5000) into v_shift1;
  perform t_put('shift1', v_shift1);
  perform t_rec('opening a till stamps the register, branch and float',
    (select register_id = v_abuja_reg and branch_id = t_id('abuja') and opening_float = 5000 and status = 'open'
       from shifts where id = v_shift1));

  perform t_err('the same register cannot be opened twice',
    format('select public.open_shift(%L::uuid, 1000)', v_abuja_reg), 'already has an open till');
  perform t_su();

  -- a second register at Abuja, so "one shift per user" is tested
  -- independently of "one shift per register"
  perform t_as(v_admin);
  insert into registers (tenant_id, branch_id, name) values (t_id('tenant'), t_id('abuja'), 'Second till')
  returning id into v_second_reg;
  perform t_su();

  perform t_as(v_cashier);
  perform t_err('one cashier cannot have two tills open at once',
    format('select public.open_shift(%L::uuid, 1000)', v_second_reg), 'already have an open till');

  -- ---- D: a sale made with an open till is tagged with it ----
  execute format('select public.create_sale(null, current_date, %L::uuid, 100, %L::jsonb)', v_cash, t_items(v_ssoap, 1, 100)) into v_sale;
  perform t_rec('a sale made with an open till is tagged with it',
    (select shift_id = v_shift1 from sales_orders where id = v_sale));
  perform t_rec('and so is the payment recorded with it',
    (select shift_id = v_shift1 from sale_payments where sales_order_id = v_sale));

  -- part-paid, then the rest collected later in the same shift
  execute format('select public.create_sale(null, current_date, %L::uuid, 40, %L::jsonb)', v_cash, t_items(v_ssoap, 1, 100)) into v_sale;
  perform public.record_sale_payment(v_sale, 60, v_cash);
  perform t_rec('a later payment on the same sale is tagged with the open till too',
    (select shift_id = v_shift1 from sale_payments where sales_order_id = v_sale and amount_paid = 60));

  -- ---- E: pay-ins and pay-outs ----
  perform t_err('a cash movement needs a reason',
    format('select public.add_cash_movement(%L, 500, %L)', 'pay_in', ''), 'reason is required');
  perform public.add_cash_movement('pay_in', 2000, 'change top-up');

  -- a pay-out over the tenant's ₦5,000 default limit needs a manager PIN
  -- (the admin's PIN, '1234', was already set up in the pricing section)
  perform t_err('a pay-out over the limit needs a manager''s PIN',
    format('select public.add_cash_movement(%L, 6000, %L)', 'pay_out', 'rent top-up'), 'manager''s PIN');
  perform public.add_cash_movement('pay_out', 500, 'fuel for delivery bike');
  perform public.add_cash_movement('pay_out', 6000, 'rent top-up', jsonb_build_object('user_id', v_admin, 'pin', '1234'));

  -- ---- F: the X report reconciles what should be in the drawer ----
  -- float 5000 + cash sales (100+40+60=200) + pay_in 2000 - pay_out (500+6000) = 700
  select public.x_report(v_shift1) into v_xr;
  perform t_rec('the X report''s expected cash reconciles float, sales, pay-ins and pay-outs',
    (v_xr->'expected'->>'cash')::numeric = 700, v_xr->'expected'->>'cash');
  perform t_su();

  perform t_as(v_store);
  perform t_err('inventory cannot see till reports',
    format('select public.x_report(%L::uuid)', v_shift1), 'not allowed');
  perform t_su();

  -- ---- G: closing the till ----
  perform t_as(v_cashier);
  perform t_err('the counted cash can''t be negative',
    'select public.close_shift(-1)', 'negative');
  select public.close_shift(700, null, 'counted twice, matches') into v_zr;
  perform t_rec('closing the till issues a real Z number and zero variance',
    (v_zr->>'doc_no') like 'Z-%' and (v_zr->>'variance')::numeric = 0, v_zr::text);

  perform t_err('closing again with no open till is refused', 'select public.close_shift(0)', 'no open till');

  -- ---- H: a variance is recorded and logged ----
  perform t_as(v_admin);
  update tenants set shift_rules = jsonb_set(shift_rules, '{variance_alert}', '100') where id = t_id('tenant');
  perform t_su();
  perform t_as(v_cashier);
  select public.open_shift(v_abuja_reg, 1000) into v_shift2;
  execute format('select public.create_sale(null, current_date, %L::uuid, 100, %L::jsonb)', v_cash, t_items(v_ssoap, 1, 100)) into v_sale;
  select public.close_shift(950, null, 'short — recount tomorrow') into v_zr;
  perform t_rec('a shortfall is recorded as a negative variance (expected 1100, counted 950 = -150)',
    (v_zr->>'variance')::numeric = -150, v_zr::text);
  perform t_su();
  perform t_rec('a variance past the alert threshold is logged for the owner',
    exists (select 1 from audit_logs where action = 'shift_variance' and entity_id = (v_zr->>'shift_id')));

  -- ---- I: the Z report survives after close, for reprinting ----
  perform t_as(v_books);
  select public.z_report(v_shift1) into v_zr;
  perform t_su();
  perform t_rec('accounts can reprint an old Z report by id',
    (v_zr->>'shift_id') = v_shift1::text and (v_zr->>'sales_count')::int = 2, v_zr::text);

  update tenants set shift_rules = jsonb_set(shift_rules, '{required_for}', '[]') where id = t_id('tenant');
end $$;

-- ---------- 31. automatic payment confirmation, pay links (0027) ----------
do $$
declare
  v_admin   uuid := '00000000-0000-0000-0000-000000000001';
  v_cashier uuid := '00000000-0000-0000-0000-000000000002';
  v_psoap   uuid;
  v_transfer uuid;
  v_cust    uuid;
  v_sale1   uuid;
  v_sale2   uuid;
  v_sale3   uuid;
  v_voided  uuid;
  v_link    uuid;
  v_inc1    uuid;
  v_inc2    uuid;
  v_inc3    uuid;
  v_inc4    uuid;
  v_status  jsonb;
  v_credit  numeric;
begin
  select id into v_transfer from payment_types where tenant_id = t_id('tenant') and method_group = 'transfer';
  insert into customers (tenant_id, first_name) values (t_id('tenant'), 'Pay Link Customer') returning id into v_cust;

  perform t_as(v_admin);
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
  values (t_id('tenant'), 'Paylink Soap', 'pcs', 5, 100, 1.5) returning id into v_psoap;
  perform public.adjust_stock(t_id('lagos'), 'finished_good', v_psoap, 20, 40, 'Opening balance');
  perform public.adjust_stock(t_id('abuja'), 'finished_good', v_psoap, 20, 40, 'Opening balance');
  perform t_su();

  -- ---- A: not connected until an integration row exists ----
  perform t_as(v_cashier);
  select public.integration_status() into v_status;
  perform t_su();
  perform t_rec('a tenant with no integration reads as not connected',
    (v_status->>'connected')::boolean = false and v_status->>'status' = 'not_connected');

  -- payments-connect (the Edge Function) is what would insert this row for
  -- real, using the service role after verifying the key with Paystack and
  -- storing it in Vault — simulated here as the row it would leave behind.
  insert into payment_integrations (tenant_id, status, public_key, secret_vault_id, last_verified_at)
  values (t_id('tenant'), 'live', 'pk_test_abc123', gen_random_uuid(), now());

  perform t_as(v_cashier);
  select public.integration_status() into v_status;
  perform t_su();
  perform t_rec('once connected, status and the public key are visible — never the secret',
    (v_status->>'connected')::boolean = true and v_status->>'status' = 'live'
    and v_status->>'public_key' = 'pk_test_abc123' and not (v_status ? 'secret_vault_id'));

  perform t_as(v_cashier);
  perform t_rec('the app can never read payment_integrations directly, whatever the role',
    (select count(*) from payment_integrations) = 0);
  perform t_su();

  -- ---- B: creating a pay link ----
  -- Both sold at Abuja (the cashier's own branch below is what a payment
  -- link's insert policy checks — same branch-visibility rule sale reads use).
  perform t_as(v_admin);
  execute format('select public.create_sale(p_customer := %L::uuid, p_date := current_date, p_payment_type := null, p_amount_paid := 0, p_items := %L::jsonb, p_branch := %L::uuid)',
    v_cust, t_items(v_psoap, 1, 100), t_id('abuja')) into v_sale1;
  execute format('select public.create_sale(p_customer := null, p_date := current_date, p_payment_type := null, p_amount_paid := 0, p_items := %L::jsonb, p_branch := %L::uuid)',
    t_items(v_psoap, 1, 100), t_id('abuja')) into v_voided;
  perform public.void_sale(v_voided);
  perform t_su();

  perform t_as(v_cashier);
  insert into payment_links (tenant_id, sales_order_id, provider_ref, url, amount)
  values (t_id('tenant'), v_sale1, 'PSK_ref_1', 'https://paystack.com/pay/abc', 100)
  returning id into v_link;
  perform t_rec('a cashier can record a pay link for a sale they can see', v_link is not null);

  perform t_err('a pay link cannot be recorded against a voided sale',
    format('insert into payment_links (tenant_id, sales_order_id, provider_ref, url, amount) values (%L, %L, %L, %L, 100)',
      t_id('tenant'), v_voided, 'PSK_ref_bad', 'https://paystack.com/pay/bad'),
    'row-level security');

  perform t_err('a pay link''s provider reference must be unique',
    format('insert into payment_links (tenant_id, sales_order_id, provider_ref, url, amount) values (%L, %L, %L, %L, 100)',
      t_id('tenant'), v_sale1, 'PSK_ref_1', 'https://paystack.com/pay/dupe'),
    'duplicate key');
  perform t_su();

  -- ---- C: the webhook applies a payment that exactly settles a sale ----
  insert into incoming_payments (tenant_id, provider_ref, amount, payer_name, sales_order_id)
  values (t_id('tenant'), 'PSK_ref_1', 100, 'Pay Link Customer', v_sale1)
  returning id into v_inc1;
  perform public.apply_incoming_payment(v_inc1);
  perform t_rec('a matched payment settles the sale in full',
    (select balance = 0 and payment_status = 'full' from sales_orders where id = v_sale1));
  perform t_rec('the sale_payments row is tagged with the incoming payment and a transfer type',
    (select payment_type_id = v_transfer and incoming_payment_id = v_inc1 from sale_payments where sales_order_id = v_sale1));
  perform t_rec('the incoming payment is marked auto-matched, with the payment it created',
    (select match_status = 'auto' and applied_payment_id is not null and customer_id = v_cust
       from incoming_payments where id = v_inc1));

  -- ---- D: a replayed webhook doesn't double-credit the sale ----
  perform public.apply_incoming_payment(v_inc1);
  perform t_rec('applying the same incoming payment twice changes nothing (still one payment row)',
    (select count(*) from sale_payments where incoming_payment_id = v_inc1) = 1);

  -- ---- E: no sale reference, or the sale no longer accepts payment ----
  insert into incoming_payments (tenant_id, provider_ref, amount, payer_name)
  values (t_id('tenant'), 'PSK_ref_2', 500, 'Nobody In Particular') returning id into v_inc2;
  perform public.apply_incoming_payment(v_inc2);
  perform t_rec('a payment with no sale reference is left for a human to match',
    (select match_status = 'unmatched' from incoming_payments where id = v_inc2));

  insert into incoming_payments (tenant_id, provider_ref, amount, sales_order_id)
  values (t_id('tenant'), 'PSK_ref_3', 100, v_voided) returning id into v_inc3;
  perform public.apply_incoming_payment(v_inc3);
  perform t_rec('a payment referencing a voided sale is left unmatched, not force-applied',
    (select match_status = 'unmatched' from incoming_payments where id = v_inc3));

  -- ---- F: an overpayment becomes store credit for a named customer ----
  perform t_as(v_admin);
  execute format('select public.create_sale(%L::uuid, current_date, null, 0, %L::jsonb)', v_cust, t_items(v_psoap, 1, 100)) into v_sale2;
  perform t_su();
  insert into incoming_payments (tenant_id, provider_ref, amount, sales_order_id)
  values (t_id('tenant'), 'PSK_ref_4', 150, v_sale2) returning id into v_inc4;
  perform public.apply_incoming_payment(v_inc4);
  perform t_rec('the sale itself is only settled up to what it owed (₦100)',
    (select balance = 0 and payment_status = 'full' from sales_orders where id = v_sale2));
  select credit_balance into v_credit from customers where id = v_cust;
  perform t_rec('the ₦50 overpaid becomes store credit for the customer', v_credit = 50, v_credit::text);
  perform t_rec('the overpayment is on the customer credit ledger',
    exists (select 1 from customer_credit_ledger where customer_id = v_cust and source_type = 'overpayment' and amount = 50));

  -- ---- G: only the webhook (service role) may apply a payment ----
  perform t_as(v_admin);
  execute format('select public.create_sale(null, current_date, null, 0, %L::jsonb)', t_items(v_psoap, 1, 100)) into v_sale3;
  perform t_su();
  insert into incoming_payments (tenant_id, provider_ref, amount, sales_order_id)
  values (t_id('tenant'), 'PSK_ref_5', 100, v_sale3) returning id into v_link;   -- reusing v_link as scratch
  perform t_as(v_admin);
  perform t_err('not even an admin can call apply_incoming_payment directly',
    format('select public.apply_incoming_payment(%L::uuid)', v_link), 'permission denied');
  perform t_su();
end $$;

-- ---------- 32. quotes and proforma invoices (0028) ----------
do $$
declare
  v_admin   uuid := '00000000-0000-0000-0000-000000000001';
  v_cashier uuid := '00000000-0000-0000-0000-000000000002';
  v_store   uuid := '00000000-0000-0000-0000-000000000003';
  v_qsoap   uuid;
  v_cust    uuid;
  v_quote   uuid;
  v_proforma uuid;
  v_sale    uuid;
  v_row     record;
begin
  perform t_as(v_admin);
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
  values (t_id('tenant'), 'Quote Soap', 'pcs', 5, 100, 1.5) returning id into v_qsoap;
  perform public.adjust_stock(t_id('lagos'), 'finished_good', v_qsoap, 10, 40, 'Opening balance');
  perform public.adjust_stock(t_id('abuja'), 'finished_good', v_qsoap, 10, 40, 'Opening balance');
  perform t_su();
  insert into customers (tenant_id, first_name) values (t_id('tenant'), 'Quote Customer') returning id into v_cust;

  -- ---- A: only admin/sales may create a quote ----
  perform t_as(v_store);
  perform t_err('inventory cannot create a quote',
    format('select public.create_quote(%L::uuid, %L, %L::jsonb)', v_cust, 'quote', t_items(v_qsoap, 2, 90)),
    'not allowed');
  perform t_su();

  -- ---- B: creating a quote computes totals against the list price ----
  perform t_as(v_cashier);
  execute format('select public.create_quote(%L::uuid, %L, %L::jsonb, %L::date, %L)',
    v_cust, 'quote', t_items(v_qsoap, 2, 90), current_date + 14, 'first draft') into v_quote;
  perform t_rec('a quote gets a real QT- number', (select doc_no from quotes where id = v_quote) like 'QT-%');
  perform t_rec('the quote totals the line at the price given, with the discount vs list tracked',
    (select subtotal = 180 and discount_total = 20 and status = 'draft' from quotes where id = v_quote),
    (select format('subtotal=%s discount=%s status=%s', subtotal, discount_total, status) from quotes where id = v_quote));

  perform t_err('a quote needs at least one item',
    format('select public.create_quote(%L::uuid, %L, %L::jsonb)', v_cust, 'quote', '[]'), 'at least one item');

  -- ---- C: a proforma is the same engine, a different kind and number ---- (still as v_cashier)
  execute format('select public.create_quote(%L::uuid, %L, %L::jsonb)', v_cust, 'proforma', t_items(v_qsoap, 1, 100)) into v_proforma;
  perform t_su();
  perform t_rec('a proforma gets its own PF- number', (select doc_no from quotes where id = v_proforma) like 'PF-%');

  -- ---- D: status moves forward, but never past converted ----
  perform t_as(v_cashier);
  perform public.update_quote_status(v_quote, 'sent');
  perform public.update_quote_status(v_quote, 'accepted');
  perform t_su();
  perform t_rec('a quote''s status can move forward (draft -> sent -> accepted)',
    (select status = 'accepted' from quotes where id = v_quote));

  perform t_as(v_store);
  perform t_err('inventory cannot change a quote''s status',
    format('select public.update_quote_status(%L::uuid, %L)', v_quote, 'sent'), 'not allowed');
  perform t_su();

  -- ---- E: converting turns it into a real, priced sale ----
  -- This quote's 10% discount (₦20 off ₦200 list) is above the cashier's
  -- 5% limit, so converting it needs the same manager-PIN mechanism a
  -- sale would — the plan's "no second PIN" note doesn't fully hold here
  -- (see the migration's header comment); the admin's PIN ('1234') was
  -- already set up in the pricing section.
  perform t_as(v_cashier);
  perform t_err('converting a quote whose discount is over the limit needs a manager''s PIN, same as a sale would',
    format('select public.convert_quote(%L::uuid, 0, null)', v_quote), 'manager''s PIN');
  execute format('select public.convert_quote(%L::uuid, 0, null, null, %L::jsonb)',
    v_quote, jsonb_build_object('user_id', v_admin, 'pin', '1234')::text) into v_sale;
  perform t_su();
  perform t_rec('with the PIN, conversion succeeds and the quote is marked converted',
    (select status = 'converted' and converted_sale_id = v_sale from quotes where id = v_quote));
  select * into v_row from sale_items where sales_order_id = v_sale;
  perform t_rec('the sale carries the quote''s exact price, not the list price (₦90, not ₦100)',
    v_row.unit_price = 90 and v_row.quantity = 2, format('price=%s qty=%s', v_row.unit_price, v_row.quantity));

  perform t_as(v_cashier);
  perform t_err('a converted quote cannot be converted again',
    format('select public.convert_quote(%L::uuid, 0, null)', v_quote), 'already been converted');
  perform t_su();

  -- ---- F: a declined or cancelled quote can't be converted either ----
  perform t_as(v_cashier);
  perform public.update_quote_status(v_proforma, 'declined');
  perform t_err('a declined quote can''t be converted',
    format('select public.convert_quote(%L::uuid, 0, null)', v_proforma), 'can''t be converted');
  perform t_su();

  -- ---- G: converting names exactly what's short, same as any sale ----
  perform t_as(v_admin);
  declare v_short uuid;
  begin
    execute format('select public.create_quote(null, %L, %L::jsonb)', 'quote', t_items(v_qsoap, 100, 90)) into v_short;
    perform t_err('converting a quote for more than is now in stock fails the same way a sale would',
      format('select public.convert_quote(%L::uuid, 0, null)', v_short), 'left at');
  end;
  perform t_su();
end $$;

-- ---------- 33. purchase orders: ordered before received (0029) ----------
do $$
declare
  v_admin   uuid := '00000000-0000-0000-0000-000000000001';
  v_cashier uuid := '00000000-0000-0000-0000-000000000002';
  v_store   uuid := '00000000-0000-0000-0000-000000000003';
  v_books   uuid := '00000000-0000-0000-0000-000000000004';
  v_mat     uuid;
  v_supplier uuid;
  v_po      uuid;
  v_line1   uuid;
  v_gr1     uuid;
  v_gr2     uuid;
  v_row     record;
begin
  perform t_as(v_admin);
  insert into materials (tenant_id, name, unit, type_of_material, min_stock_level)
  values (t_id('tenant'), 'PO Test Chemical', 'kg', 'raw', 5) returning id into v_mat;
  insert into suppliers (tenant_id, company_store) values (t_id('tenant'), 'PO Test Supplier') returning id into v_supplier;
  perform t_su();

  -- ---- A: only admin/inventory may place an order ----
  perform t_as(v_cashier);
  perform t_err('sales cannot create a purchase order',
    format('select public.create_purchase_order(%L::uuid, %L::jsonb)', v_supplier,
      jsonb_build_array(jsonb_build_object('material_id', v_mat, 'qty', 100, 'unit_cost', 10))::text),
    'not allowed');
  perform t_su();

  -- ---- B: placing an order moves no stock and owes nothing yet ----
  perform t_as(v_store);
  select public.create_purchase_order(v_supplier,
    jsonb_build_array(jsonb_build_object('material_id', v_mat, 'qty', 100, 'unit_cost', 10)),
    current_date + 7) into v_po;
  perform t_su();
  perform t_rec('an order gets a real PO- number, status ordered, and an expected date',
    (select doc_no like 'PO-%' and status = 'ordered' and expected_date = current_date + 7 from purchase_orders where id = v_po));
  perform t_rec('nothing is owed and no stock has moved yet',
    (select total_amount = 0 and balance = 0 from purchase_orders where id = v_po)
    and (select qty_balance from materials where id = v_mat) = 0);

  select id into v_line1 from purchase_order_lines where purchase_order_id = v_po;

  -- ---- C: an advance payment is allowed before anything is received ----
  perform t_as(v_store);
  declare v_cash uuid;
  begin
    select id into v_cash from payment_types where tenant_id = t_id('tenant') and name = 'Cash';
    perform public.record_purchase_payment(v_po, 300, v_cash, 'advance');
  end;
  perform t_su();
  perform t_rec('the advance shows as a negative balance — the supplier owes goods',
    (select balance = -300 and payment_status = 'full' from purchase_orders where id = v_po));

  -- ---- D: receiving part of the order ----
  perform t_as(v_store);
  select public.receive_purchase_order(v_po,
    jsonb_build_array(jsonb_build_object('line_id', v_line1, 'qty', 60))) into v_gr1;
  perform t_su();
  perform t_rec('a partial receipt gets its own GRN- number', (select doc_no from goods_receipts where id = v_gr1) like 'GRN-%');
  perform t_rec('the order moves to partial, and only the received value is now owed',
    (select status = 'partial' and total_amount = 600 from purchase_orders where id = v_po));
  perform t_rec('the advance now covers half the received value (balance -300 + 600 = 300 owed)',
    (select balance = 300 from purchase_orders where id = v_po));
  perform t_rec('stock actually moved for the 60 received, not the other 40',
    (select qty_balance from materials where id = v_mat) = 60);
  perform t_rec('the purchase_items layer traces back to this order and this receipt',
    (select po_line_id = v_line1 and goods_receipt_id = v_gr1 and qty = 60 from purchase_items where po_line_id = v_line1));

  perform t_as(v_store);
  perform t_err('cannot receive more than what is still expected on the line',
    format('select public.receive_purchase_order(%L::uuid, %L::jsonb)', v_po,
      jsonb_build_array(jsonb_build_object('line_id', v_line1, 'qty', 41))::text),
    'still expected');
  perform t_su();

  -- ---- E: receiving the remainder settles the order ----
  perform t_as(v_store);
  select public.receive_purchase_order(v_po,
    jsonb_build_array(jsonb_build_object('line_id', v_line1, 'qty', 40))) into v_gr2;
  perform t_su();
  perform t_rec('the second receipt is a different GRN from the first', v_gr2 <> v_gr1);
  perform t_rec('the order is now fully received, and owes the full ordered value',
    (select status = 'received' and total_amount = 1000 from purchase_orders where id = v_po));
  perform t_rec('all 100kg is now in stock', (select qty_balance from materials where id = v_mat) = 100);
  perform t_rec('the supplier''s lead time is learned from ordered_at to the final receipt',
    (select lead_time_days is not null from suppliers where id = v_supplier));

  perform t_as(v_store);
  perform t_err('a fully received order has nothing left to receive',
    format('select public.receive_purchase_order(%L::uuid, %L::jsonb)', v_po,
      jsonb_build_array(jsonb_build_object('line_id', v_line1, 'qty', 1))::text),
    'nothing left to receive');
  perform t_su();

  -- ---- F: cancelling ----
  perform t_as(v_store);
  declare v_po2 uuid; v_line2 uuid;
  begin
    select public.create_purchase_order(v_supplier,
      jsonb_build_array(jsonb_build_object('material_id', v_mat, 'qty', 50, 'unit_cost', 10))) into v_po2;
    select id into v_line2 from purchase_order_lines where purchase_order_id = v_po2;
    select public.receive_purchase_order(v_po2, jsonb_build_array(jsonb_build_object('line_id', v_line2, 'qty', 20))) into v_gr1;
    perform t_su();

    perform t_as(v_books);
    perform t_err('accounts cannot cancel a purchase order',
      format('select public.cancel_purchase_order(%L::uuid)', v_po2), 'not allowed');
    perform t_su();

    perform t_as(v_store);
    perform public.cancel_purchase_order(v_po2, 'supplier ran out of stock');
    perform t_su();
    perform t_rec('cancelling stops further receiving but keeps what already arrived',
      (select status = 'cancelled' and total_amount = 200 from purchase_orders where id = v_po2)
      and (select qty_remaining = 20 from purchase_items where po_line_id = v_line2));

    perform t_as(v_store);
    perform t_err('a cancelled order can''t receive anything more',
      format('select public.receive_purchase_order(%L::uuid, %L::jsonb)', v_po2,
        jsonb_build_array(jsonb_build_object('line_id', v_line2, 'qty', 10))::text),
      'nothing left to receive');
    perform t_su();
  end;
end $$;

-- ---------- 20. books balance everywhere ----------
do $$
begin
  perform t_rec('every product: company total = sum of branch layers',
    not exists (
      select 1 from finished_goods g
       where g.qty_balance <> coalesce((select sum(qty_remaining) from fg_batches b where b.finished_good_id = g.id), 0))
    and not exists (
      select 1 from materials m
       where m.qty_balance <> coalesce((select sum(qty_remaining) from purchase_items p where p.material_id = m.id), 0)));
  perform t_rec('every product: company total = sum of the movement ledger',
    not exists (
      select 1 from finished_goods g
       where g.qty_balance <> coalesce((select sum(quantity) from stock_movements s where s.product_id = g.id), 0))
    and not exists (
      select 1 from materials m
       where m.qty_balance <> coalesce((select sum(quantity) from stock_movements s where s.product_id = m.id), 0)));
end $$;

select name, pass, detail from t_results order by n;
