-- ============================================================
-- StockFlow — Business logo storage + Super Admin platform panel
-- Run AFTER 0001–0008.
-- ============================================================

-- ---- Storage bucket for tenant logos (public read) ----
insert into storage.buckets (id, name, public)
values ('logos', 'logos', true)
on conflict (id) do nothing;

-- Any authenticated user may upload/manage a logo under their tenant folder.
-- Path convention: <tenant_id>/logo.png
drop policy if exists "logos read" on storage.objects;
create policy "logos read" on storage.objects for select
  using (bucket_id = 'logos');

drop policy if exists "logos write" on storage.objects;
create policy "logos write" on storage.objects for insert to authenticated
  with check (bucket_id = 'logos');

drop policy if exists "logos update" on storage.objects;
create policy "logos update" on storage.objects for update to authenticated
  using (bucket_id = 'logos');

-- ============================================================
-- SUPER ADMIN (platform owner)
-- ============================================================
create table if not exists platform_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table platform_admins enable row level security;
create policy platform_admins_self on platform_admins for select
  using (user_id = auth.uid());

create or replace function public.is_platform_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists(select 1 from platform_admins where user_id = auth.uid())
$$;

-- Cross-tenant overview for the platform owner. SECURITY DEFINER so it
-- can read every tenant, but it hard-checks is_platform_admin() first.
create or replace function public.platform_tenants()
returns table (
  id uuid, name text, plan plan_tier, is_active boolean, created_at timestamptz,
  users bigint, sales_count bigint, revenue numeric
) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then
    raise exception 'Not authorised';
  end if;
  return query
    select t.id, t.name, t.plan, t.is_active, t.created_at,
           (select count(*) from profiles p where p.tenant_id = t.id),
           (select count(*) from sales_orders s where s.tenant_id = t.id and not s.voided),
           coalesce((select sum(s.total_amount) from sales_orders s where s.tenant_id = t.id and not s.voided), 0)
    from tenants t
    order by t.created_at desc;
end $$;

create or replace function public.platform_set_active(p_tenant uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  update tenants set is_active = p_active where id = p_tenant;
end $$;

grant execute on function public.is_platform_admin() to authenticated;
grant execute on function public.platform_tenants() to authenticated;
grant execute on function public.platform_set_active(uuid, boolean) to authenticated;

-- ============================================================
-- To make yourself the platform owner, run once (replace email):
--   insert into platform_admins (user_id)
--   select id from auth.users where email = 'oguntunde722@gmail.com'
--   on conflict do nothing;
-- ============================================================
