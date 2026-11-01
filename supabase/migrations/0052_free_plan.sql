-- ============================================================
-- ProfixBook — Free plan and new prices.
-- Run AFTER 0001–0051, then redeploy the paystack-verify Edge Function
-- (its plan list drops 'starter').
--
-- 1. Plans are now Free, Growth (₦5,500) and Business (₦16,500).
--    Starter is gone: every business on it moves to Growth for the rest
--    of the time it has paid for.
-- 2. Free: the owner only, 1 branch, 50 products, 50 raw materials and
--    100 sales a month. No staff, debt reminders, expiry or assistant.
-- 3. When a trial ends or a paid plan lapses, the business drops to Free
--    instead of going read-only. The owner keeps selling; other staff
--    can still sign in and look, but cannot save, because Free is for the
--    owner only.
-- 4. Founding customers pay the lower of their founding price and the
--    list price, so a price cut reaches them too.
--
-- 'free' is added to plan_tier but never used as an enum literal below,
-- only compared as text (same reason as 0021: a value added in one
-- transaction can't be used in it).
-- ============================================================

alter type plan_tier add value if not exists 'free';

-- ------------------------------------------------------------
-- 1. The plan a business is really on right now
-- ------------------------------------------------------------
-- tenants.plan is what was last paid for (or 'trial'). Once the trial
-- ends or the paid period runs out, the business is on Free until it
-- pays again. Everything that checks a plan goes through this.
create or replace function public.effective_plan(p_tenant uuid)
returns text language sql stable security definer set search_path = public as $$
  select case
    when t.plan::text = 'trial'
         and t.trial_ends_at is not null and t.trial_ends_at <= now() then 'free'
    when t.plan::text not in ('trial', 'free')
         and t.plan_expires_at is not null and t.plan_expires_at <= now() then 'free'
    else t.plan::text end
    from tenants t where t.id = p_tenant
$$;

grant execute on function public.effective_plan(uuid) to authenticated;

-- Writes: suspended accounts are still read-only. A business on Free can
-- write, but only its owner (admin) — staff logins are a paid feature.
create or replace function public.tenant_is_live()
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select t.is_active
       and (public.effective_plan(t.id) <> 'free' or public.current_role()::text = 'admin')
      from tenants t
     where t.id = public.current_tenant_id()
  ), false)
$$;

