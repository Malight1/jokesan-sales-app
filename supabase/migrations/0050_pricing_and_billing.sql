-- ============================================================
-- ProfixBook — launch pricing and billing.
-- Run AFTER 0001–0049, then redeploy the paystack-verify Edge Function
-- straight away (its old version calls activate_subscription(), which
-- this migration takes away from logged-in users on purpose).
--
-- 1. SECURITY: activate_subscription() was callable by any business
--    admin straight from the browser, with whatever plan and expiry they
--    liked, so anyone could give themselves Business until 2099 for free.
--    The same Paystack reference could also be replayed to keep
--    extending. Payments now go through confirm_subscription_payment(),
--    which only the service role (the Edge Function) can call, checks the
--    amount against the database's own price list, and refuses a
--    reference that has been used before.
-- 2. Prices: Starter 5,000 / Growth 12,000 / Business 25,000 a month.
-- 3. Annual billing: pay 10 months, get 12.
-- 4. Founding customers: the first 60 businesses to pay keep their
--    launch price for life (founding_number 1..60).
-- 5. Starter allows 2 users (owner plus one staff), not 1.
-- 6. The assistant moves to Growth: 20 questions a month on Growth (and
--    on a trial), 100 on Business.
-- 7. Priority support is real: Business tickets rank first in the queue.
-- 8. Reorder suggestions now cover a shop's own products, not only raw
--    materials, worked out from how fast each one actually sells.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Price list, held in the database so the Edge Function can't drift
-- ------------------------------------------------------------
-- What a plan costs today, per month.
create or replace function public.plan_list_price(p_plan text)
returns numeric language sql immutable as $$
  select case p_plan
    when 'starter'  then 5000
    when 'growth'   then 12000
    when 'business' then 25000
  end::numeric
$$;

-- The launch price, frozen. Founding customers pay this for life, even
-- after plan_list_price() goes up. Never edit these numbers.
create or replace function public.plan_founding_price(p_plan text)
returns numeric language sql immutable as $$
  select case p_plan
    when 'starter'  then 5000
    when 'growth'   then 12000
    when 'business' then 25000
  end::numeric
$$;

alter table tenants add column if not exists founding_number int;
alter table tenants add column if not exists founding_since  timestamptz;
create unique index if not exists uq_tenants_founding_number on tenants (founding_number) where founding_number is not null;

-- The monthly price this particular business pays for a plan.
create or replace function public.tenant_plan_price(p_tenant uuid, p_plan text)
returns numeric language sql stable security definer set search_path = public as $$
  select case when t.founding_number is not null then public.plan_founding_price(p_plan)
              else public.plan_list_price(p_plan) end
    from tenants t where t.id = p_tenant
$$;

-- Public: how many founding spots are left, for the website's live count.
-- Returns a number only, never who took them.
create or replace function public.founding_spots_left()
returns int language sql stable security definer set search_path = public as $$
  select greatest(0, 60 - (select count(*) from tenants where founding_number is not null))::int
$$;

-- What the signed-in business pays, and whether it is a founding customer,
-- for the billing screen.
create or replace function public.my_billing()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'founding_number', t.founding_number,
    'founding_since',  t.founding_since,
    'spots_left',      public.founding_spots_left(),
    'prices', jsonb_build_object(
      'starter',  public.tenant_plan_price(t.id, 'starter'),
      'growth',   public.tenant_plan_price(t.id, 'growth'),
      'business', public.tenant_plan_price(t.id, 'business')))
    from tenants t where t.id = public.current_tenant_id()
$$;

-- ------------------------------------------------------------
-- 2. Confirming a payment (service role only)
-- ------------------------------------------------------------
-- Duplicates from before this migration would block the index; the
-- function below refuses a reused reference either way.
do $$
begin
  if not exists (select paystack_sub_code from subscriptions where paystack_sub_code is not null
                  group by 1 having count(*) > 1) then
    create unique index if not exists uq_subscriptions_reference
      on subscriptions (paystack_sub_code) where paystack_sub_code is not null;
  else
    raise notice 'Duplicate Paystack references already exist; unique index skipped. confirm_subscription_payment still refuses reuse.';
  end if;
end $$;

