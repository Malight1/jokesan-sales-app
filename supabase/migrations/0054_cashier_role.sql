alter type user_role add value if not exists 'cashier';

-- ============================================================
-- ProfixBook — the Cashier (till only) role.
--
-- A cashier signs in straight to the till and can do nothing else.
-- The owner's rules (21 Nov 2026):
--   1. Credit sales allowed, but watched: a customer must be named, and
--      every one is written to the audit log for the owner to review.
--   2. Returns allowed only once an admin, a sales lead or accounts
--      approves them with their PIN at the till.
--   3. Discounts up to the same limit as Sales; above it, the admin PIN
--      (unchanged discount approval).
--   4. Always has to open the till before selling, whatever the
--      business-wide "open the till" setting says.
--
-- How it fits the existing engine: about 70 places check roles through
-- public.current_role() / has_role(). Rather than edit every one, the
-- database now reads a cashier as 'sales' there (so the till, payments,
-- shifts and receipts work exactly as they do for Sales), and the new
-- public.real_role() is what the cashier-only rules below look at.
-- Restrictive policies then take away what a cashier must not see:
-- other people's sales, quotes and deliveries.
--
-- The new enum value is only ever compared as TEXT below ('cashier'),
-- never cast, so this file can add it and use it in one run.
--
-- Run AFTER 0001-0053.
-- ============================================================

-- ------------------------------------------------------------
-- 1. The person's actual role, and the role the engine works with
-- ------------------------------------------------------------
create or replace function public.real_role()
returns text language sql stable security definer set search_path = public as $$
  select role::text from public.profiles where id = auth.uid()
$$;
grant execute on function public.real_role() to authenticated;

create or replace function public.current_role()
returns user_role language sql stable security definer set search_path = public as $$
  select case when role::text = 'cashier' then 'sales'::user_role else role end
    from public.profiles where id = auth.uid()
$$;

-- ------------------------------------------------------------
-- 2. A cashier always needs an open till to sell
-- ------------------------------------------------------------
create or replace function public.shift_required(p_action text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select shift_rules->'required_for' ? p_action from tenants where id = public.current_tenant_id()), false)
      or (p_action = 'sales' and public.real_role() = 'cashier')
