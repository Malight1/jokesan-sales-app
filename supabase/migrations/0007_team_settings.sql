-- ============================================================
-- StockFlow — Team management + settings support
--  • profiles.email (so the team list can show emails)
--  • staff_invites: admin invites an email + role; when that
--    person signs up, the trigger attaches them to the inviting
--    tenant with the invited role (instead of creating a new
--    company).
-- Run AFTER 0001–0006.
-- ============================================================

-- ---- profiles.email ----
alter table profiles add column if not exists email text;
update profiles p set email = u.email
  from auth.users u where u.id = p.id and p.email is null;

-- ---- staff invites ----
create table if not exists staff_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  email text not null,
  role user_role not null default 'sales',
  branch_id uuid references branches(id) on delete set null,
  status text not null default 'pending',   -- pending | accepted
  invited_by uuid references auth.users(id) default auth.uid(),
  created_at timestamptz not null default now()
);

alter table staff_invites enable row level security;

-- Only the tenant's admin manages invites
create policy staff_invites_admin_all on staff_invites for all
  using (tenant_id = public.current_tenant_id() and public.current_role() = 'admin')
  with check (tenant_id = public.current_tenant_id() and public.current_role() = 'admin');

-- auto-stamp tenant_id on insert (function from 0004)
drop trigger if exists trg_set_tenant on staff_invites;
create trigger trg_set_tenant before insert on staff_invites
  for each row execute function public.set_tenant_id();

create index if not exists idx_invites_email on staff_invites(lower(email)) where status = 'pending';

-- ---- signup trigger: invited users JOIN the inviting company ----
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_tenant_id uuid;
  new_branch_id uuid;
  company text;
  ttype tenant_type;
  base_slug text;
  v_invite record;
begin
  -- 1) Invited staff → attach to the inviting tenant, no new company
  select * into v_invite
    from staff_invites
   where lower(email) = lower(new.email) and status = 'pending'
   order by created_at desc limit 1;

  if found then
    insert into profiles (id, tenant_id, branch_id, role, full_name, email)
    values (new.id, v_invite.tenant_id, v_invite.branch_id, v_invite.role,
            new.raw_user_meta_data ->> 'full_name', new.email);
    update staff_invites set status = 'accepted' where id = v_invite.id;
    return new;
  end if;

  -- 2) Fresh signup → create their own company (original behaviour)
  company := coalesce(new.raw_user_meta_data ->> 'company_name', 'My Company');
  ttype   := coalesce((new.raw_user_meta_data ->> 'tenant_type')::tenant_type, 'single');
  base_slug := lower(regexp_replace(company, '[^a-zA-Z0-9]+', '-', 'g'))
               || '-' || substr(new.id::text, 1, 6);

  insert into tenants (name, slug, type)
    values (company, base_slug, ttype)
    returning id into new_tenant_id;

  insert into branches (tenant_id, name)
    values (new_tenant_id, 'Main')
    returning id into new_branch_id;

  insert into profiles (id, tenant_id, branch_id, role, full_name, email)
    values (new.id, new_tenant_id, new_branch_id, 'admin',
            new.raw_user_meta_data ->> 'full_name', new.email);

  insert into payment_types (tenant_id, name) values
    (new_tenant_id,'Cash'), (new_tenant_id,'Bank Transfer'), (new_tenant_id,'Credit');
  insert into customer_types (tenant_id, name) values
    (new_tenant_id,'Corporate'), (new_tenant_id,'Private');
  insert into expense_types (tenant_id, name) values
    (new_tenant_id,'Transport'), (new_tenant_id,'Salary'), (new_tenant_id,'Rent');

  return new;
end $$;
