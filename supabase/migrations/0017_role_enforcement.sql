-- ============================================================
-- StockFlow — Server-side role enforcement
--
-- Until now the ONLY thing standing between a cashier and the whole
-- database was React. Every business table shared one policy:
--
--     for all using (tenant_id = current_tenant_id())
--
-- It checked the company and never the role, and no engine RPC checked
-- current_role() either. Anyone holding a staff session token could read
-- every cost price, the full P&L and every customer, and write to any of
-- it, straight through the REST API. ProtectedRoute/canAccess is a menu,
-- not a control.
--
-- This migration makes the database the authority:
--
--   1. Per-table SELECT policies, by role.
--   2. Direct writes allowed only where a role legitimately types data in.
--      Every money table is closed to direct writes entirely — the FIFO
--      engine is SECURITY DEFINER, so it still works, and nothing else can
--      touch those rows.
--   3. Role guards as TRIGGERS on the money tables. SECURITY DEFINER
--      bypasses RLS but not triggers, so these fire inside the engine and
--      gate who may sell, purchase, produce, take payment, or void —
--      without having to rewrite the engine bodies.
--   4. A suspended or expired tenant becomes read-only, so the Super Admin
--      suspend button and plan expiry finally do something.
--
-- Run AFTER 0001–0016.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Helpers
-- ------------------------------------------------------------

-- Is the caller one of these roles? (admin always passes.)
create or replace function public.has_role(variadic p_roles text[])
returns boolean
language sql stable security definer set search_path = public as $$
  select public.current_role()::text = any(p_roles) or public.current_role() = 'admin'
$$;

-- Is this tenant allowed to WRITE right now? Suspended by the platform
-- owner, an expired trial, or a lapsed subscription all make the account
-- read-only — they can still see and export their data, they just can't
-- add more. Reads stay open on purpose: locking people out of their own
-- records over a billing lapse is how you get a chargeback.
create or replace function public.tenant_is_live()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select t.is_active
       and (t.plan <> 'trial'      or t.trial_ends_at   is null or t.trial_ends_at   > now())
       and (t.plan_expires_at is null                            or t.plan_expires_at > now())
      from tenants t
     where t.id = public.current_tenant_id()
  ), false)
$$;

grant execute on function public.has_role(text[])   to authenticated;
grant execute on function public.tenant_is_live()   to authenticated;


-- ------------------------------------------------------------
-- 2. Replace the blanket policies with role-aware ones
-- ------------------------------------------------------------
-- Old policy name from 0001 was "<table>_tenant_all".
do $$
declare
  spec record;
begin
  for spec in
    select * from (values
      -- table,                    roles that may READ,                     roles that may WRITE directly
      ('customer_types',           'admin,sales,inventory,accounts',        'admin'),
      ('payment_types',            'admin,sales,inventory,accounts',        'admin'),
      ('expense_types',            'admin,sales,inventory,accounts',        'admin'),

      ('customers',                'admin,sales,accounts',                  'admin,sales'),
      ('suppliers',                'admin,inventory,accounts',              'admin,inventory'),

      -- Everyone can see stock: the POS needs products, and Stock Alerts
      -- is on every role's menu.
      ('materials',                'admin,sales,inventory,accounts',        'admin,inventory'),
      ('finished_goods',           'admin,sales,inventory,accounts',        'admin,inventory'),
      ('boms',                     'admin,inventory,accounts',              'admin,inventory'),
      ('bom_items',                'admin,inventory,accounts',              'admin,inventory'),

      -- Money tables: readable by the roles that need them, writable by
      -- nobody directly. The engine writes these as SECURITY DEFINER.
      ('purchase_orders',          'admin,inventory,accounts',              ''),
      ('purchase_items',           'admin,inventory,accounts',              ''),
      ('purchase_payments',        'admin,inventory,accounts',              ''),
      ('production_runs',          'admin,inventory,accounts',              ''),
      ('production_consumption',   'admin,inventory,accounts',              ''),
      ('fg_batches',               'admin,inventory,accounts',              ''),
      ('sales_orders',             'admin,sales,accounts',                  ''),
      ('sale_items',               'admin,sales,accounts',                  ''),
      ('sale_payments',            'admin,sales,accounts',                  ''),
      ('sales_consumption',        'admin,accounts',                        ''),
      ('stock_movements',          'admin,inventory,accounts',              ''),

      -- Expenses are finance-only. A cashier has no business here.
      ('expenses',                 'admin,accounts',                        'admin,accounts')
    ) as t(tbl, read_roles, write_roles)
  loop
    execute format('drop policy if exists %I on %I;', spec.tbl || '_tenant_all', spec.tbl);
    execute format('drop policy if exists %I on %I;', spec.tbl || '_read',       spec.tbl);
    execute format('drop policy if exists %I on %I;', spec.tbl || '_write',      spec.tbl);

    execute format($f$
      create policy %I on %I for select
      using (
        tenant_id = public.current_tenant_id()
        and public.has_role(variadic string_to_array(%L, ','))
      );
    $f$, spec.tbl || '_read', spec.tbl, spec.read_roles);

    if spec.write_roles <> '' then
      execute format($f$
        create policy %I on %I for all
        using (
          tenant_id = public.current_tenant_id()
          and public.has_role(variadic string_to_array(%L, ','))
          and public.tenant_is_live()
        )
        with check (
          tenant_id = public.current_tenant_id()
          and public.has_role(variadic string_to_array(%L, ','))
          and public.tenant_is_live()
        );
      $f$, spec.tbl || '_write', spec.tbl, spec.write_roles, spec.write_roles);
    end if;
  end loop;