$$;
revoke execute on function public.shift_required(text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Credit given at the till is allowed, but never anonymous and
--    never unrecorded. create_sale inserts the order header first and
--    sets its totals in a later UPDATE, so this watches that update.
-- ------------------------------------------------------------
create or replace function public.watch_cashier_credit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if public.real_role() is distinct from 'cashier' then return NEW; end if;
  if coalesce(OLD.total_amount, 0) = 0 and NEW.total_amount > 0 and NEW.balance > 0 then
    if NEW.customer_id is null then
      raise exception 'A sale on credit needs a customer. Pick the customer, or take the full amount.'
        using errcode = 'check_violation';
    end if;
    perform public.log_audit('till_credit_sale', 'sales_orders', NEW.id::text, jsonb_build_object(
      'customer_id', NEW.customer_id, 'doc_no', NEW.doc_no,
      'total', NEW.total_amount, 'paid', NEW.amount_paid, 'balance', NEW.balance));
  end if;
  return NEW;
end $$;

drop trigger if exists trg_watch_cashier_credit on sales_orders;
create trigger trg_watch_cashier_credit after update on sales_orders
  for each row execute function public.watch_cashier_credit();

-- ------------------------------------------------------------
-- 4. Returns need a PIN from an admin, a sales lead or accounts
-- ------------------------------------------------------------
-- Any of those three may now hold an approval PIN. Discount approvals
-- still accept only an ADMIN's PIN (verify_approval_pin is unchanged);
-- a sales or accounts PIN only approves a cashier's return.
create or replace function public.set_approval_pin(p_pin text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_salt text := md5(random()::text || clock_timestamp()::text);
begin
  if coalesce(public.real_role(), '') not in ('admin', 'sales', 'accounts') then
    raise exception 'Your role can''t have an approval PIN.' using errcode = 'insufficient_privilege';
  end if;
  if p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'Use a 4 to 6 digit PIN.';
  end if;
  update profiles set approval_pin_salt = v_salt, approval_pin_hash = md5(v_salt || p_pin) where id = auth.uid();
end $$;

create table if not exists return_approvals (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  sales_order_id uuid not null references sales_orders(id) on delete cascade,
  cashier_id     uuid not null references auth.users(id),
  approver_id    uuid references auth.users(id),
  ok             boolean not null,      -- false = a wrong PIN was tried
  used_at        timestamptz,           -- set when the return goes through
  created_at     timestamptz not null default now()
);
create index if not exists idx_return_approvals_lookup
  on return_approvals (tenant_id, cashier_id, sales_order_id, created_at desc);
alter table return_approvals enable row level security;
drop policy if exists return_approvals_read on return_approvals;
create policy return_approvals_read on return_approvals for select
  using (tenant_id = public.current_tenant_id() and public.real_role() in ('admin', 'accounts'));

alter table sale_returns add column if not exists approved_by uuid references auth.users(id);

-- Who can approve, for the till's approval screen: active admin, sales
-- and accounts people who have set a PIN.
create or replace function public.return_approvers()
returns table (id uuid, name text, role text)
language sql stable security definer set search_path = public as $$
  select p.id, coalesce(nullif(p.full_name, ''), p.email), p.role::text
    from profiles p
   where p.tenant_id = public.current_tenant_id()
     and p.is_active is not false
     and p.role::text in ('admin', 'sales', 'accounts')
     and p.approval_pin_hash is not null
   order by case p.role::text when 'admin' then 0 when 'sales' then 1 else 2 end, 2
$$;
grant execute on function public.return_approvers() to authenticated;

-- The cashier asks; the approver types their PIN on the cashier's
-- screen. Returns true/false instead of raising on a wrong PIN, so the
-- failed attempt is kept: five wrong PINs in ten minutes locks it.
create or replace function public.approve_cashier_return(p_sale uuid, p_approver uuid, p_pin text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_fails  int;
  v_ok     boolean;
begin
  if public.real_role() is distinct from 'cashier' then
    raise exception 'Only a cashier needs a return approved.';
  end if;
  perform 1 from sales_orders where id = p_sale and tenant_id = v_tenant;
  if not found then raise exception 'Sale not found'; end if;

  select count(*) into v_fails from return_approvals
   where tenant_id = v_tenant and cashier_id = auth.uid() and not ok
     and created_at > now() - interval '10 minutes';
  if v_fails >= 5 then
    raise exception 'Too many wrong PINs. Wait 10 minutes, then try again.';
  end if;

  select exists (
    select 1 from profiles
     where id = p_approver and tenant_id = v_tenant and is_active is not false
       and role::text in ('admin', 'sales', 'accounts')
       and approval_pin_hash is not null and p_pin is not null
       and approval_pin_hash = md5(approval_pin_salt || p_pin)
  ) into v_ok;

  insert into return_approvals (tenant_id, sales_order_id, cashier_id, approver_id, ok)
  values (v_tenant, p_sale, auth.uid(), p_approver, v_ok);
  return v_ok;
end $$;
grant execute on function public.approve_cashier_return(uuid, uuid, text) to authenticated;

-- create_sale_return is untouched: this trigger on its insert is what
-- refuses a cashier's return that nobody approved in the last 15 minutes.
create or replace function public.require_return_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_appr record;
begin
  if public.real_role() is distinct from 'cashier' then return NEW; end if;
  select * into v_appr from return_approvals
   where tenant_id = NEW.tenant_id and sales_order_id = NEW.sales_order_id
     and cashier_id = auth.uid() and ok and used_at is null
     and created_at > now() - interval '15 minutes'
   order by created_at desc limit 1
   for update;
  if not found then
    raise exception 'A manager has to approve this return first.' using errcode = 'insufficient_privilege';
  end if;
  update return_approvals set used_at = now() where id = v_appr.id;
  NEW.approved_by := v_appr.approver_id;
  perform public.log_audit('till_return_approved', 'sales_orders', NEW.sales_order_id::text,
    jsonb_build_object('approved_by', v_appr.approver_id, 'return_doc_no', NEW.doc_no));
  return NEW;
end $$;

drop trigger if exists trg_require_return_approval on sale_returns;
create trigger trg_require_return_approval before insert on sale_returns
  for each row execute function public.require_return_approval();

-- ------------------------------------------------------------
-- 5. What a cashier can't see. Restrictive policies are ANDed with the
--    existing ones, so nobody else loses anything.
-- ------------------------------------------------------------
-- Only their own sales (receipts, and finding a sale to return).
drop policy if exists sales_orders_cashier_own on sales_orders;
create policy sales_orders_cashier_own on sales_orders as restrictive for select to authenticated
  using (public.real_role() is distinct from 'cashier' or created_by = auth.uid());

do $$
declare t text;
begin
  foreach t in array array['sale_items', 'sale_payments', 'sale_returns', 'payment_links'] loop
    execute format('drop policy if exists %I on %I', t || '_cashier_own', t);
    execute format($p$create policy %I on %I as restrictive for select to authenticated
      using (public.real_role() is distinct from 'cashier'
             or exists (select 1 from sales_orders so where so.id = sales_order_id and so.created_by = auth.uid()))$p$,
      t || '_cashier_own', t);
  end loop;

  foreach t in array array['quotes', 'quote_items', 'deliveries', 'delivery_items'] loop
    execute format('drop policy if exists %I on %I', t || '_no_cashier', t);
    execute format($p$create policy %I on %I as restrictive for select to authenticated
      using (public.real_role() is distinct from 'cashier')$p$, t || '_no_cashier', t);
  end loop;
end $$;

drop policy if exists sale_return_items_cashier_own on sale_return_items;
create policy sale_return_items_cashier_own on sale_return_items as restrictive for select to authenticated
  using (public.real_role() is distinct from 'cashier'
         or exists (select 1 from sale_returns r join sales_orders so on so.id = r.sales_order_id
                     where r.id = sale_return_id and so.created_by = auth.uid()));
