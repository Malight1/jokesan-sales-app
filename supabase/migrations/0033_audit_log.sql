-- ============================================================
-- StockFlow — Audit log viewer (Phase 6f)
--
-- Every void, return, discount override, shift variance, batch write-off
-- and recall already calls log_audit() inline from inside its own RPC
-- (migration 0021 onward — see that file's header). What's never been
-- logged is a change to config that isn't behind an RPC at all: a role,
-- a business setting, a branch, a lookup name, a price. Those go straight
-- from the app to the table via a plain RLS-checked write, so a trigger
-- is the only place that can see both the before and the after.
--
-- audit_row_change() is one generic trigger function reused across all of
-- them — TG_ARGV[0] is the comma-separated list of columns worth
-- watching on that table (so renaming a customer doesn't spam the log
-- every time someone fixes a typo in an unrelated column), TG_ARGV[1] is
-- which column on that row holds the tenant id ('tenant_id' for most
-- tables, 'id' for tenants itself).
-- ============================================================


create or replace function public.audit_row_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_cols       text[] := string_to_array(TG_ARGV[0], ',');
  v_tenant_col text    := coalesce(nullif(TG_ARGV[1], ''), 'tenant_id');
  v_row        jsonb   := to_jsonb(coalesce(NEW, OLD));
  v_old        jsonb   := to_jsonb(OLD);
  v_new        jsonb   := to_jsonb(NEW);
  v_action     text;
  v_diff       jsonb   := '{}'::jsonb;
  v_col        text;
begin
  if TG_OP = 'INSERT' then
    v_action := 'create';
    foreach v_col in array v_cols loop
      if v_new -> v_col is not null then
        v_diff := v_diff || jsonb_build_object(v_col, jsonb_build_object('to', v_new -> v_col));
      end if;
    end loop;
  elsif TG_OP = 'DELETE' then
    v_action := 'delete';
    foreach v_col in array v_cols loop
      if v_old -> v_col is not null then
        v_diff := v_diff || jsonb_build_object(v_col, jsonb_build_object('from', v_old -> v_col));
      end if;
    end loop;
  else
    v_action := 'update';
    foreach v_col in array v_cols loop
      if (v_old -> v_col) is distinct from (v_new -> v_col) then
        v_diff := v_diff || jsonb_build_object(v_col, jsonb_build_object('from', v_old -> v_col, 'to', v_new -> v_col));
      end if;
    end loop;
    if v_diff = '{}'::jsonb then
      return NEW; -- nothing in the watched columns actually changed
    end if;
  end if;

  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
  values ((v_row ->> v_tenant_col)::uuid, auth.uid(), v_action, TG_TABLE_NAME, v_row ->> 'id', v_diff);
  return coalesce(NEW, OLD);
end $$;

do $$
declare g record;
begin
  for g in
    select * from (values
      ('profiles',        'role,is_active,branch_id',                                                                    'tenant_id'),
      ('tenants',         'name,currency,vat_enabled,vat_rate,tin,cashier_returns,shift_rules,allow_expired_sale,expiry_warning_days,bank_details,pricing_rules,is_active', 'id'),
      ('branches',        'name,address,is_active',                                                                      'tenant_id'),
      ('payment_types',   'name',                                                                                        'tenant_id'),
      ('expense_types',   'name',                                                                                        'tenant_id'),
      ('customer_types',  'name,price_list_id',                                                                          'tenant_id'),
      ('price_lists',     'name,is_default,is_active',                                                                   'tenant_id'),
      ('price_list_items','price,min_qty',                                                                               'tenant_id')
    ) as t(tbl, cols, tenant_col)
  loop
    execute format('drop trigger if exists trg_audit_row_change on %I;', g.tbl);
    execute format($f$
      create trigger trg_audit_row_change after insert or update or delete on %I
      for each row execute function public.audit_row_change(%L, %L);
    $f$, g.tbl, g.cols, g.tenant_col);
  end loop;
end $$;
