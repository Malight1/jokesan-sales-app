-- ============================================================
-- StockFlow — More support actions on the platform tenant detail page:
-- deactivate/reactivate one team member, internal admin notes, and
-- viewing/cancelling pending staff invites.
-- Run AFTER 0001–0040.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Deactivate/reactivate one team member
-- ------------------------------------------------------------
create or replace function public.platform_set_profile_active(p_profile_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  select tenant_id into v_tenant from profiles where id = p_profile_id;
  if v_tenant is null then raise exception 'Team member not found.'; end if;
  update profiles set is_active = p_active where id = p_profile_id;
  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
    values (v_tenant, auth.uid(), case when p_active then 'platform.reactivate_user' else 'platform.deactivate_user' end,
            'profiles', p_profile_id::text, jsonb_build_object('is_active', p_active));
end $$;

-- ------------------------------------------------------------
-- 2. Internal admin notes — platform-admin-only, never exposed to the
--    tenant. No grants at all on the table itself (same lockdown as
--    payment_integrations, 0027): every access goes through these
--    SECURITY DEFINER functions instead of direct table access.
-- ------------------------------------------------------------
create table if not exists platform_tenant_notes (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  author_id   uuid references auth.users(id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now()
);
create index if not exists idx_platform_tenant_notes_tenant on platform_tenant_notes (tenant_id, created_at desc);
alter table platform_tenant_notes enable row level security;
-- Deliberately no policies: RLS with none defined denies every row to
-- every role at the PostgREST layer, so this table is reachable only
-- from inside a SECURITY DEFINER function (which runs as the table
-- owner and bypasses RLS), never directly from the client.

create or replace function public.platform_add_tenant_note(p_tenant_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  if trim(coalesce(p_body, '')) = '' then raise exception 'A note needs some text.'; end if;
  insert into platform_tenant_notes (tenant_id, author_id, body) values (p_tenant_id, auth.uid(), trim(p_body));
end $$;

create or replace function public.platform_tenant_notes(p_tenant_id uuid)
returns table (id uuid, body text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select n.id, n.body, n.created_at
    from platform_tenant_notes n
    where n.tenant_id = p_tenant_id
    order by n.created_at desc;
end $$;

-- ------------------------------------------------------------
-- 3. Pending staff invites — view and cancel
-- ------------------------------------------------------------
create or replace function public.platform_tenant_invites(p_tenant_id uuid)
returns table (id uuid, email text, role text, status text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select si.id, si.email, si.role::text, si.status, si.created_at
    from staff_invites si
    where si.tenant_id = p_tenant_id and si.status = 'pending'
    order by si.created_at desc;
end $$;

create or replace function public.platform_cancel_invite(p_invite_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid;
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  select tenant_id into v_tenant from staff_invites where id = p_invite_id;
  if v_tenant is null then raise exception 'Invite not found.'; end if;
  delete from staff_invites where id = p_invite_id;
  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
    values (v_tenant, auth.uid(), 'platform.cancel_invite', 'staff_invites', p_invite_id::text, jsonb_build_object());
end $$;

-- ------------------------------------------------------------
-- 4. Grants
-- ------------------------------------------------------------
grant execute on function public.platform_set_profile_active(uuid, boolean) to authenticated;
grant execute on function public.platform_add_tenant_note(uuid, text)       to authenticated;
grant execute on function public.platform_tenant_notes(uuid)                to authenticated;
grant execute on function public.platform_tenant_invites(uuid)              to authenticated;
grant execute on function public.platform_cancel_invite(uuid)               to authenticated;
