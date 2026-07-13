-- ============================================================
-- StockFlow — Demo business data (ADMIN-ONLY, single account)
-- Generates ~4 months of realistic history for ONE specific
-- account by calling the REAL engine functions, so every number
-- (FIFO costs, COGS, profit, stock, debtors) is consistent.
--
-- ⚠️ NOT callable from the app. No UI button. Run only by you,
--    in the Supabase SQL Editor:
--
--    1) Run this whole file once (creates the function)
--    2) Then run:  select public.seed_demo_data_for('oguntunde123@gmail.com');
--
-- The account must already exist (signed up + confirmed in the app).
-- Run AFTER 0001–0005.
-- ============================================================

-- Remove any previous app-callable version
drop function if exists public.seed_demo_data();

create or replace function public.seed_demo_data_for(p_email text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_tenant uuid;
  v_sales_count int;
  v_supplier uuid;
  v_paytypes uuid[];
  v_pay uuid;
  v_custs uuid[];
  v_cust uuid;
  v_mat record;
  v_prod record;
  v_bom record;
  v_month int;
  v_base date;
  v_day date;
  v_items jsonb;
  v_prod_items jsonb;
  v_total numeric;
  v_paid numeric;
  v_sale uuid;
  v_qty numeric;
  v_price numeric;
  v_r numeric;
  i int;
  v_factor numeric;
begin
  -- ---- resolve the target account ----
  select id into v_user from auth.users where email = lower(p_email);
  if v_user is null then
    raise exception 'No user with email % — sign that account up in the app first', p_email;
  end if;

  select tenant_id into v_tenant from profiles where id = v_user;
  if v_tenant is null then
    raise exception 'User % has no tenant/profile yet', p_email;
  end if;

  -- Impersonate the user for this transaction so auth.uid() and
  -- current_tenant_id() resolve inside the engine functions.
  perform set_config('request.jwt.claims',
    json_build_object('sub', v_user::text, 'role', 'authenticated')::text, true);
  perform set_config('request.jwt.claim.sub', v_user::text, true);

  select count(*) into v_sales_count from sales_orders where tenant_id = v_tenant;
  if v_sales_count > 25 then
    raise exception 'Demo data already loaded (this account already has % sales)', v_sales_count;
  end if;

  -- ---- ensure master data exists ----
  if not exists (select 1 from materials where tenant_id = v_tenant) then
    perform public.seed_sample_data();
  end if;

  select id into v_supplier from suppliers where tenant_id = v_tenant limit 1;
  if v_supplier is null then
    insert into suppliers(tenant_id, first_name, last_name, company_store, address, phone)
    values (v_tenant, 'Alhaji', 'Musa', 'Musa Chemicals Ltd', 'Idumota Market, Lagos', '08031112222')
    returning id into v_supplier;
  end if;

  select array_agg(id) into v_paytypes from payment_types where tenant_id = v_tenant;

  -- ---- extra demo customers (Nigerian SME flavour) ----
  insert into customers(tenant_id, first_name, last_name, company_store, address, phone)
  select v_tenant, c.fn, c.ln, c.store, c.addr, c.ph
  from (values
    ('Chidinma','Okafor','Chidinma Cosmetics','12 Aba Road, Port Harcourt','08033334444'),
    ('Nkechi','Eze','Mama Nkechi Supermart','45 Ogui Road, Enugu','08055556666'),
    ('Ibrahim','Danladi','Kano Traders Co','Kantin Kwari Market, Kano','08077778888'),
    ('Funke','Adeyemi','De-Luxe Hotels','Allen Avenue, Ikeja','08099990000'),
    ('Emeka','Nwosu','Emeka & Sons Distribution','Main Market, Onitsha','08122223333'),
    ('Aisha','Bello','Green Valley Schools','GRA, Ilorin','08144445555'),
    ('Tunde','Bakare','Freshmart Stores','Ring Road, Ibadan','08166667777'),
    ('Grace','Effiong','Grace Beauty World','Marian Road, Calabar','08188889999')
  ) as c(fn, ln, store, addr, ph)
  where not exists (
    select 1 from customers x where x.tenant_id = v_tenant and x.company_store = c.store
  );

  select array_agg(id) into v_custs from customers where tenant_id = v_tenant;

  -- ============================================================
  -- 4 months of history, oldest first (so FIFO flows naturally)
  -- ============================================================
  for v_month in reverse 4..1 loop
    v_base := date_trunc('month', current_date)::date - make_interval(months => v_month);
    -- price inflation month over month (~3%) → FIFO batch costs differ
    v_factor := 1 + (4 - v_month) * 0.03;

    -- ---- monthly stock purchase (all materials, generous qty) ----
    v_items := '[]'::jsonb;
    for v_mat in select id, name from materials where tenant_id = v_tenant loop
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'material_id', v_mat.id,
        'qty', case
          when v_mat.name ilike '%water%'     then 400
          when v_mat.name ilike '%bottle%'    then 400
          when v_mat.name ilike '%label%'     then 400
          when v_mat.name ilike '%fragrance%' then 800
          else 60 end,
        'cost_price', round((case
          when v_mat.name ilike '%caustic%'   then 1500
          when v_mat.name ilike '%kernel%'    then 2200
          when v_mat.name ilike '%lauryl%'    then 3000
          when v_mat.name ilike '%water%'     then 30
          when v_mat.name ilike '%fragrance%' then 120
          when v_mat.name ilike '%bottle%'    then 180
          when v_mat.name ilike '%label%'     then 40
          else 500 end) * v_factor, 2)
      ));
    end loop;

    v_pay := v_paytypes[1 + floor(random() * array_length(v_paytypes, 1))::int % array_length(v_paytypes, 1)];
    -- purchases mostly fully paid; month 2 part-paid (shows a creditor)
    perform public.create_purchase(
      v_supplier, v_base + 2, v_pay,
      case when v_month = 2 then 150000 else 10000000 end,
      v_items
    );

    -- ---- production: 2 runs per product per month ----
    for v_prod in select id from finished_goods where tenant_id = v_tenant loop
      for i in 1..2 loop
        select b.id, b.yield_qty into v_bom
          from boms b where b.tenant_id = v_tenant and b.finished_good_id = v_prod.id limit 1;
        if v_bom.id is null then continue; end if;

        v_prod_items := '[]'::jsonb;
        for v_mat in
          select material_id, quantity from bom_items where bom_id = v_bom.id and tenant_id = v_tenant
        loop
          v_prod_items := v_prod_items || jsonb_build_array(jsonb_build_object(
            'material_id', v_mat.material_id,
            'qty', round(v_mat.quantity * (50.0 / v_bom.yield_qty), 3)
          ));
        end loop;

        perform public.record_production(
          v_prod.id, v_base + 4 + (i * 12), round((3000 + random() * 5000)::numeric, 2), 50, v_prod_items
        );
      end loop;
    end loop;

    -- ---- sales: ~14 per month, varied customers/qty/payment ----
    for i in 1..14 loop
      v_day := v_base + 3 + floor(random() * 24)::int;
      v_cust := v_custs[1 + floor(random() * array_length(v_custs, 1))::int % array_length(v_custs, 1)];
      v_pay := v_paytypes[1 + floor(random() * array_length(v_paytypes, 1))::int % array_length(v_paytypes, 1)];

      v_items := '[]'::jsonb;
      v_total := 0;
      for v_prod in
        select id, qty_balance, selling_price from finished_goods
         where tenant_id = v_tenant and qty_balance >= 5 and selling_price > 0
         order by random() limit (1 + floor(random() * 2)::int)
      loop
        v_qty := least(3 + floor(random() * 15), floor(v_prod.qty_balance / 2));
        if v_qty < 1 then continue; end if;
        v_price := v_prod.selling_price;
        v_items := v_items || jsonb_build_array(jsonb_build_object(
          'finished_good_id', v_prod.id, 'quantity', v_qty, 'unit_price', v_price));
        v_total := v_total + (v_qty * v_price);
      end loop;

      if v_total <= 0 then continue; end if;

      v_r := random();
      v_paid := case
        when v_r < 0.60 then v_total                                                  -- 60% fully paid
        when v_r < 0.85 then round((v_total * (0.4 + random() * 0.4))::numeric, 2)    -- 25% part payment
        else 0 end;                                                                   -- 15% credit

      v_sale := public.create_sale(v_cust, v_day, v_pay, v_paid, v_items);

      -- some part-payers pay again later
      if v_paid > 0 and v_paid < v_total and random() < 0.5 then
        perform public.record_sale_payment(
          v_sale, round((v_total - v_paid) * 0.5, 2), v_pay, 'Follow-up payment', null);
      end if;
    end loop;

    -- ---- monthly operating expenses ----
    insert into expenses(tenant_id, expense_date, expense_type_id, description, amount, payment_type_id)
    select v_tenant, d.dt, et.id, d.descr, d.amt, v_paytypes[1]
    from (values
      (v_base + 1,  'Rent',      'Factory rent',            80000::numeric),
      (v_base + 25, 'Salary',    'Staff salaries',          150000::numeric),
      (v_base + 9,  'Transport', 'Deliveries & logistics',  round((12000 + random() * 15000)::numeric, 2)),
      (v_base + 15, 'Transport', 'Raw material haulage',    round((8000 + random() * 10000)::numeric, 2))
    ) as d(dt, tname, descr, amt)
    left join expense_types et on et.tenant_id = v_tenant and et.name = d.tname;
  end loop;

  return 'Demo data loaded for ' || p_email;
end $$;

-- Lock it down: only the postgres role (SQL editor) can run this.
revoke execute on function public.seed_demo_data_for(text) from public;
revoke execute on function public.seed_demo_data_for(text) from anon;
revoke execute on function public.seed_demo_data_for(text) from authenticated;
