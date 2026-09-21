-- ============================================================
-- StockFlow — fix platform_needs_attention(): the ORDER BY inside a
-- UNION ALL can't reference the function's declared return-column name
-- ("at") unless the FIRST branch's SELECT list actually aliases its
-- column to that name — the returns table(...) signature doesn't
-- propagate into the query text on its own. Postgres raised "invalid
-- UNION/INTERSECT/EXCEPT ORDER BY clause" on every call.
-- Run AFTER 0001–0041.
-- ============================================================

create or replace function public.platform_needs_attention()
returns table (tenant_id uuid, tenant_name text, kind text, detail text, at timestamptz)
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_platform_admin() then raise exception 'Not authorised'; end if;
  return query
    select t.id, t.name, 'trial_expiring'::text, 'Trial ends ' || to_char(t.trial_ends_at, 'DD Mon'), t.trial_ends_at as at
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
