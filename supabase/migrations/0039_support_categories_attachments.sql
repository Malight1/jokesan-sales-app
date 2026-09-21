-- ============================================================
-- StockFlow — Support ticket categories and attachments.
-- Run AFTER 0001–0038.
--
-- Attachments follow the exact private-bucket pattern already proven by
-- delivery-proofs (0031): storage.foldername(name)[1] is the tenant id,
-- so RLS on storage.objects can scope access without a join. The one
-- addition here is a platform-admin override on READ ONLY, so support
-- can actually see what a customer attached — admin never gets WRITE
-- access into a tenant's folder, only read.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Ticket category
-- ------------------------------------------------------------
alter table support_tickets add column if not exists category text not null default 'other'
  check (category in ('billing', 'bug', 'feature_request', 'account', 'stock_data', 'other'));

-- ------------------------------------------------------------
-- 2. Attachments
-- ------------------------------------------------------------
create table if not exists support_ticket_attachments (
  id           uuid primary key default gen_random_uuid(),
  message_id   uuid not null references support_ticket_messages(id) on delete cascade,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  file_name    text not null,
  storage_path text not null,
  content_type text,
  size_bytes   bigint,
  created_at   timestamptz not null default now()
);
create index if not exists idx_ticket_attachments_message on support_ticket_attachments (message_id);

-- Fills tenant_id from the parent message's ticket, same "let a trigger
-- fill what RLS needs" convention as set_tenant_id().
create or replace function public.set_ticket_attachment_tenant()
returns trigger language plpgsql as $$
begin
  if new.tenant_id is null then
    select st.tenant_id into new.tenant_id
    from support_ticket_messages sm join support_tickets st on st.id = sm.ticket_id
    where sm.id = new.message_id;
  end if;
  return new;
end $$;
create trigger trg_set_ticket_attachment_tenant before insert on support_ticket_attachments
  for each row execute function public.set_ticket_attachment_tenant();

alter table support_ticket_attachments enable row level security;
create policy ticket_attachments_tenant_select on support_ticket_attachments for select
  using (tenant_id = public.current_tenant_id());
create policy ticket_attachments_tenant_insert on support_ticket_attachments for insert
  with check (tenant_id = public.current_tenant_id());

grant select, insert on support_ticket_attachments to authenticated;

-- ------------------------------------------------------------
-- 3. Private storage bucket for attachments
-- ------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('ticket-attachments', 'ticket-attachments', false)
on conflict (id) do nothing;

drop policy if exists "ticket-attachments read" on storage.objects;
create policy "ticket-attachments read" on storage.objects for select to authenticated
  using (bucket_id = 'ticket-attachments' and (
    (storage.foldername(name))[1] = public.current_tenant_id()::text
    or public.is_platform_admin()
  ));

drop policy if exists "ticket-attachments write" on storage.objects;
create policy "ticket-attachments write" on storage.objects for insert to authenticated
  with check (bucket_id = 'ticket-attachments' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

-- ------------------------------------------------------------
-- 4. platform_ticket_messages() now also returns each message's
--    attachments, so the admin queue can show them. Return type
--    changed, so the old function must be dropped first.
-- ------------------------------------------------------------
drop function if exists public.platform_ticket_messages(uuid);
create function public.platform_ticket_messages(p_ticket_id uuid)
returns table (id uuid, sender_type ticket_sender, sender_name text, body text, created_at timestamptz, attachments jsonb)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select m.id, m.sender_type,
           case when m.sender_type = 'admin' then 'StockFlow Support' else coalesce(p.full_name, 'Team member') end,
           m.body, m.created_at,
           coalesce((
             select jsonb_agg(jsonb_build_object('id', a.id, 'file_name', a.file_name, 'storage_path', a.storage_path, 'content_type', a.content_type))
             from support_ticket_attachments a where a.message_id = m.id
           ), '[]'::jsonb)
    from support_ticket_messages m
    left join profiles p on p.id = m.sender_id and m.sender_type = 'tenant'
    where m.ticket_id = p_ticket_id
    order by m.created_at asc;
end $$;
grant execute on function public.platform_ticket_messages(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. platform_tickets() now also surfaces category.
-- ------------------------------------------------------------
drop function if exists public.platform_tickets(text);
create function public.platform_tickets(p_status text default null)
returns table (
  id uuid, tenant_id uuid, tenant_name text, subject text, category text, status ticket_status,
  priority text, created_at timestamptz, updated_at timestamptz,
  message_count bigint, last_message_at timestamptz
) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select st.id, st.tenant_id, t.name, st.subject, st.category, st.status, st.priority, st.created_at, st.updated_at,
           (select count(*) from support_ticket_messages m where m.ticket_id = st.id),
           (select max(m.created_at) from support_ticket_messages m where m.ticket_id = st.id)
    from support_tickets st
    join tenants t on t.id = st.tenant_id
    where p_status is null or st.status::text = p_status
    order by st.updated_at desc;
end $$;
grant execute on function public.platform_tickets(text) to authenticated;
