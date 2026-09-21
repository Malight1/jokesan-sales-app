-- ============================================================
-- StockFlow — audit_row_change() can't log a DELETE on a row whose own id
-- IS the tenant_id it would log against (the `tenants` table itself), or
-- on any other watched table's row being removed as part of a tenant-wide
-- cascade delete: by the time the AFTER DELETE trigger fires, the parent
-- tenant is already gone, so the audit_logs.tenant_id foreign key always
-- fails. This has silently made deleting a tenant impossible (the only
-- previously-supported way to disable one is is_active = false) — it
-- surfaced when cleaning up an accidentally-created tenant by hand.
--
-- Fix: if the tenant the row belongs to no longer exists by the time we
-- go to log it, there's nowhere valid to attribute that entry — skip
-- logging instead of blocking the actual delete. Every normal case (the
-- tenant still exists) is completely unaffected.
-- Run AFTER 0001–0043.
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

  begin
    insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
    values ((v_row ->> v_tenant_col)::uuid, auth.uid(), v_action, TG_TABLE_NAME, v_row ->> 'id', v_diff);
  exception when foreign_key_violation then
    -- The tenant this row belonged to is gone (deleting the tenant itself,
    -- or a child row removed by that same cascade) — nothing left to
    -- attribute the log entry to. Let the delete proceed regardless.
    null;
  end;
  return coalesce(NEW, OLD);
end $$;