create or replace function public.confirm_subscription_payment(
  p_tenant      uuid,
  p_plan        text,
  p_interval    text,
  p_reference   text,
  p_amount_kobo bigint
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_t        tenants%rowtype;
  v_monthly  numeric;
  v_expected numeric;
  v_months   int;
  v_base     timestamptz;
  v_end      timestamptz;
  v_founding int;
begin
  if p_plan not in ('starter', 'growth', 'business') then raise exception 'Unknown plan %', p_plan; end if;
  if p_interval not in ('monthly', 'annual') then raise exception 'Unknown billing interval %', p_interval; end if;
  if coalesce(trim(p_reference), '') = '' then raise exception 'Missing payment reference.'; end if;
  if exists (select 1 from subscriptions where paystack_sub_code = p_reference) then
    raise exception 'This payment has already been used.';
  end if;

  select * into v_t from tenants where id = p_tenant for update;
  if not found then raise exception 'Business not found.'; end if;

  v_monthly  := public.tenant_plan_price(p_tenant, p_plan);
  v_months   := case when p_interval = 'annual' then 12 else 1 end;
  -- Annual: pay for 10 months, get 12.
  v_expected := v_monthly * case when p_interval = 'annual' then 10 else 1 end;
  if p_amount_kobo < v_expected * 100 then
    raise exception 'Amount paid (₦%) is less than the % % price (₦%).',
      p_amount_kobo / 100.0, p_plan, p_interval, v_expected;
  end if;

  -- Paying before the current paid period ends extends it, rather than
  -- throwing away the days already paid for.
  v_base := case when v_t.plan::text <> 'trial' and v_t.plan_expires_at > now()
                 then v_t.plan_expires_at else now() end;
  v_end  := v_base + make_interval(months => v_months);

  -- Founding customer: the first 60 businesses to pay. Serialised so two
  -- payments landing at once can't both take spot 60.
  v_founding := v_t.founding_number;
  if v_founding is null then
    perform pg_advisory_xact_lock(hashtext('profixbook_founding'));
    if (select count(*) from tenants where founding_number is not null) < 60 then
      select coalesce(max(founding_number), 0) + 1 into v_founding from tenants;
      update tenants set founding_number = v_founding, founding_since = now() where id = p_tenant;
    end if;
  end if;

  update tenants set plan = p_plan::plan_tier, plan_expires_at = v_end, is_active = true where id = p_tenant;

  insert into subscriptions (tenant_id, plan, status, provider, amount, interval, current_period_end, paystack_sub_code)
  values (p_tenant, p_plan::plan_tier, 'active', 'paystack', p_amount_kobo / 100.0, p_interval, v_end, p_reference);

  return jsonb_build_object('plan', p_plan, 'interval', p_interval, 'expires', v_end, 'founding_number', v_founding);
end $$;

-- The old entry point stays defined but nobody outside the database can
-- call it any more. (Platform admins change plans with platform_change_plan.)
revoke execute on function public.activate_subscription(plan_tier, text, numeric, timestamptz) from public, anon, authenticated;
revoke execute on function public.confirm_subscription_payment(uuid, text, text, text, bigint) from public, anon, authenticated;
grant  execute on function public.confirm_subscription_payment(uuid, text, text, text, bigint) to service_role;
revoke execute on function public.tenant_plan_price(uuid, text) from public, anon, authenticated;
grant  execute on function public.tenant_plan_price(uuid, text) to service_role;
grant  execute on function public.founding_spots_left() to anon, authenticated;
grant  execute on function public.my_billing() to authenticated;
grant  execute on function public.plan_list_price(text) to anon, authenticated;

-- ------------------------------------------------------------
-- 3. Starter: 2 users (owner plus one staff member)
-- ------------------------------------------------------------
create or replace function public.plan_user_limit(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'starter'    then 2
    when 'growth'     then 5
    when 'business'   then 15
    when 'enterprise' then 999
    when 'trial'      then 999   -- a trial gets everything so people can try it
    else 1 end
$$;

-- ------------------------------------------------------------
-- 4. The assistant on Growth, with a per-plan monthly allowance
-- ------------------------------------------------------------
create or replace function public.feature_level(p_feature text)
returns int language sql immutable as $$
  select case p_feature
    when 'batch_tracking'  then 2
    when 'price_tiers'     then 2
    when 'quotes'          then 2
    when 'units'           then 2
    when 'deliveries'      then 2
    when 'purchase_orders' then 2
    when 'smart_reorder'   then 2
    when 'assistant'       then 2
    when 'auto_payments'   then 3
    when 'einvoicing'      then 3
    when 'custom_fields'   then 3
    else 1 end
$$;

create or replace function public.plan_assistant_limit(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'growth'     then 20
    when 'business'   then 100
    when 'enterprise' then 500
    when 'trial'      then 20    -- enough to see what it does
    else 0 end
$$;

-- NULL now means "whatever the plan allows". Every business still on the
-- old blanket default of 100 moves to its plan's allowance; one the
-- platform admin deliberately set to something else keeps it.
alter table tenants alter column assistant_monthly_limit drop not null;
alter table tenants alter column assistant_monthly_limit drop default;
update tenants set assistant_monthly_limit = null where assistant_monthly_limit = 100;

create or replace function public.assistant_quota()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_limit  int;
  v_month  date := date_trunc('month', current_date)::date;
  v_used   int;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select coalesce(assistant_monthly_limit, public.plan_assistant_limit(plan::text)) into v_limit
    from tenants where id = v_tenant;
  select question_count into v_used from assistant_usage where tenant_id = v_tenant and month = v_month;
  return jsonb_build_object(
    'enabled', public.tenant_has_feature('assistant'),
    'used', coalesce(v_used, 0), 'limit', v_limit, 'remaining', greatest(0, v_limit - coalesce(v_used, 0))
  );
end $$;

create or replace function public.check_and_record_assistant_question()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_limit  int;
  v_month  date := date_trunc('month', current_date)::date;
  v_used   int;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('assistant', 'The AI assistant');

  select coalesce(assistant_monthly_limit, public.plan_assistant_limit(plan::text)) into v_limit
    from tenants where id = v_tenant;

  insert into assistant_usage (tenant_id, month, question_count)
  values (v_tenant, v_month, 1)
  on conflict (tenant_id, month) do update set question_count = assistant_usage.question_count + 1
  returning question_count into v_used;

  if v_used > v_limit then
    -- Raising rolls back the increment above too, so the stored count
    -- never exceeds the limit.
    raise exception 'This business has used all % assistant questions for this month. It resets on the 1st.', v_limit
      using errcode = 'check_violation';
  end if;

  return jsonb_build_object('used', v_used, 'limit', v_limit, 'remaining', greatest(0, v_limit - v_used));
end $$;

-- ------------------------------------------------------------
-- 5. Priority support: Business tickets first in the queue
-- ------------------------------------------------------------
drop function if exists public.platform_tickets(text, uuid, uuid);
create function public.platform_tickets(
  p_status    text default null,
  p_tenant_id uuid default null,
  p_ticket_id uuid default null
)
returns table (
  id uuid, tenant_id uuid, tenant_name text, tenant_plan text, subject text, category text, status ticket_status,
  priority text, created_at timestamptz, updated_at timestamptz,
  message_count bigint, last_message_at timestamptz, last_sender ticket_sender,
  awaiting_reply boolean, unread boolean,
  created_by uuid, created_by_name text, created_by_email text
) language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select st.id, st.tenant_id, t.name, t.plan::text, st.subject, st.category, st.status, st.priority,
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
              (t.plan::text in ('business', 'enterprise')) desc,
              st.updated_at desc;
end $$;
grant execute on function public.platform_tickets(text, uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 6. Reorder suggestions for a shop's own products
-- ------------------------------------------------------------
-- Same signature and maths as 0037's version (rebased on it). The
-- materials half is unchanged. A retail business now also gets one row
-- per product, from daily SALE movements instead of PRODUCTION usage,
-- with on-hand from its fg_batches layers and the supplier it last
-- bought that product from. A manufacturer's finished goods are produced,
-- not bought, so they still get no "order this" row.
create or replace function public.reorder_suggestions(p_branch uuid default null)
returns table (
  product_kind   text,
  product_id     uuid,
  name           text,
  unit           text,
  branch_id      uuid,
  daily_usage    numeric,
  daily_stddev   numeric,
  on_hand        numeric,
  on_order       numeric,
  lead_time_days numeric,
  supplier_id    uuid,
  supplier_name  text,
  safety_stock   numeric,
  reorder_point  numeric,
  cover_days     int,
  suggested_qty  numeric,
  reason         text
)
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_branch  uuid;
  v_z       numeric;
  v_cover   int;
  v_default_lead numeric;
  v_retail  boolean;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('admin', 'inventory') then
    raise exception 'Your role is not allowed to view reorder suggestions.' using errcode = 'insufficient_privilege';
  end if;
  perform public.require_feature('smart_reorder', 'Smart reorder suggestions');
  v_branch := public.resolve_branch(p_branch);

  select t.reorder_z, t.reorder_cover_days, t.reorder_default_lead_days, t.business_type = 'retail'
    into v_z, v_cover, v_default_lead, v_retail
    from tenants t where t.id = v_tenant;

  -- Materials (unchanged from 0037).
  return query
  with days as (
    select gs::date as d from generate_series(current_date - 89, current_date, interval '1 day') gs
  ),
  mats as (
    select materials.id, materials.name, materials.unit from materials where materials.tenant_id = v_tenant
  ),
  daily_use as (
    select m.id as material_id, d.d,
           coalesce(-sum(sm.quantity), 0) as used
      from mats m
      cross join days d
      left join stock_movements sm
        on sm.tenant_id = v_tenant and sm.branch_id = v_branch
       and sm.product_kind = 'material' and sm.product_id = m.id
       and sm.movement_type = 'PRODUCTION' and sm.quantity < 0
       and sm.created_at::date = d.d
     group by m.id, d.d
  ),
  stats as (
    select material_id,
           avg(used) filter (where d >= current_date - 29) as avg30,
           avg(used) as avg90,
           stddev_pop(used) as sd
      from daily_use
     group by material_id
  ),
  on_hand_calc as (
    select purchase_items.material_id, sum(purchase_items.qty_remaining) as qty
      from purchase_items
     where purchase_items.tenant_id = v_tenant and purchase_items.branch_id = v_branch
     group by purchase_items.material_id
  ),
  on_order_calc as (
    select pol.material_id, sum(pol.qty_ordered - pol.qty_received) as qty
      from purchase_order_lines pol
      join purchase_orders po on po.id = pol.purchase_order_id
     where po.tenant_id = v_tenant and po.branch_id = v_branch and po.status in ('ordered', 'partial')
     group by pol.material_id
  ),
  last_supplier as (
    select distinct on (pi.material_id)
           pi.material_id, po.supplier_id, pi.cost_price
      from purchase_items pi
      join purchase_orders po on po.id = pi.purchase_order_id
     where pi.tenant_id = v_tenant and pi.material_id is not null
     order by pi.material_id, pi.created_at desc
  )
  select
    'material'::text, m.id, m.name, m.unit, v_branch,
    round(coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0), 3),
    round(coalesce(st.sd, 0), 3),
    coalesce(oh.qty, 0),
    coalesce(oo.qty, 0),
    coalesce(sup.lead_time_days, v_default_lead),
    ls.supplier_id,
    coalesce(nullif(trim(sup.company_store), ''), nullif(trim(coalesce(sup.first_name, '') || ' ' || coalesce(sup.last_name, '')), '')),
    round(v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric, 2),
    round(coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) * coalesce(sup.lead_time_days, v_default_lead)
          + v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric, 2),
    v_cover,
    greatest(0, ceil(
      coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) * (coalesce(sup.lead_time_days, v_default_lead) + v_cover)
      + v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric
      - coalesce(oh.qty, 0) - coalesce(oo.qty, 0)
    )),
    case
      when coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) <= 0 then 'No recent usage recorded, nothing suggested.'
      else format(
        'You use about %s %s a day. %s %s left, about %s days. %s takes %s days. Order %s %s to cover %s days.',
        round(coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0), 1), coalesce(m.unit, 'units'),
        coalesce(oh.qty, 0), coalesce(m.unit, 'units'),
        round(coalesce(oh.qty, 0) / nullif(0.6 * st.avg30 + 0.4 * st.avg90, 0), 1),
        coalesce(nullif(trim(sup.company_store), ''), nullif(trim(coalesce(sup.first_name, '') || ' ' || coalesce(sup.last_name, '')), ''), 'your supplier'),
        coalesce(sup.lead_time_days, v_default_lead),
        greatest(0, ceil(
          coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) * (coalesce(sup.lead_time_days, v_default_lead) + v_cover)
          + v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric
          - coalesce(oh.qty, 0) - coalesce(oo.qty, 0)
        )), coalesce(m.unit, 'units'), v_cover
      )
    end
    from mats m
    left join stats st on st.material_id = m.id
    left join on_hand_calc oh on oh.material_id = m.id
    left join on_order_calc oo on oo.material_id = m.id
    left join last_supplier ls on ls.material_id = m.id
    left join suppliers sup on sup.id = ls.supplier_id
   order by m.name;

  if not coalesce(v_retail, false) then return; end if;

  -- A shop's products: same formula, driven by sales.
  return query
  with days as (
    select gs::date as d from generate_series(current_date - 89, current_date, interval '1 day') gs
  ),
  goods as (
    select finished_goods.id, finished_goods.name, finished_goods.unit
      from finished_goods where finished_goods.tenant_id = v_tenant
  ),
  daily_sold as (
    select g.id as good_id, d.d,
           coalesce(-sum(sm.quantity), 0) as sold
      from goods g
      cross join days d
      left join stock_movements sm
        on sm.tenant_id = v_tenant and sm.branch_id = v_branch
       and sm.product_kind = 'finished_good' and sm.product_id = g.id
       and sm.movement_type = 'SALE' and sm.quantity < 0
       and sm.created_at::date = d.d
     group by g.id, d.d
  ),
  stats as (
    select good_id,
           avg(sold) filter (where d >= current_date - 29) as avg30,
           avg(sold) as avg90,
           stddev_pop(sold) as sd
      from daily_sold
     group by good_id
  ),
  on_hand_calc as (
    select fg_batches.finished_good_id as good_id, sum(fg_batches.qty_remaining) as qty
      from fg_batches
     where fg_batches.tenant_id = v_tenant and fg_batches.branch_id = v_branch
     group by fg_batches.finished_good_id
  ),
  last_supplier as (
    select distinct on (pi.finished_good_id)
           pi.finished_good_id as good_id, po.supplier_id
      from purchase_items pi
      join purchase_orders po on po.id = pi.purchase_order_id
     where pi.tenant_id = v_tenant and pi.finished_good_id is not null and not po.voided
     order by pi.finished_good_id, pi.created_at desc
  )
  select
    'finished_good'::text, g.id, g.name, g.unit, v_branch,
    round(coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0), 3),
    round(coalesce(st.sd, 0), 3),
    coalesce(oh.qty, 0),
    0::numeric,
    coalesce(sup.lead_time_days, v_default_lead),
    ls.supplier_id,
    coalesce(nullif(trim(sup.company_store), ''), nullif(trim(coalesce(sup.first_name, '') || ' ' || coalesce(sup.last_name, '')), '')),
    round(v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric, 2),
    round(coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) * coalesce(sup.lead_time_days, v_default_lead)
          + v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric, 2),
    v_cover,
    greatest(0, ceil(
      coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) * (coalesce(sup.lead_time_days, v_default_lead) + v_cover)
      + v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric
      - coalesce(oh.qty, 0)
    )),
    case
      when coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) <= 0 then 'No sales recorded recently, nothing suggested.'
      else format(
        'You sell about %s %s a day. %s %s left, about %s days. %s takes %s days to deliver. Buy %s %s to cover %s days.',
        round(coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0), 1), coalesce(g.unit, 'units'),
        coalesce(oh.qty, 0), coalesce(g.unit, 'units'),
        round(coalesce(oh.qty, 0) / nullif(0.6 * st.avg30 + 0.4 * st.avg90, 0), 1),
        coalesce(nullif(trim(sup.company_store), ''), nullif(trim(coalesce(sup.first_name, '') || ' ' || coalesce(sup.last_name, '')), ''), 'Your supplier'),
        coalesce(sup.lead_time_days, v_default_lead),
        greatest(0, ceil(
          coalesce(0.6 * st.avg30 + 0.4 * st.avg90, 0) * (coalesce(sup.lead_time_days, v_default_lead) + v_cover)
          + v_z * coalesce(st.sd, 0) * sqrt(coalesce(sup.lead_time_days, v_default_lead)::float)::numeric
          - coalesce(oh.qty, 0)
        )), coalesce(g.unit, 'units'), v_cover
      )
    end
    from goods g
    left join stats st on st.good_id = g.id
    left join on_hand_calc oh on oh.good_id = g.id
    left join last_supplier ls on ls.good_id = g.id
    left join suppliers sup on sup.id = ls.supplier_id
   order by g.name;
end $$;
