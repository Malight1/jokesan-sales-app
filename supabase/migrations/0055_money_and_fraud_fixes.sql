-- ============================================================
-- ProfixBook — money and fraud fixes from the November audit (2.1–2.4).
-- Run AFTER 0001–0054.
--
-- 1. Returns in reports: report_return_totals() gives the returns made in
--    a date range (by the RETURN's own date, like the dashboard), so
--    Reports can take them off sales, cost and profit.
-- 2. Sale dates: only admin and accounts may date a sale on another day.
--    Everyone else gets today (shop time), or up to 3 days back so a sale
--    rung up offline still syncs with the day it was made; those backdated
--    sales are written to the audit log. No future dates for them at all.
-- 3. Manager PINs: guessing is limited. A PIN is now checked first by
--    check_approval_pin(), which records every try and locks the person
--    asking after 5 wrong PINs in 10 minutes. verify_approval_pin() (used
--    by create_sale, convert_quote and add_cash_movement) only accepts a
--    PIN that check_approval_pin() approved in the last 15 minutes, once.
--    Calling create_sale straight away with guessed PINs gets nowhere,
--    because a failed create_sale rolls its own attempt record back.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Returns totals for Reports
-- ------------------------------------------------------------
-- One row per return date. subtotal is before VAT; cogs_reversed is the
-- cost of the resellable lines that went back on the shelf.
create or replace function public.report_return_totals(
  p_from   date default null,
  p_to     date default null,
  p_branch uuid default null
)
returns table (
  return_date   date,
  subtotal      numeric,
  vat_amount    numeric,
  total         numeric,
  cogs_reversed numeric
)
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.has_role('accounts') then
    raise exception 'Only admin and accounts can see the returns report.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
  select sr.return_date, sum(sr.subtotal), sum(sr.vat_amount), sum(sr.total), sum(sr.cogs_reversed)
    from sale_returns sr
   where sr.tenant_id = public.current_tenant_id()
     and not sr.voided
     and (p_from   is null or sr.return_date >= p_from)
     and (p_to     is null or sr.return_date <= p_to)
     and (p_branch is null or sr.branch_id = p_branch)
   group by sr.return_date
   order by sr.return_date;
end $$;

grant execute on function public.report_return_totals(date, date, uuid) to authenticated;

-- ------------------------------------------------------------
-- 2. Who may date a sale on another day
-- ------------------------------------------------------------
-- ProfixBook is Nigeria-only for now, so "today" is Lagos time; the
-- database's own current_date is UTC and an hour behind after midnight.
create or replace function public.shop_today()
returns date language sql stable as $$
  select (now() at time zone 'Africa/Lagos')::date
$$;

create or replace function public.guard_sale_date()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_today date := public.shop_today();
begin
  -- No signed-in user means the engine itself (sample data, migrations).
  if auth.uid() is null or public.current_role()::text in ('admin', 'accounts') then
    return NEW;
  end if;
  if NEW.transaction_date > v_today then
    raise exception 'A sale can''t be dated in the future. Only the owner or accounts can change a sale''s date.'
      using errcode = 'insufficient_privilege';
  end if;
  if NEW.transaction_date < v_today - 3 then
    raise exception 'Only the owner or accounts can date a sale more than 3 days back.'
      using errcode = 'insufficient_privilege';
  end if;
  -- UTC "today" from an older till is one day behind for the first hour
  -- after midnight; that isn't worth an audit line.
  if NEW.transaction_date < v_today - 1 then
    perform public.log_audit('backdated_sale', 'sales_orders', NEW.id::text,
      jsonb_build_object('sale_date', NEW.transaction_date, 'recorded_on', v_today));
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_sale_date on sales_orders;
create trigger trg_guard_sale_date before insert on sales_orders
  for each row execute function public.guard_sale_date();

-- ------------------------------------------------------------
-- 3. Manager PINs: a limited number of tries
-- ------------------------------------------------------------
create table if not exists approval_pin_attempts (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  requested_by uuid not null references auth.users(id) on delete cascade,
  approver_id  uuid references auth.users(id) on delete set null,
  ok           boolean not null,
  used_at      timestamptz,
  created_at   timestamptz not null default now()
);
create index if not exists idx_approval_pin_attempts_lookup
  on approval_pin_attempts (tenant_id, requested_by, created_at desc);
alter table approval_pin_attempts enable row level security;
-- The owner and accounts can see the tries (failed ones are the
-- interesting part); nobody writes to it except the functions below.
drop policy if exists approval_pin_attempts_read on approval_pin_attempts;
create policy approval_pin_attempts_read on approval_pin_attempts for select
  using (tenant_id = public.current_tenant_id() and public.current_role()::text in ('admin', 'accounts'));

-- Checks a manager's PIN for whoever is asking and records the try. Never
-- raises on a wrong PIN, so the record survives; raises only when locked.
create or replace function public.check_approval_pin(p_approver uuid, p_pin text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_fails  int;
  v_ok     boolean;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  select count(*) into v_fails from approval_pin_attempts
   where tenant_id = v_tenant and requested_by = auth.uid() and not ok
     and created_at > now() - interval '10 minutes';
  if v_fails >= 5 then
    raise exception 'Too many wrong PINs. Wait 10 minutes, then try again.'
      using errcode = 'insufficient_privilege';
  end if;

  select exists (
    select 1 from profiles
     where id = p_approver and tenant_id = v_tenant and role = 'admin' and is_active is not false
       and approval_pin_hash is not null and p_pin is not null
       and approval_pin_hash = md5(approval_pin_salt || p_pin)
  ) into v_ok;

  insert into approval_pin_attempts (tenant_id, requested_by, approver_id, ok)
  values (v_tenant, auth.uid(), p_approver, v_ok);

  if not v_ok and v_fails + 1 >= 5 then
    perform public.log_audit('approval_pin_locked', 'profiles', auth.uid()::text,
      jsonb_build_object('approver_id', p_approver));
  end if;
  return v_ok;
end $$;

grant execute on function public.check_approval_pin(uuid, text) to authenticated;

-- Same signature the engine already calls. The PIN still has to match,
-- and it must have passed check_approval_pin() for this person in the
-- last 15 minutes; each pass is used up by one approval.
create or replace function public.verify_approval_pin(p_admin uuid, p_pin text)
returns boolean
language plpgsql volatile security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_attempt uuid;
begin
  if not exists (
    select 1 from profiles
     where id = p_admin and tenant_id = v_tenant and role = 'admin'
       and approval_pin_hash is not null and p_pin is not null
       and approval_pin_hash = md5(approval_pin_salt || p_pin)
  ) then
    return false;
  end if;

  select id into v_attempt from approval_pin_attempts
   where tenant_id = v_tenant and requested_by = auth.uid() and approver_id = p_admin
     and ok and used_at is null and created_at > now() - interval '15 minutes'
   order by created_at desc limit 1
   for update;
  if v_attempt is null then return false; end if;

  update approval_pin_attempts set used_at = now() where id = v_attempt;
  return true;
end $$;

revoke execute on function public.verify_approval_pin(uuid, text) from public, anon, authenticated;
