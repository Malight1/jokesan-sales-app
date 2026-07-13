-- ============================================================
-- StockFlow — Auto-stamp tenant_id (and branch_id) on insert
-- Fixes: "new row violates row-level security policy" on direct
-- table inserts (customers, suppliers, materials, etc.) where the
-- client doesn't send tenant_id. A BEFORE INSERT trigger fills it
-- from the caller's profile so the RLS WITH CHECK passes.
-- Run AFTER 0001–0003.
-- ============================================================

create or replace function public.set_tenant_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.tenant_id is null then
    NEW.tenant_id := public.current_tenant_id();
  end if;
  return NEW;
end $$;

-- branch-aware variant: also default branch_id to the caller's branch
create or replace function public.set_tenant_and_branch()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.tenant_id is null then
    NEW.tenant_id := public.current_tenant_id();
  end if;
  if NEW.branch_id is null then
    NEW.branch_id := public.current_branch_id();
  end if;
  return NEW;
end $$;

-- Tables that have BOTH tenant_id and branch_id
do $$
declare t text;
begin
  foreach t in array array[
    'customers','suppliers','expenses'
  ]
  loop
    execute format('drop trigger if exists trg_set_tenant on %I;', t);
    execute format('create trigger trg_set_tenant before insert on %I
                    for each row execute function public.set_tenant_and_branch();', t);
  end loop;
end $$;

-- Tables that have tenant_id only (no branch_id)
do $$
declare t text;
begin
  foreach t in array array[
    'customer_types','payment_types','expense_types',
    'materials','finished_goods','boms','bom_items'
  ]
  loop
    execute format('drop trigger if exists trg_set_tenant on %I;', t);
    execute format('create trigger trg_set_tenant before insert on %I
                    for each row execute function public.set_tenant_id();', t);
  end loop;
end $$;

-- ============================================================
-- Done. Direct inserts now pass RLS without the client sending
-- tenant_id. The RPC engine functions already set it explicitly,
-- so they are unaffected.
-- ============================================================
