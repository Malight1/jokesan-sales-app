-- ============================================================
-- StockFlow — support tooling: a ticket queue that tells you who is
-- waiting on whom, replies that actually surface, admin attachments,
-- admin-started conversations, and a read-only diagnostic snapshot of
-- any business so the platform admin can work out what's wrong.
-- Run AFTER 0001–0048.
--
-- What was broken before this:
--   - A customer's reply didn't touch support_tickets at all (tenants
--     have no UPDATE policy on it), so a follow-up on a resolved ticket
--     stayed "resolved" and never resurfaced in the admin queue, which
--     sorts by updated_at.
--   - Nothing recorded who spoke last, so "Open Tickets: awaiting a
--     reply" counted tickets that were really waiting on the customer.
--   - Neither side could tell there was something new to read.
--   - The admin could only reply with text, and only on a ticket the
--     customer had opened first.
--   - Diagnosing "my stock is wrong" or "I can't log in" meant asking the
--     customer for screenshots: the admin had no view into their data,
--     their sign-in state, or their activity.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Who spoke last, and whether each side has read it
-- ------------------------------------------------------------
-- Unread is a flag the message trigger sets, not a seen-at timestamp
-- compared against last_message_at: two writes in the same transaction
-- share one now(), and a timestamp race is the last thing a "did they
-- reply?" indicator should depend on.
alter table support_tickets
  add column if not exists last_message_at timestamptz,
  add column if not exists last_sender     ticket_sender,
  add column if not exists tenant_unread   boolean not null default false,
  add column if not exists admin_unread    boolean not null default false;

update support_tickets st
   set last_message_at = m.created_at, last_sender = m.sender_type
  from (select distinct on (ticket_id) ticket_id, created_at, sender_type
          from support_ticket_messages order by ticket_id, created_at desc) m
 where m.ticket_id = st.id;

-- Everything that exists today counts as read by both sides (the
-- column default), so the first deploy doesn't light up every old
-- conversation as new. "Waiting on a reply" is a separate question
-- (last_sender), unaffected by this.

