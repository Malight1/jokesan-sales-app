-- ============================================================
-- StockFlow — retail demo data seed. NOT a migration — run this ONCE,
-- by hand, in the Supabase SQL editor, strictly AFTER 0045-0047 have
-- been applied.
--
-- Prerequisite: create the demo account the normal way first —
--   1. Go to /login?signup=1
--   2. Full name / company name: anything, e.g. "Demo Retail Shop"
--   3. "What kind of business is this?" -> I buy and resell stock
--   4. Email: demo.retail@stockflow.test (or change V_ADMIN_EMAIL below
--      to whatever you used), pick any password, sign up, confirm the
--      email if your project requires it.
-- This script cannot create that account itself — Supabase Auth users
-- need to go through the real signup flow (password hashing, email
-- confirmation, etc.), not a raw SQL insert.
--
-- What this seeds, all against that one tenant: a supplier, 8 everyday
-- retail products, one purchase order that stocks all of them, and ten
-- days of POS sales — enough for every panel on the retail dashboard
-- (takings, stock value, running out, best sellers, dead stock, debtors)
-- to have something real to show. One product (the imported wine) is
-- bought but deliberately never sold, so "Sitting on the shelf" has
-- something in it; one sale is left partly unpaid and backdated, so
-- "Who owes you" does too.
--
-- Safe to run only ONCE per tenant — running it twice creates a second
-- copy of everything (a second supplier, doubled stock, etc.), since
-- it's plain demo data, not a migration with guards.
-- ============================================================

do $$
declare
  v_admin_email text := 'demo.retail@stockflow.test'; -- <-- change if you signed up with a different email
  v_admin       uuid;
  v_tenant      uuid;
  v_paytype     uuid;
  v_supplier    uuid;
  v_customer    uuid;

  v_coke   uuid; v_water  uuid; v_indomie uuid; v_milk uuid;
  v_bread  uuid; v_rice   uuid; v_soap    uuid; v_wine uuid;

  today date := current_date;
