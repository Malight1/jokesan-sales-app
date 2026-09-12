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
