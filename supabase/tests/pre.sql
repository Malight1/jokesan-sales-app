-- Runs after 0019 and BEFORE 0020: an existing single-branch account in the
-- state today's live data is in — opening stock typed straight into
-- qty_balance (what the old forms and CSV importer did), plus one real
-- purchase through the old engine.
insert into auth.users (id, email, raw_user_meta_data) values
  ('00000000-0000-0000-0000-00000000000a', 'legacy@example.com',
   '{"company_name":"Legacy Co","tenant_type":"single","full_name":"Legacy Owner"}');

do $$
declare v_t uuid; v_mat uuid; v_fg uuid;
begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000000a', false);
  v_t := public.current_tenant_id();

  insert into materials (tenant_id, name, unit, qty_balance, min_stock_level)
  values (v_t, 'Legacy Oil', 'L', 50, 5) returning id into v_mat;

  insert into finished_goods (tenant_id, name, unit, qty_balance, min_stock_level, selling_price, default_markup)
  values (v_t, 'Legacy Soap', 'pcs', 30, 5, 1500, 1.5) returning id into v_fg;

  -- Old 5-argument signature, exactly as the live app calls it today.
  perform public.create_purchase(null, current_date, null, 0,
    jsonb_build_array(jsonb_build_object('material_id', v_mat, 'qty', 20, 'cost_price', 100)));

  perform set_config('request.jwt.claim.sub', '', false);
end $$;