begin
  select id into v_admin from auth.users where email = v_admin_email;
  if v_admin is null then
    raise exception 'No account found for %. Sign up at /login?signup=1 first (pick "I buy and resell stock"), then re-run this with that email in V_ADMIN_EMAIL.', v_admin_email;
  end if;

  -- Everything below runs "as" that admin, the same way the real app
  -- would call these RPCs — current_tenant_id()/current_role() both
  -- read auth.uid(), which reads this session setting.
  perform set_config('request.jwt.claim.sub', v_admin::text, false);

  select tenant_id into v_tenant from profiles where id = v_admin;
  if v_tenant is null then raise exception 'Account % has no tenant yet — something went wrong at signup.', v_admin_email; end if;
  if (select business_type from tenants where id = v_tenant) is distinct from 'retail' then
    raise exception 'Tenant % is not business_type = retail. Either sign up with "I buy and resell stock", or change it from Platform Admin > Tenants > (this tenant) > Change Business Type first.', v_tenant;
  end if;

  select id into v_paytype from payment_types where tenant_id = v_tenant and name = 'Cash' limit 1;

  -- ---------- products ----------
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
    values (v_tenant, 'Coca-Cola 50cl (crate)', 'crate', 8, 2000, 1.33) returning id into v_coke;
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
    values (v_tenant, 'Pure Water (bag)', 'bag', 30, 200, 1.67) returning id into v_water;
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
    values (v_tenant, 'Indomie Chicken (carton)', 'carton', 6, 4200, 1.24) returning id into v_indomie;
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
    values (v_tenant, 'Peak Milk 400g (carton)', 'carton', 4, 18000, 1.16) returning id into v_milk;
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
    values (v_tenant, 'Agege Bread (loaf)', 'loaf', 10, 1200, 1.33) returning id into v_bread;
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
    values (v_tenant, 'Rice 50kg (bag)', 'bag', 3, 68000, 1.13) returning id into v_rice;
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
    values (v_tenant, 'Dettol Soap 100g (pcs)', 'pcs', 20, 600, 1.43) returning id into v_soap;
  -- Deliberately never sold below, so the dashboard's dead-stock panel has something in it.
  insert into finished_goods (tenant_id, name, unit, min_stock_level, selling_price, default_markup)
    values (v_tenant, 'Imported Sparkling Wine (pcs)', 'pcs', 3, 12000, 1.41) returning id into v_wine;

  -- ---------- supplier + opening stock (one Quick Purchase, all 8 lines) ----------
  insert into suppliers (tenant_id, company_store, phone) values (v_tenant, 'Lagos Wholesale Mart', '08011112222') returning id into v_supplier;

  perform public.create_purchase(v_supplier, today - 14, v_paytype, 745000, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_coke,    'qty', 50,  'cost_price', 1500),
    jsonb_build_object('finished_good_id', v_water,   'qty', 100, 'cost_price', 120),
    jsonb_build_object('finished_good_id', v_indomie, 'qty', 15,  'cost_price', 3400),
    jsonb_build_object('finished_good_id', v_milk,    'qty', 10,  'cost_price', 15500),
    jsonb_build_object('finished_good_id', v_bread,   'qty', 30,  'cost_price', 900),
    jsonb_build_object('finished_good_id', v_rice,    'qty', 5,   'cost_price', 60000),
    jsonb_build_object('finished_good_id', v_soap,    'qty', 80,  'cost_price', 420),
    jsonb_build_object('finished_good_id', v_wine,    'qty', 12,  'cost_price', 8500)
  ));
  -- 50 crates of Coke covers every sale below with room to spare (38 sold
  -- across the demo period) without also tripping its own reorder alert.
  -- 745,000 of the 755,600 total is paid, leaving a small realistic amount owed to the supplier.

  -- ---------- a customer left on credit (aging debtor panel) ----------
  -- dashboard_summary()'s reminders only surface a debt 14+ days old
  -- (the app's own overdue threshold) -- 15 days clears that comfortably.
  insert into customers (tenant_id, company_store, phone) values (v_tenant, 'Blessing Catering Services', '08033445566') returning id into v_customer;
  perform public.create_sale(v_customer, today - 15, v_paytype, 40000, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_rice, 'quantity', 1,  'unit_price', 68000),
    jsonb_build_object('finished_good_id', v_coke, 'quantity', 10, 'unit_price', 2000)
  ));
  -- Total 88,000; paid 40,000 -> 48,000 left owing, 15 days ago.

  -- ---------- ten days of walk-in POS sales (takings, best sellers, week trend) ----------
  perform public.create_sale(null, today - 9, v_paytype, 14000, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_coke,  'quantity', 5,  'unit_price', 2000),
    jsonb_build_object('finished_good_id', v_water, 'quantity', 20, 'unit_price', 200)
  ));
  perform public.create_sale(null, today - 8, v_paytype, 18600, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_indomie, 'quantity', 3,  'unit_price', 4200),
    jsonb_build_object('finished_good_id', v_soap,    'quantity', 10, 'unit_price', 600)
  ));
  perform public.create_sale(null, today - 7, v_paytype, 9600, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_bread, 'quantity', 8, 'unit_price', 1200)
  ));
  perform public.create_sale(null, today - 6, v_paytype, 15000, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_coke,  'quantity', 6,  'unit_price', 2000),
    jsonb_build_object('finished_good_id', v_water, 'quantity', 15, 'unit_price', 200)
  ));
  -- today - 5 is deliberately closed: no sale, so the 7-day chart shows a real quiet day.
  perform public.create_sale(null, today - 4, v_paytype, 24000, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_indomie, 'quantity', 4,  'unit_price', 4200),
    jsonb_build_object('finished_good_id', v_soap,    'quantity', 12, 'unit_price', 600)
  ));
  perform public.create_sale(null, today - 3, v_paytype, 30000, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_bread, 'quantity', 10, 'unit_price', 1200),
    jsonb_build_object('finished_good_id', v_milk,  'quantity', 1,  'unit_price', 18000)
  ));
  perform public.create_sale(null, today - 2, v_paytype, 26000, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_coke,  'quantity', 10, 'unit_price', 2000),
    jsonb_build_object('finished_good_id', v_water, 'quantity', 30, 'unit_price', 200)
  ));
  perform public.create_sale(null, today - 1, v_paytype, 33000, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_soap,    'quantity', 20, 'unit_price', 600),
    jsonb_build_object('finished_good_id', v_indomie, 'quantity', 5,  'unit_price', 4200)
  ));
  perform public.create_sale(null, today, v_paytype, 23200, jsonb_build_array(
    jsonb_build_object('finished_good_id', v_coke,  'quantity', 7,  'unit_price', 2000),
    jsonb_build_object('finished_good_id', v_bread, 'quantity', 6,  'unit_price', 1200),
    jsonb_build_object('finished_good_id', v_water, 'quantity', 10, 'unit_price', 200)
  ));

  raise notice 'Seeded retail demo data for tenant % (admin %).', v_tenant, v_admin_email;
end $$;
