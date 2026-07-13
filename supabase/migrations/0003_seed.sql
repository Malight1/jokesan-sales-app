-- ============================================================
-- StockFlow — Sample data seeder
-- Populates the CURRENT tenant with Jokesan starter data so a
-- new account can test the costing engine with real numbers.
-- Call from the app: supabase.rpc('seed_sample_data')
-- Run this AFTER 0001 and 0002.
-- ============================================================

create or replace function public.seed_sample_data()
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_supplier uuid;
  v_customer uuid;
  v_caustic uuid; v_pko uuid; v_sls uuid; v_water uuid; v_fragrance uuid;
  v_bottle uuid; v_label uuid;
  v_handwash uuid; v_dishwash uuid; v_soap uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  -- Don't double-seed
  if exists (select 1 from materials where tenant_id = v_tenant) then
    raise exception 'Sample data already loaded';
  end if;

  -- ---- Contacts ----
  insert into suppliers(tenant_id, first_name, last_name, company_store, address, phone)
  values (v_tenant, 'Shakirat', 'Oguntunde', 'Easycomp Tech', '25E Activities Centre', '08000000000')
  returning id into v_supplier;

  insert into customers(tenant_id, first_name, last_name, company_store, address, phone)
  values (v_tenant, 'Bola', 'Adesanya', 'Bola Stores', 'Main Market Rd', '08111111111')
  returning id into v_customer;

  -- ---- Raw materials (with sensible reorder points) ----
  insert into materials(tenant_id, name, unit, type_of_material, qty_balance, min_stock_level)
  values
    (v_tenant, 'Caustic Soda', 'kg', 'Raw Material', 0, 50) returning id into v_caustic;
  insert into materials(tenant_id, name, unit, type_of_material, qty_balance, min_stock_level)
  values (v_tenant, 'Palm Kernel Oil', 'L', 'Raw Material', 0, 25) returning id into v_pko;
  insert into materials(tenant_id, name, unit, type_of_material, qty_balance, min_stock_level)
  values (v_tenant, 'Sodium Lauryl Sulphate', 'kg', 'Raw Material', 0, 30) returning id into v_sls;
  insert into materials(tenant_id, name, unit, type_of_material, qty_balance, min_stock_level)
  values (v_tenant, 'Water', 'L', 'Raw Material', 0, 100) returning id into v_water;
  insert into materials(tenant_id, name, unit, type_of_material, qty_balance, min_stock_level)
  values (v_tenant, 'Fragrance', 'ml', 'Raw Material', 0, 50) returning id into v_fragrance;
  insert into materials(tenant_id, name, unit, type_of_material, qty_balance, min_stock_level)
  values (v_tenant, 'Plastic Bottle 500ml', 'pcs', 'Packaging Material', 0, 100) returning id into v_bottle;
  insert into materials(tenant_id, name, unit, type_of_material, qty_balance, min_stock_level)
  values (v_tenant, 'Label', 'pcs', 'Packaging Material', 0, 100) returning id into v_label;

  -- ---- Finished goods ----
  insert into finished_goods(tenant_id, name, unit, qty_balance, min_stock_level, default_markup, selling_price)
  values (v_tenant, 'Hand Wash 500ml', 'pcs', 0, 20, 1.5, 0) returning id into v_handwash;
  insert into finished_goods(tenant_id, name, unit, qty_balance, min_stock_level, default_markup, selling_price)
  values (v_tenant, 'Dish Wash 1L', 'pcs', 0, 20, 1.5, 0) returning id into v_dishwash;
  insert into finished_goods(tenant_id, name, unit, qty_balance, min_stock_level, default_markup, selling_price)
  values (v_tenant, 'Liquid Soap 1L', 'pcs', 0, 30, 1.5, 0) returning id into v_soap;

  -- ---- BOM recipes (per batch yield) ----
  -- Hand Wash: makes 50 units from this recipe
  insert into boms(tenant_id, finished_good_id, yield_qty) values (v_tenant, v_handwash, 50)
    returning id into v_handwash;  -- reuse var to hold bom id
  insert into bom_items(tenant_id, bom_id, material_id, quantity, unit) values
    (v_tenant, v_handwash, v_sls, 5, 'kg'),
    (v_tenant, v_handwash, v_water, 40, 'L'),
    (v_tenant, v_handwash, v_fragrance, 100, 'ml'),
    (v_tenant, v_handwash, v_bottle, 50, 'pcs'),
    (v_tenant, v_handwash, v_label, 50, 'pcs');

  insert into boms(tenant_id, finished_good_id, yield_qty) values (v_tenant, v_dishwash, 50)
    returning id into v_dishwash;
  insert into bom_items(tenant_id, bom_id, material_id, quantity, unit) values
    (v_tenant, v_dishwash, v_sls, 6, 'kg'),
    (v_tenant, v_dishwash, v_water, 42, 'L'),
    (v_tenant, v_dishwash, v_fragrance, 80, 'ml');

  insert into boms(tenant_id, finished_good_id, yield_qty) values (v_tenant, v_soap, 50)
    returning id into v_soap;
  insert into bom_items(tenant_id, bom_id, material_id, quantity, unit) values
    (v_tenant, v_soap, v_caustic, 4, 'kg'),
    (v_tenant, v_soap, v_pko, 10, 'L'),
    (v_tenant, v_soap, v_water, 35, 'L');
end $$;

grant execute on function public.seed_sample_data() to authenticated;
