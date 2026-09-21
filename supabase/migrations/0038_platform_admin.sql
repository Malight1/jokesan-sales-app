-- ============================================================
-- StockFlow — Super Admin dashboard: analytics, payments ledger,
-- manual tenant support actions, and in-app support tickets.
-- Run AFTER 0001–0037.
--
-- plan_tier note: the enum only had trial|starter|growth|enterprise
-- at 0001_init.sql, but 0019 already added 'business', and
-- plan_level() (0021) already compares plan as ::text for exactly
-- this reason. Every query below groups/compares on ::text, never
-- the raw enum, to stay consistent with that.
--
-- Money note: activate_subscription() (0010) inserts a NEW
-- subscriptions row on every payment (signup, renewal, or plan
-- change) rather than updating one, so `subscriptions` is a real
-- payment ledger. Summing it as "current MRR" would double-count a
-- tenant who has renewed more than once, so MRR is computed
-- client-side from tenants.plan (like SuperAdmin.tsx already does),
-- while "revenue collected" here legitimately sums real payment rows.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Support tickets
-- ------------------------------------------------------------
create type ticket_status as enum ('open', 'in_progress', 'resolved', 'closed');
create type ticket_sender as enum ('tenant', 'admin');

create table support_tickets (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references tenants(id) on delete cascade,
  created_by  uuid references profiles(id) on delete set null,
  subject     text not null,
  status      ticket_status not null default 'open',
  priority    text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table support_ticket_messages (
  id          uuid primary key default gen_random_uuid(),
  ticket_id   uuid not null references support_tickets(id) on delete cascade,
  sender_type ticket_sender not null,
  sender_id   uuid references auth.users(id) on delete set null,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index if not exists idx_support_tickets_tenant on support_tickets (tenant_id, updated_at desc);
create index if not exists idx_support_ticket_messages_ticket on support_ticket_messages (ticket_id, created_at asc);

create trigger trg_set_tenant before insert on support_tickets
  for each row execute function public.set_tenant_id();

-- Fills created_by from the signed-in user, same "let a trigger fill
-- what RLS needs" convention as set_tenant_id().
create or replace function public.set_ticket_created_by()
returns trigger language plpgsql as $$
begin
  if new.created_by is null then
    new.created_by := (select id from profiles where id = auth.uid());
  end if;
  return new;
end $$;
create trigger trg_set_ticket_created_by before insert on support_tickets
  for each row execute function public.set_ticket_created_by();

create or replace function public.set_ticket_message_sender()
returns trigger language plpgsql as $$
begin
  if new.sender_type = 'tenant' and new.sender_id is null then
    new.sender_id := auth.uid();
  end if;
  return new;
end $$;
create trigger trg_set_ticket_sender before insert on support_ticket_messages
  for each row execute function public.set_ticket_message_sender();

alter table support_tickets enable row level security;
alter table support_ticket_messages enable row level security;

create policy tickets_tenant_select on support_tickets for select
  using (tenant_id = public.current_tenant_id());
create policy tickets_tenant_insert on support_tickets for insert
  with check (tenant_id = public.current_tenant_id());

create policy ticket_messages_tenant_select on support_ticket_messages for select
  using (exists (
    select 1 from support_tickets st
    where st.id = ticket_id and st.tenant_id = public.current_tenant_id()
  ));
create policy ticket_messages_tenant_insert on support_ticket_messages for insert
  with check (
    sender_type = 'tenant'
    and exists (
      select 1 from support_tickets st
      where st.id = ticket_id and st.tenant_id = public.current_tenant_id()
    )
  );

grant select, insert on support_tickets, support_ticket_messages to authenticated;

-- ------------------------------------------------------------
-- 2. Admin-side ticket RPCs (SECURITY DEFINER, is_platform_admin() guarded)
-- ------------------------------------------------------------
create or replace function public.platform_tickets(p_status text default null)
returns table (
  id uuid, tenant_id uuid, tenant_name text, subject text, status ticket_status,
  priority text, created_at timestamptz, updated_at timestamptz,
  message_count bigint, last_message_at timestamptz
) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select st.id, st.tenant_id, t.name, st.subject, st.status, st.priority, st.created_at, st.updated_at,
           (select count(*) from support_ticket_messages m where m.ticket_id = st.id),
           (select max(m.created_at) from support_ticket_messages m where m.ticket_id = st.id)
    from support_tickets st
    join tenants t on t.id = st.tenant_id
    where p_status is null or st.status::text = p_status
    order by st.updated_at desc;
end $$;

create or replace function public.platform_ticket_messages(p_ticket_id uuid)
returns table (id uuid, sender_type ticket_sender, sender_name text, body text, created_at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select m.id, m.sender_type,
           case when m.sender_type = 'admin' then 'StockFlow Support' else coalesce(p.full_name, 'Team member') end,
           m.body, m.created_at
    from support_ticket_messages m
    left join profiles p on p.id = m.sender_id and m.sender_type = 'tenant'
    where m.ticket_id = p_ticket_id
    order by m.created_at asc;
end $$;

create or replace function public.platform_reply_ticket(p_ticket_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  insert into support_ticket_messages (ticket_id, sender_type, sender_id, body)
  values (p_ticket_id, 'admin', auth.uid(), p_body);
  update support_tickets set updated_at = now(),
    status = case when status = 'open' then 'in_progress' else status end
  where id = p_ticket_id;
end $$;

create or replace function public.platform_update_ticket_status(p_ticket_id uuid, p_status text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  update support_tickets set status = p_status::ticket_status, updated_at = now() where id = p_ticket_id;
end $$;

-- ------------------------------------------------------------
-- 3. Manual tenant support actions (bank-transfer activation,
--    trial extensions) — every one logged into that tenant's own
--    audit_logs, since log_audit() stamps the CALLER's tenant and a
--    platform admin has none.
-- ------------------------------------------------------------
create or replace function public.platform_extend_trial(p_tenant_id uuid, p_days int default 7)
returns void language plpgsql security definer set search_path = public as $$
declare v_new timestamptz;
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  update tenants set trial_ends_at = greatest(trial_ends_at, now()) + (p_days || ' days')::interval
    where id = p_tenant_id
    returning trial_ends_at into v_new;
  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
    values (p_tenant_id, auth.uid(), 'platform.extend_trial', 'tenants', p_tenant_id::text,
            jsonb_build_object('days', p_days, 'new_trial_ends_at', v_new));
end $$;

create or replace function public.platform_change_plan(p_tenant_id uuid, p_plan plan_tier, p_expires_at timestamptz default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  update tenants set plan = p_plan,
    plan_expires_at = coalesce(p_expires_at, now() + interval '30 days'),
    is_active = true
  where id = p_tenant_id;
  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
    values (p_tenant_id, auth.uid(), 'platform.change_plan', 'tenants', p_tenant_id::text,
            jsonb_build_object('plan', p_plan, 'expires_at', p_expires_at));
end $$;

-- platform_set_active() (0009) didn't log anything — add that now,
-- and it's also what powers the "churned this month" stat below.
create or replace function public.platform_set_active(p_tenant uuid, p_active boolean)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  update tenants set is_active = p_active where id = p_tenant;
  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
    values (p_tenant, auth.uid(), case when p_active then 'platform.reactivate' else 'platform.suspend' end,
            'tenants', p_tenant::text, jsonb_build_object('is_active', p_active));
end $$;

-- ------------------------------------------------------------
-- 4. Analytics, payments ledger, tenant detail
-- ------------------------------------------------------------
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
      (select count(*) from support_tickets where status in ('open', 'in_progress')),
      (select count(distinct tenant_id) from audit_logs
         where action = 'platform.suspend' and created_at >= date_trunc('month', now()));
end $$;

create or replace function public.platform_signups_series(p_months int default 12)
returns table (month date, signups bigint)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select d::date, count(t.id)
    from generate_series(date_trunc('month', now()) - (p_months - 1) * interval '1 month',
                          date_trunc('month', now()), interval '1 month') d
    left join tenants t on date_trunc('month', t.created_at) = d
    group by d order by d;
end $$;

create or replace function public.platform_revenue_series(p_months int default 12)
returns table (month date, revenue numeric)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select d::date, coalesce((select sum(s.amount) from subscriptions s
                               where date_trunc('month', s.created_at) = d), 0)
    from generate_series(date_trunc('month', now()) - (p_months - 1) * interval '1 month',
                          date_trunc('month', now()), interval '1 month') d
    order by d;
end $$;

create or replace function public.platform_plan_distribution()
returns table (plan text, tenant_count bigint)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select t.plan::text, count(*) from tenants t
    group by t.plan::text order by public.plan_level(t.plan::text);
end $$;

-- "Who paid, how much, for what plan" — the actual payments ledger.
create or replace function public.platform_payments(p_tenant_id uuid default null)
returns table (
  id uuid, tenant_id uuid, tenant_name text, plan plan_tier, amount numeric,
  provider text, status text, reference text, created_at timestamptz, current_period_end timestamptz
) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select s.id, s.tenant_id, t.name, s.plan, s.amount, s.provider, s.status,
           s.paystack_sub_code, s.created_at, s.current_period_end
    from subscriptions s
    join tenants t on t.id = s.tenant_id
    where p_tenant_id is null or s.tenant_id = p_tenant_id
    order by s.created_at desc;
end $$;

-- Tenants who need outreach before something breaks for them.
create or replace function public.platform_needs_attention()
returns table (tenant_id uuid, tenant_name text, kind text, detail text, at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select t.id, t.name, 'trial_expiring', 'Trial ends ' || to_char(t.trial_ends_at, 'DD Mon'), t.trial_ends_at
    from tenants t
    where t.plan::text = 'trial' and t.trial_ends_at between now() and now() + interval '7 days'
    union all
    select t.id, t.name, 'renewal_due', 'Plan expires ' || to_char(t.plan_expires_at, 'DD Mon'), t.plan_expires_at
    from tenants t
    where t.plan::text <> 'trial' and t.plan_expires_at between now() and now() + interval '7 days'
    union all
    select t.id, t.name, 'past_due', 'Plan expired ' || to_char(t.plan_expires_at, 'DD Mon'), t.plan_expires_at
    from tenants t
    where t.plan::text <> 'trial' and t.is_active and t.plan_expires_at < now()
    order by at asc;
end $$;

create or replace function public.platform_tenant_detail(p_tenant_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_result jsonb;
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  select jsonb_build_object(
    'tenant', (select to_jsonb(t) from tenants t where t.id = p_tenant_id),
    'profiles', (select coalesce(jsonb_agg(p), '[]'::jsonb) from profiles p where p.tenant_id = p_tenant_id),
    'branches', (select coalesce(jsonb_agg(b), '[]'::jsonb) from branches b where b.tenant_id = p_tenant_id),
    'payments', (select coalesce(jsonb_agg(s order by s.created_at desc), '[]'::jsonb) from subscriptions s where s.tenant_id = p_tenant_id),
    'recent_activity', (select coalesce(jsonb_agg(a order by a.created_at desc), '[]'::jsonb)
                         from (select * from audit_logs where tenant_id = p_tenant_id order by created_at desc limit 20) a)
  ) into v_result;
  return v_result;
end $$;

-- ------------------------------------------------------------
-- 5. Grants
-- ------------------------------------------------------------
grant execute on function public.platform_overview_stats()                     to authenticated;
grant execute on function public.platform_signups_series(int)                  to authenticated;
grant execute on function public.platform_revenue_series(int)                  to authenticated;
grant execute on function public.platform_plan_distribution()                  to authenticated;
grant execute on function public.platform_payments(uuid)                       to authenticated;
grant execute on function public.platform_needs_attention()                    to authenticated;
grant execute on function public.platform_tenant_detail(uuid)                  to authenticated;
grant execute on function public.platform_extend_trial(uuid, int)              to authenticated;
grant execute on function public.platform_change_plan(uuid, plan_tier, timestamptz) to authenticated;
grant execute on function public.platform_tickets(text)                        to authenticated;
grant execute on function public.platform_ticket_messages(uuid)                to authenticated;
grant execute on function public.platform_reply_ticket(uuid, text)             to authenticated;
grant execute on function public.platform_update_ticket_status(uuid, text)     to authenticated;
