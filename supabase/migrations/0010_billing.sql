-- ============================================================
-- StockFlow — Paystack billing
--  • activate_subscription: called (server-side) AFTER a payment
--    is verified with Paystack's secret key. Sets the tenant's plan
--    and records the subscription. Admin-only + tenant-scoped.
-- Run AFTER 0001–0009.
-- ============================================================

alter table tenants add column if not exists plan_expires_at timestamptz;

create or replace function public.activate_subscription(
  p_plan       plan_tier,
  p_reference  text,
  p_amount     numeric,
  p_period_end timestamptz
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if public.current_role() <> 'admin' then raise exception 'Only an admin can manage billing'; end if;

  update tenants
     set plan = p_plan, plan_expires_at = p_period_end, is_active = true
   where id = v_tenant;

  insert into subscriptions(tenant_id, plan, status, provider, amount, interval, current_period_end, paystack_sub_code)
  values (v_tenant, p_plan, 'active', 'paystack', p_amount, 'monthly', p_period_end, p_reference);
end $$;

grant execute on function public.activate_subscription(plan_tier, text, numeric, timestamptz) to authenticated;