-- ------------------------------------------------------------
-- 2. Levels and limits
-- ------------------------------------------------------------
create or replace function public.plan_level(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'free'       then 1
    when 'starter'    then 1   -- legacy, nobody is on it after this migration
    when 'growth'     then 2
    when 'business'   then 3
    when 'enterprise' then 4
    when 'trial'      then 3   -- a trial gets everything so people can try it
    else 1 end
$$;

-- Keep in step with src/lib/features.ts. debt_reminders is only checked
-- in the app (a reminder is a WhatsApp link, nothing to refuse here), but
-- lives in this list too so the two stay one list.
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
    when 'debt_reminders'  then 2
    when 'auto_payments'   then 3
    when 'einvoicing'      then 3
    when 'custom_fields'   then 3
    else 1 end
$$;

create or replace function public.tenant_has_feature(p_feature text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce(
    public.plan_level(public.effective_plan(public.current_tenant_id())) >= public.feature_level(p_feature),
    false)
$$;

create or replace function public.require_feature(p_feature text, p_label text)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.tenant_has_feature(p_feature) then
    raise exception '% is on the % plan and above. Upgrade under Settings → Billing.',
      p_label,
      case public.feature_level(p_feature) when 3 then 'Business' else 'Growth' end
      using errcode = 'insufficient_privilege';
  end if;
end $$;

create or replace function public.plan_user_limit(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'free'       then 1
    when 'starter'    then 2
    when 'growth'     then 5
    when 'business'   then 15
    when 'enterprise' then 999
    when 'trial'      then 999   -- a trial gets everything so people can try it
    else 1 end
$$;

create or replace function public.plan_branch_limit(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'free'       then 1
    when 'starter'    then 1
    when 'growth'     then 3
    when 'business'   then 999
    when 'enterprise' then 999
    when 'trial'      then 999
    else 1 end
$$;

-- Free's own caps. NULL means no cap.
create or replace function public.plan_product_limit(p_plan text)
returns int language sql immutable as $$
  select case p_plan when 'free' then 50 end
$$;

create or replace function public.plan_monthly_sales_limit(p_plan text)
returns int language sql immutable as $$
  select case p_plan when 'free' then 100 end
$$;

grant execute on function public.plan_product_limit(text)       to anon, authenticated;
grant execute on function public.plan_monthly_sales_limit(text) to anon, authenticated;

-- Seat and branch caps from 0037, now on the effective plan, so a lapsed
-- Growth business can't keep adding staff.
create or replace function public.guard_seat_limit()
returns trigger language plpgsql set search_path = public as $$
declare
  v_limit int;
  v_used  int;
begin
  if current_user in ('authenticated', 'anon') then
    v_limit := public.plan_user_limit(public.effective_plan(NEW.tenant_id));
    select count(*) into v_used from (
      select id from profiles      where tenant_id = NEW.tenant_id and is_active
      union all
      select id from staff_invites where tenant_id = NEW.tenant_id and status = 'pending'
    ) s;
    if v_used >= v_limit then
      raise exception 'Your plan allows % team member%. Upgrade under Settings → Billing to add more.',
        v_limit, case when v_limit = 1 then '' else 's' end
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return NEW;
end $$;

create or replace function public.guard_branch_limit()
returns trigger language plpgsql set search_path = public as $$
declare
  v_limit int;
  v_used  int;
begin
  if current_user in ('authenticated', 'anon') then
    v_limit := public.plan_branch_limit(public.effective_plan(NEW.tenant_id));
    select count(*) into v_used from branches where tenant_id = NEW.tenant_id and is_active;
    if v_used >= v_limit then
      raise exception 'Your plan allows % branch%. Upgrade under Settings → Billing to add more.',
        v_limit, case when v_limit = 1 then '' else 'es' end
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return NEW;
end $$;

-- Product and material caps. Unlike the seat guard this fires for engine
-- functions too (an import going through an RPC still counts), but only
-- on Free, so trial sample data and paid plans never hit it.
create or replace function public.guard_free_item_limit()
returns trigger language plpgsql set search_path = public as $$
declare
  v_limit int := public.plan_product_limit(public.effective_plan(NEW.tenant_id));
  v_used  int;
begin
  if v_limit is not null then
    execute format('select count(*) from %I where tenant_id = $1', TG_TABLE_NAME) into v_used using NEW.tenant_id;
    if v_used >= v_limit then
      raise exception 'The Free plan holds up to % %. Upgrade to Growth under Settings → Billing to add more.',
        v_limit, case TG_TABLE_NAME when 'materials' then 'raw materials' else 'products' end
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_free_products on finished_goods;
create trigger trg_guard_free_products before insert on finished_goods
  for each row execute function public.guard_free_item_limit();

drop trigger if exists trg_guard_free_materials on materials;
create trigger trg_guard_free_materials before insert on materials
  for each row execute function public.guard_free_item_limit();

-- 100 sales a calendar month on Free. A sale rung up offline that hits
-- the cap on sync is refused like any other sync conflict and stays in
-- the till's failed list, so it can be sent again after upgrading.
create or replace function public.guard_free_sales_limit()
returns trigger language plpgsql set search_path = public as $$
declare
  v_limit int := public.plan_monthly_sales_limit(public.effective_plan(NEW.tenant_id));
  v_used  int;
begin
  if v_limit is not null then
    select count(*) into v_used from sales_orders
     where tenant_id = NEW.tenant_id and created_at >= date_trunc('month', now());
    if v_used >= v_limit then
      raise exception 'The Free plan allows % sales a month and this month''s are used up. Upgrade to Growth under Settings → Billing to keep selling.',
        v_limit
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return NEW;
end $$;

drop trigger if exists trg_guard_free_sales on sales_orders;
create trigger trg_guard_free_sales before insert on sales_orders
  for each row execute function public.guard_free_sales_limit();

-- What the signed-in business has used of Free's caps, for the app's
-- usage meter. Limits are null when the plan has no cap.
create or replace function public.my_plan_usage()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'plan',          public.effective_plan(t.id),
    'product_limit', public.plan_product_limit(public.effective_plan(t.id)),
    'products',      (select count(*) from finished_goods where tenant_id = t.id),
    'materials',     (select count(*) from materials      where tenant_id = t.id),
    'sales_limit',   public.plan_monthly_sales_limit(public.effective_plan(t.id)),
    'sales_this_month', (select count(*) from sales_orders
                          where tenant_id = t.id and created_at >= date_trunc('month', now())))
    from tenants t where t.id = public.current_tenant_id()
$$;

grant execute on function public.my_plan_usage() to authenticated;

-- ------------------------------------------------------------
-- 3. Prices
-- ------------------------------------------------------------
create or replace function public.plan_list_price(p_plan text)
returns numeric language sql immutable as $$
  select case p_plan
    when 'growth'   then 5500
    when 'business' then 16500
  end::numeric
$$;

-- Founding customers keep this for life. Set to the relaunch prices; a
-- founder always pays the lower of this and the list price (below), so
-- these numbers only ever protect them from a rise.
create or replace function public.plan_founding_price(p_plan text)
returns numeric language sql immutable as $$
  select case p_plan
    when 'growth'   then 5500
    when 'business' then 16500
  end::numeric
$$;

create or replace function public.tenant_plan_price(p_tenant uuid, p_plan text)
returns numeric language sql stable security definer set search_path = public as $$
  select case when t.founding_number is not null
              then least(public.plan_founding_price(p_plan), public.plan_list_price(p_plan))
              else public.plan_list_price(p_plan) end
    from tenants t where t.id = p_tenant
$$;

create or replace function public.my_billing()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'founding_number', t.founding_number,
    'founding_since',  t.founding_since,
    'spots_left',      public.founding_spots_left(),
    'prices', jsonb_build_object(
      'growth',   public.tenant_plan_price(t.id, 'growth'),
      'business', public.tenant_plan_price(t.id, 'business')))
    from tenants t where t.id = public.current_tenant_id()
$$;

-- Same as 0050 apart from the plan list and treating Free like a trial
-- when working out where a new paid period starts.
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
  if p_plan not in ('growth', 'business') then raise exception 'Unknown plan %', p_plan; end if;
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
  v_base := case when v_t.plan::text not in ('trial', 'free') and v_t.plan_expires_at > now()
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

revoke execute on function public.confirm_subscription_payment(uuid, text, text, text, bigint) from public, anon, authenticated;
grant  execute on function public.confirm_subscription_payment(uuid, text, text, text, bigint) to service_role;

-- ------------------------------------------------------------
-- 4. Starter customers move to Growth
-- ------------------------------------------------------------
-- They keep the time they paid for and get Growth's extras for it.
update tenants set plan = 'growth' where plan::text = 'starter';
