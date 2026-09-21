-- ============================================================
-- StockFlow — a genuine platform-admin-only account type.
--
-- Until now, EVERY new auth.users row (including one created purely to be
-- a platform admin) got a throwaway tenant, branch and profile via
-- handle_new_user() — there was no way to sign up as "just an admin".
-- That's what produced the confusing "My Company" business showing up
-- for hello@evotekra.com: the account is real, but the business isn't.
--
-- Fix: an account created with {"platform_admin": true} in its user
-- metadata skips tenant/branch/profile creation entirely and is
-- registered directly in platform_admins instead. Every other signup
-- (the vast majority) is completely unaffected.
--
-- IMPORTANT: handle_new_user() has been redefined three times since 0001
-- (0007 added the staff-invite-matching branch, 0020 touched branch
-- defaulting, 0026 added method_group-aware payment types and stamps
-- profiles.email). This migration is based on 0026's body — the actual
-- current definition — with only the new early-return branch added on
-- top. An earlier version of this migration was mistakenly based on the
-- original 0001 body and silently dropped the invite-matching branch,
-- which broke every invited-staff signup (each one tried to create its
-- own tenant instead of joining the inviter's, colliding on the default
-- "My Company" slug). If handle_new_user() is ever touched again, base
-- it on the CURRENT function body (pg_get_functiondef), not on any one
-- migration file in isolation.
-- Run AFTER 0001–0042.
-- ============================================================

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
  if coalesce((new.raw_user_meta_data ->> 'platform_admin')::boolean, false) then
    insert into platform_admins (user_id) values (new.id) on conflict do nothing;
    return new;
  end if;

  select * into v_invite
    from staff_invites
   where lower(email) = lower(new.email) and status = 'pending'
   order by created_at desc limit 1;

  if found then
    insert into profiles (id, tenant_id, branch_id, role, full_name, email)
    values (new.id, v_invite.tenant_id,
            coalesce(v_invite.branch_id, public.default_branch_id(v_invite.tenant_id)),
            v_invite.role, new.raw_user_meta_data ->> 'full_name', new.email);
    update staff_invites set status = 'accepted' where id = v_invite.id;
    return new;
  end if;

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

  insert into payment_types (tenant_id, name, method_group) values
    (new_tenant_id, 'Cash', 'cash'), (new_tenant_id, 'Bank Transfer', 'transfer'), (new_tenant_id, 'Credit', 'other');
  insert into customer_types (tenant_id, name) values
    (new_tenant_id, 'Corporate'), (new_tenant_id, 'Private');
  insert into expense_types (tenant_id, name) values
    (new_tenant_id, 'Transport'), (new_tenant_id, 'Salary'), (new_tenant_id, 'Rent');

  return new;
end $$;