-- Every message keeps the ticket's summary current. SECURITY DEFINER
-- because a tenant has no UPDATE policy on support_tickets (on purpose:
-- they mustn't be able to change status or priority themselves).
create or replace function public.on_ticket_message()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update support_tickets set
    last_message_at = new.created_at,
    last_sender     = new.sender_type,
    updated_at      = now(),
    -- A customer writing back on a finished ticket means it isn't finished.
    status = case when new.sender_type = 'tenant' and status in ('resolved', 'closed')
                  then 'open'::ticket_status else status end,
    -- New for the other side; whoever just wrote has obviously read it.
    tenant_unread = (new.sender_type = 'admin'),
    admin_unread  = (new.sender_type = 'tenant')
  where id = new.ticket_id;
  return new;
end $$;

drop trigger if exists trg_ticket_message_after on support_ticket_messages;
create trigger trg_ticket_message_after after insert on support_ticket_messages
  for each row execute function public.on_ticket_message();

-- The customer marks a ticket read by opening it.
create or replace function public.mark_ticket_seen(p_ticket_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update support_tickets set tenant_unread = false
   where id = p_ticket_id and tenant_id = public.current_tenant_id();
end $$;

create or replace function public.platform_mark_ticket_seen(p_ticket_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  update support_tickets set admin_unread = false where id = p_ticket_id;
end $$;

-- ------------------------------------------------------------
-- 2. The admin queue: waiting-on-you first, plus who filed it
-- ------------------------------------------------------------
drop function if exists public.platform_tickets(text);
create function public.platform_tickets(
  p_status    text default null,
  p_tenant_id uuid default null,
  p_ticket_id uuid default null
)
returns table (
  id uuid, tenant_id uuid, tenant_name text, subject text, category text, status ticket_status,
  priority text, created_at timestamptz, updated_at timestamptz,
  message_count bigint, last_message_at timestamptz, last_sender ticket_sender,
  awaiting_reply boolean, unread boolean,
  created_by uuid, created_by_name text, created_by_email text
) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select st.id, st.tenant_id, t.name, st.subject, st.category, st.status, st.priority,
           st.created_at, st.updated_at,
           (select count(*) from support_ticket_messages m where m.ticket_id = st.id),
           st.last_message_at, st.last_sender,
           (st.last_sender = 'tenant' and st.status in ('open', 'in_progress')),
           st.admin_unread,
           st.created_by, p.full_name, coalesce(p.email, u.email)
      from support_tickets st
      join tenants t on t.id = st.tenant_id
      left join profiles p on p.id = st.created_by
      left join auth.users u on u.id = st.created_by
     where (p_status    is null or st.status::text = p_status)
       and (p_tenant_id is null or st.tenant_id = p_tenant_id)
       and (p_ticket_id is null or st.id = p_ticket_id)
     order by (st.last_sender = 'tenant' and st.status in ('open', 'in_progress')) desc,
              st.updated_at desc;
end $$;

-- ------------------------------------------------------------
-- 3. Admin replies return their message id, so files can follow
-- ------------------------------------------------------------
drop function if exists public.platform_reply_ticket(uuid, text);
create function public.platform_reply_ticket(p_ticket_id uuid, p_body text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Write a reply first.'; end if;
  if not exists (select 1 from support_tickets where id = p_ticket_id) then
    raise exception 'Ticket not found.';
  end if;
  insert into support_ticket_messages (ticket_id, sender_type, sender_id, body)
  values (p_ticket_id, 'admin', auth.uid(), trim(p_body))
  returning id into v_id;
  update support_tickets set status = 'in_progress' where id = p_ticket_id and status = 'open';
  return v_id;
end $$;

-- Admin may put files into a ticket's folder (read was already allowed
-- in 0039). The path is checked against the ticket's own business in
-- platform_add_ticket_attachment, so a file can't be filed under the
-- wrong tenant's ticket.
drop policy if exists "ticket-attachments admin write" on storage.objects;
create policy "ticket-attachments admin write" on storage.objects for insert to authenticated
  with check (bucket_id = 'ticket-attachments' and public.is_platform_admin());

create or replace function public.platform_add_ticket_attachment(
  p_message_id uuid, p_file_name text, p_storage_path text, p_content_type text, p_size bigint
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_tenant uuid; v_id uuid;
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  select st.tenant_id into v_tenant
    from support_ticket_messages m join support_tickets st on st.id = m.ticket_id
   where m.id = p_message_id and m.sender_type = 'admin';
  if v_tenant is null then raise exception 'Message not found.'; end if;
  if split_part(p_storage_path, '/', 1) <> v_tenant::text then
    raise exception 'That file is stored under a different business.';
  end if;
  insert into support_ticket_attachments (message_id, tenant_id, file_name, storage_path, content_type, size_bytes)
  values (p_message_id, v_tenant, p_file_name, p_storage_path, p_content_type, p_size)
  returning id into v_id;
  return v_id;
end $$;

-- ------------------------------------------------------------
-- 4. Admin can start a conversation (failed payment, a problem spotted
--    in their data, a heads-up) instead of waiting to be asked
-- ------------------------------------------------------------
create or replace function public.platform_open_ticket(
  p_tenant_id uuid, p_subject text, p_category text, p_body text
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_ticket uuid;
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  if not exists (select 1 from tenants where id = p_tenant_id) then raise exception 'Business not found.'; end if;
  if coalesce(trim(p_subject), '') = '' then raise exception 'Give the conversation a subject.'; end if;
  if coalesce(trim(p_body), '') = '' then raise exception 'Write a message first.'; end if;

  insert into support_tickets (tenant_id, subject, category, status)
  values (p_tenant_id, trim(p_subject), coalesce(nullif(p_category, ''), 'other'), 'in_progress')
  returning id into v_ticket;
  -- set_ticket_created_by() fills created_by from the caller's own
  -- profile, which for an admin is either nothing or a profile in some
  -- other business. Neither is who "filed" this, so clear it.
  update support_tickets set created_by = null where id = v_ticket;

  insert into support_ticket_messages (ticket_id, sender_type, sender_id, body)
  values (v_ticket, 'admin', auth.uid(), trim(p_body));

  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
  values (p_tenant_id, auth.uid(), 'platform.open_ticket', 'support_ticket', v_ticket::text,
          jsonb_build_object('subject', trim(p_subject)));
  return v_ticket;
end $$;

-- Some support actions happen entirely in the browser (a password reset
-- or confirmation email goes straight to Supabase Auth). This leaves the
-- same trail on the business that server-side actions already do.
create or replace function public.platform_log_action(p_tenant_id uuid, p_action text, p_meta jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  if p_action not in ('platform.password_reset_sent', 'platform.confirmation_resent') then
    raise exception 'Unknown action %', p_action;
  end if;
  insert into audit_logs (tenant_id, user_id, action, entity, meta)
  values (p_tenant_id, auth.uid(), p_action, 'tenant', coalesce(p_meta, '{}'::jsonb));
end $$;

-- ------------------------------------------------------------
-- 5. A read-only look inside one business, for diagnosing problems
-- ------------------------------------------------------------
-- Nothing here can change their data. Everything a support person needs
-- to answer the common tickets without asking for screenshots:
--   "I can't log in"        -> users: confirmed email? last sign-in? deactivated?
--   "I can't save anything" -> access: suspended / trial or plan expired
--   "My stock is wrong"     -> stock_issues: same books-balance check the
--                              test suite runs (record vs batches vs ledger)
--   "A sale disappeared"    -> recent_sales (voided ones included), recent_audit
create or replace function public.platform_tenant_snapshot(p_tenant_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_t tenants%rowtype;
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  select * into v_t from tenants where id = p_tenant_id;
  if not found then raise exception 'Business not found.'; end if;

  return jsonb_build_object(
    -- Same rule as tenant_is_live() (0017), worked out for this tenant
    -- rather than the caller's.
    'access', jsonb_build_object(
      'can_write', v_t.is_active
                   and (v_t.plan::text <> 'trial' or v_t.trial_ends_at is null or v_t.trial_ends_at > now())
                   and (v_t.plan_expires_at is null or v_t.plan_expires_at > now()),
      'reason', case
                  when not v_t.is_active then 'suspended'
                  when v_t.plan::text = 'trial' and v_t.trial_ends_at <= now() then 'trial_expired'
                  when v_t.plan_expires_at <= now() then 'plan_expired'
                end),
    'counts', jsonb_build_object(
      'products',  (select count(*) from finished_goods where tenant_id = p_tenant_id),
      'materials', (select count(*) from materials      where tenant_id = p_tenant_id),
      'customers', (select count(*) from customers      where tenant_id = p_tenant_id),
      'suppliers', (select count(*) from suppliers      where tenant_id = p_tenant_id),
      'sales',     (select count(*) from sales_orders    where tenant_id = p_tenant_id and not voided),
      'purchases', (select count(*) from purchase_orders where tenant_id = p_tenant_id and not voided),
      'branches',  (select count(*) from branches        where tenant_id = p_tenant_id and is_active)),
    'last_sale_at',     (select max(created_at) from sales_orders where tenant_id = p_tenant_id),
    'last_activity_at', (select max(created_at) from audit_logs
                          where tenant_id = p_tenant_id and action not like 'platform.%'),
    'users', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id, 'full_name', p.full_name, 'email', coalesce(p.email, u.email),
               'phone', p.phone, 'role', p.role, 'is_active', p.is_active,
               'last_sign_in_at', u.last_sign_in_at, 'email_confirmed_at', u.email_confirmed_at,
               'created_at', p.created_at) order by p.created_at), '[]'::jsonb)
        from profiles p left join auth.users u on u.id = p.id
       where p.tenant_id = p_tenant_id),
    'stock_issues', (
      select coalesce(jsonb_agg(x order by x.name), '[]'::jsonb) from (
        select 'finished_good' as kind, g.id, g.name, g.unit,
               g.qty_balance as on_record,
               coalesce((select sum(b.qty_remaining) from fg_batches b where b.finished_good_id = g.id), 0) as in_batches,
               coalesce((select sum(s.quantity) from stock_movements s where s.product_id = g.id), 0) as in_ledger
          from finished_goods g where g.tenant_id = p_tenant_id
        union all
        select 'material', m.id, m.name, m.unit,
               m.qty_balance,
               coalesce((select sum(pi.qty_remaining) from purchase_items pi where pi.material_id = m.id), 0),
               coalesce((select sum(s.quantity) from stock_movements s where s.product_id = m.id), 0)
          from materials m where m.tenant_id = p_tenant_id
      ) x
      where x.on_record <> x.in_batches or x.on_record <> x.in_ledger or x.on_record < 0),
    'recent_sales', (
      select coalesce(jsonb_agg(s), '[]'::jsonb) from (
        select so.id, so.doc_no, so.transaction_date, so.total_amount, so.amount_paid, so.balance,
               so.payment_status, so.voided, so.created_at
          from sales_orders so where so.tenant_id = p_tenant_id
         order by so.created_at desc limit 10) s),
    'recent_purchases', (
      select coalesce(jsonb_agg(po), '[]'::jsonb) from (
        select o.id, o.doc_no, o.purchase_date, o.total_amount, o.total_paid, o.balance,
               o.status, o.voided, o.created_at
          from purchase_orders o where o.tenant_id = p_tenant_id
         order by o.created_at desc limit 10) po),
    'recent_audit', (
      select coalesce(jsonb_agg(a), '[]'::jsonb) from (
        select al.id, al.action, al.entity, al.entity_id, al.meta, al.created_at,
               coalesce(p.full_name, u.email, case when al.action like 'platform.%' then 'StockFlow admin' end) as actor
          from audit_logs al
          left join profiles p on p.id = al.user_id and p.tenant_id = p_tenant_id
          left join auth.users u on u.id = al.user_id
         where al.tenant_id = p_tenant_id
         order by al.created_at desc limit 30) a)
  );
end $$;

-- ------------------------------------------------------------
-- 6. Overview numbers that mean what they say
-- ------------------------------------------------------------
-- open_tickets was open + in_progress, shown as "awaiting a reply", but
-- in_progress usually means waiting on the customer. Same columns, so
-- the dashboard keeps working; the number is now what the label says.
create or replace function public.platform_overview_stats()
returns table (
  total_tenants bigint, active_tenants bigint, trial_tenants bigint, suspended_tenants bigint,
  signups_this_month bigint, revenue_this_month numeric, open_tickets bigint,
  churned_this_month bigint
) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select
      (select count(*) from tenants),
      (select count(*) from tenants where is_active),
      (select count(*) from tenants where plan::text = 'trial'),
      (select count(*) from tenants where not is_active),
      (select count(*) from tenants where created_at >= date_trunc('month', now())),
      coalesce((select sum(amount) from subscriptions where created_at >= date_trunc('month', now())), 0),
      (select count(*) from support_tickets where status in ('open', 'in_progress') and last_sender = 'tenant'),
      (select count(distinct tenant_id) from audit_logs
         where action = 'platform.suspend' and created_at >= date_trunc('month', now()));
end $$;

-- Needs Attention gains the two support problems that otherwise sit
-- unnoticed: a customer waiting on a reply, and an owner who signed up
-- but never confirmed their email (so can't sign in at all). ref_id is
-- the ticket for a waiting ticket, so the row can link straight to it.
-- Return type changed, so drop first.
drop function if exists public.platform_needs_attention();
create function public.platform_needs_attention()
returns table (tenant_id uuid, tenant_name text, kind text, detail text, at timestamptz, ref_id uuid)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select st.tenant_id, t.name, 'ticket_waiting'::text, st.subject, st.last_message_at as at, st.id as ref_id
      from support_tickets st join tenants t on t.id = st.tenant_id
     where st.status in ('open', 'in_progress') and st.last_sender = 'tenant'
    union all
    select t.id, t.name, 'unconfirmed_owner', 'Owner ' || coalesce(u.email, '') || ' never confirmed their email', t.created_at, null::uuid
      from tenants t
      join profiles p on p.tenant_id = t.id and p.role = 'admin'
      join auth.users u on u.id = p.id
     where u.email_confirmed_at is null and t.created_at > now() - interval '30 days'
    union all
    select t.id, t.name, 'trial_expiring', 'Trial ends ' || to_char(t.trial_ends_at, 'DD Mon'), t.trial_ends_at, null::uuid
      from tenants t
     where t.plan::text = 'trial' and t.trial_ends_at between now() and now() + interval '7 days'
    union all
    select t.id, t.name, 'renewal_due', 'Plan expires ' || to_char(t.plan_expires_at, 'DD Mon'), t.plan_expires_at, null::uuid
      from tenants t
     where t.plan::text <> 'trial' and t.plan_expires_at between now() and now() + interval '7 days'
    union all
    select t.id, t.name, 'past_due', 'Plan expired ' || to_char(t.plan_expires_at, 'DD Mon'), t.plan_expires_at, null::uuid
      from tenants t
     where t.plan::text <> 'trial' and t.is_active and t.plan_expires_at < now()
    order by at asc;
end $$;

grant execute on function public.mark_ticket_seen(uuid)                                   to authenticated;
grant execute on function public.platform_mark_ticket_seen(uuid)                          to authenticated;
grant execute on function public.platform_tickets(text, uuid, uuid)                       to authenticated;
grant execute on function public.platform_reply_ticket(uuid, text)                        to authenticated;
grant execute on function public.platform_add_ticket_attachment(uuid, text, text, text, bigint) to authenticated;
grant execute on function public.platform_open_ticket(uuid, text, text, text)             to authenticated;
grant execute on function public.platform_log_action(uuid, text, jsonb)                   to authenticated;
grant execute on function public.platform_tenant_snapshot(uuid)                           to authenticated;
grant execute on function public.platform_overview_stats()                                to authenticated;
grant execute on function public.platform_needs_attention()                               to authenticated;
