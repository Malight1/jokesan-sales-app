-- ============================================================
-- ProfixBook: security fixes from the 27 Nov 2026 security test
-- (SECURITY-AUDIT-2026-11.md).
--
-- C1  Sign-up can no longer create a platform admin. Platform admins are
--     added by hand in the SQL editor only.
-- C2  A business can no longer change its own plan, trial, expiry,
--     suspension, AI limit or founding price. Only the server (payment
--     check) or a platform admin can.
-- M2  Staff invites expire after 7 days.
-- L1  Nothing in the database can be called without signing in, except
--     the two functions public pages need. Internal helpers are no longer
--     callable from the app at all.
-- L2  Logos stay viewable by link, but the file list is no longer public.
-- L3  A pay link written from the app always starts as unpaid.
-- L4  A plain sign-up with an invited email is refused; the invite link
--     is the way in.
--
-- Run AFTER 0001-0064.
-- ============================================================

-- ---------------- C1 + M2 + L4: sign-up ----------------
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_tenant_id uuid;
  new_branch_id uuid;
  company text;
  ttype tenant_type;
  btype text;
  base_slug text;
  v_invite record;
begin
  select * into v_invite
    from staff_invites
   where lower(email) = lower(new.email) and status = 'pending'
     and created_at > now() - interval '7 days'
   order by created_at desc limit 1;

  if found then
    -- Only someone who controls the inbox may take an invited seat. An
    -- account made through the invite link is created already confirmed;
    -- a plain sign-up with an invited email is refused, so nobody can
    -- grab a teammate's seat with a password of their own.
    if new.email_confirmed_at is null then
      raise exception 'This email has a team invite. Open the link in your invite to join.'
        using errcode = 'P0001';
    end if;
    insert into profiles (id, tenant_id, branch_id, role, full_name, email)
    values (new.id, v_invite.tenant_id,
            coalesce(v_invite.branch_id, public.default_branch_id(v_invite.tenant_id)),
            v_invite.role, new.raw_user_meta_data ->> 'full_name', new.email);
    update staff_invites set status = 'accepted' where id = v_invite.id;
    return new;
  end if;

  company := coalesce(new.raw_user_meta_data ->> 'company_name', 'My Company');
  ttype   := coalesce((new.raw_user_meta_data ->> 'tenant_type')::tenant_type, 'single');
  btype   := coalesce(nullif(new.raw_user_meta_data ->> 'business_type', ''), 'manufacturing');
  base_slug := lower(regexp_replace(company, '[^a-zA-Z0-9]+', '-', 'g'))
               || '-' || substr(new.id::text, 1, 6);

  insert into tenants (name, slug, type, business_type)
    values (company, base_slug, ttype, btype)
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

-- ---------------- M2: invites expire after 7 days ----------------
create or replace function public.invite_details(p_invite uuid)
returns table (email text, role text, company text, status text)
language sql stable security definer set search_path = public as $$
  select i.email, i.role::text, t.name,
         case when i.status = 'pending' and i.created_at <= now() - interval '7 days' then 'expired' else i.status end
    from staff_invites i
    join tenants t on t.id = i.tenant_id
   where i.id = p_invite;
$$;
revoke all on function public.invite_details(uuid) from public;
grant execute on function public.invite_details(uuid) to anon, authenticated;

create or replace function public.invite_claim_existing(p_invite uuid)
returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_inv  record;
  v_user record;
  v_prof record;
begin
  select * into v_inv from staff_invites where id = p_invite;
  if not found or v_inv.created_at <= now() - interval '7 days' then
    return jsonb_build_object('state', 'no_invite');   -- missing, cancelled or expired
  end if;

  select id, last_sign_in_at into v_user
    from auth.users where lower(email) = lower(v_inv.email)
   limit 1;
  if not found then
    if v_inv.status <> 'pending' then
      return jsonb_build_object('state', 'no_invite');
    end if;
    return jsonb_build_object('state', 'no_user', 'email', v_inv.email);
  end if;

  select * into v_prof from profiles where id = v_user.id;

  if not found then
    if v_inv.status <> 'pending' then
      return jsonb_build_object('state', 'no_invite');
    end if;
    insert into profiles (id, tenant_id, branch_id, role, email)
    values (v_user.id, v_inv.tenant_id,
            coalesce(v_inv.branch_id, public.default_branch_id(v_inv.tenant_id)),
            v_inv.role, v_inv.email);
    update staff_invites set status = 'accepted' where id = v_inv.id;
    return jsonb_build_object('state', 'attached', 'user_id', v_user.id);
  end if;

  if v_prof.tenant_id <> v_inv.tenant_id then
    return jsonb_build_object('state', 'other_tenant');
  end if;

  if v_user.last_sign_in_at is not null then
    return jsonb_build_object('state', 'has_password');
  end if;

  update staff_invites set status = 'accepted' where id = v_inv.id and status = 'pending';
  return jsonb_build_object('state', 'same_tenant', 'user_id', v_user.id);
