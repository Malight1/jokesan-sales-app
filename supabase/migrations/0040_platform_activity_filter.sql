-- ============================================================
-- StockFlow — Platform tenant detail: "Recent Activity" should show what
-- the platform admin did to this tenant (suspend/reactivate/extend
-- trial/change plan), not the tenant's own full internal audit trail
-- (role creation, payment types, custom fields, etc.) — that noise
-- belongs on the tenant's own Audit Log page, not a support lookup.
-- Run AFTER 0001–0039.
-- ============================================================

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
                         from (select * from audit_logs where tenant_id = p_tenant_id and action like 'platform.%'
                               order by created_at desc limit 20) a)
  ) into v_result;
  return v_result;
end $$;