end $$;

-- Audit log is an admin artefact.
drop policy if exists audit_select on audit_logs;
create policy audit_select on audit_logs for select
  using (tenant_id = public.current_tenant_id() and public.current_role() = 'admin');


-- ------------------------------------------------------------
-- 3. Role guards on the money tables
-- ------------------------------------------------------------
-- These run as TRIGGERS precisely so they still fire inside the
-- SECURITY DEFINER engine functions, which bypass RLS.

create or replace function public.guard_money_write()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_allowed text[] := string_to_array(TG_ARGV[0], ',');
  v_action  text   := coalesce(TG_ARGV[1], 'write');
begin
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — % is read-only until billing is sorted out.', v_action
      using errcode = 'check_violation';
  end if;
  if not public.has_role(variadic v_allowed) then
    raise exception 'Your role is not allowed to %.', v_action
      using errcode = 'insufficient_privilege';
  end if;
  return NEW;
end $$;

-- Voiding reverses stock AND money. Ring up a cash sale, pocket the cash,
-- void the sale — that is the shape of till fraud, so it is admin-only and
-- checked here rather than on the button.
create or replace function public.guard_void()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.voided is distinct from OLD.voided and NEW.voided then
    if public.current_role() <> 'admin' then
      raise exception 'Only an admin can void a transaction.'
        using errcode = 'insufficient_privilege';
    end if;
    if not public.tenant_is_live() then
      raise exception 'This account is suspended or expired — voiding is disabled.'
        using errcode = 'check_violation';
    end if;
  end if;
  return NEW;
end $$;

do $$
declare g record;
begin
  for g in
    select * from (values
      ('sales_orders',      'admin,sales',             'record a sale'),
      ('sale_payments',     'admin,sales,accounts',    'record a customer payment'),
      ('purchase_orders',   'admin,inventory',         'record a purchase'),
      ('purchase_payments', 'admin,inventory,accounts','record a supplier payment'),
      ('production_runs',   'admin,inventory',         'record production')
    ) as t(tbl, roles, action)
  loop
    execute format('drop trigger if exists trg_guard_write on %I;', g.tbl);
    execute format($f$
      create trigger trg_guard_write before insert on %I
      for each row execute function public.guard_money_write(%L, %L);
    $f$, g.tbl, g.roles, g.action);
  end loop;

end $$;

do $$
declare v_tbl text;
begin
  foreach v_tbl in array array['sales_orders','purchase_orders','production_runs'] loop
    execute format('drop trigger if exists trg_guard_void on %I;', v_tbl);
    execute format($f$
      create trigger trg_guard_void before update on %I
      for each row execute function public.guard_void();
    $f$, v_tbl);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 4. Keep staff from promoting themselves
-- ------------------------------------------------------------
-- profiles_update already required admin, but an admin editing their own
-- row could previously be tricked into changing tenant_id. Pin the columns
-- that decide who you are.
create or replace function public.guard_profile_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.tenant_id is distinct from OLD.tenant_id then
    raise exception 'A profile cannot be moved between companies.'
      using errcode = 'insufficient_privilege';
  end if;
  if NEW.role is distinct from OLD.role and public.current_role() <> 'admin' then
    raise exception 'Only an admin can change a role.'
      using errcode = 'insufficient_privilege';
  end if;
  -- Nobody may change their own role, admin included: that is how a
  -- compromised session quietly becomes permanent.
  if NEW.role is distinct from OLD.role and NEW.id = auth.uid() then
    raise exception 'You cannot change your own role.'
      using errcode = 'insufficient_privilege';
  end if;
  -- The profile page lets people edit their OWN row, so everything on it
  -- that isn't "your name" has to be pinned here — otherwise a deactivated
  -- account could switch itself back on, or a cashier reassign its branch.
  if public.current_role() <> 'admin' then
    if NEW.is_active is distinct from OLD.is_active then
      raise exception 'Only an admin can activate or deactivate an account.'
        using errcode = 'insufficient_privilege';
    end if;
    if NEW.branch_id is distinct from OLD.branch_id then
      raise exception 'Only an admin can move someone between branches.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_profile on profiles;
create trigger trg_guard_profile before update on profiles
  for each row execute function public.guard_profile_change();

-- Let a staff member maintain their OWN name (the new profile page needs
-- this) while everything else about a profile stays admin-only.
drop policy if exists profiles_update on profiles;
create policy profiles_update on profiles for update
  using (
    tenant_id = public.current_tenant_id()
    and (public.current_role() = 'admin' or id = auth.uid())
  );