end;
$$;
revoke all on function public.invite_claim_existing(uuid) from public, anon, authenticated;
grant execute on function public.invite_claim_existing(uuid) to service_role;

-- ---------------- C2: billing fields belong to the server ----------------
create or replace function public.guard_tenant_billing()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- The server (service role, no signed-in user) and platform admins may.
  if auth.uid() is null or public.is_platform_admin() then
    return NEW;
  end if;
  if (NEW.plan, NEW.trial_ends_at, NEW.plan_expires_at, NEW.is_active,
      NEW.assistant_monthly_limit, NEW.founding_number, NEW.founding_since)
     is distinct from
     (OLD.plan, OLD.trial_ends_at, OLD.plan_expires_at, OLD.is_active,
      OLD.assistant_monthly_limit, OLD.founding_number, OLD.founding_since) then
    raise exception 'Your plan can only be changed by paying under Settings, Billing.'
      using errcode = 'insufficient_privilege';
  end if;
  return NEW;
end $$;
drop trigger if exists trg_guard_tenant_billing on tenants;
create trigger trg_guard_tenant_billing before update on tenants
  for each row execute function public.guard_tenant_billing();

-- ---------------- L3: pay links start unpaid ----------------
create or replace function public.guard_payment_link_insert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    NEW.status := 'pending';
    NEW.created_by := auth.uid();
  end if;
  return NEW;
end $$;
drop trigger if exists trg_guard_payment_link_insert on payment_links;
create trigger trg_guard_payment_link_insert before insert on payment_links
  for each row execute function public.guard_payment_link_insert();

-- ---------------- L2: logos viewable by link, not listable ----------------
-- The bucket is public, so a logo's link works without any read rule.
drop policy if exists "logos read" on storage.objects;
-- A business can still see (and replace) its own logo files.
drop policy if exists "logos read own" on storage.objects;
create policy "logos read own" on storage.objects for select to authenticated
  using (bucket_id = 'logos' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

-- ---------------- L1: who can call database functions ----------------
-- Postgres and Supabase let everyone (including visitors who aren't
-- signed in) call every function by default. Take that away, keep exactly
-- what signed-in users and the server could already call, and give
-- visitors back only what public pages use.
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig,
           has_function_privilege('authenticated', p.oid, 'execute') as auth_ok,
           has_function_privilege('service_role', p.oid, 'execute') as svc_ok
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.prokind in ('f', 'p')
       and pg_get_userbyid(p.proowner) = current_user
  loop
    execute format('revoke execute on routine %s from public, anon', r.sig);
    if r.auth_ok then execute format('grant execute on routine %s to authenticated', r.sig); end if;
    if r.svc_ok then execute format('grant execute on routine %s to service_role', r.sig); end if;
  end loop;
end $$;
grant execute on function public.invite_details(uuid) to anon;
grant execute on function public.founding_spots_left() to anon;

-- Internal helpers: only other database functions use these.
revoke execute on function public.branch_name(uuid) from authenticated;
-- effective_plan stays callable when signed in: the plan-limit checks use it.
revoke execute on function public.default_branch_id(uuid) from authenticated;
revoke execute on function public.money_default_account(uuid) from authenticated;
revoke execute on function public.money_till_account(uuid, uuid) from authenticated;
revoke execute on function public.money_account_for(uuid, uuid, uuid, uuid, uuid) from authenticated;

-- Functions added later follow the same rule.
alter default privileges in schema public revoke execute on functions from public, anon;
alter default privileges in schema public grant execute on functions to authenticated, service_role;
