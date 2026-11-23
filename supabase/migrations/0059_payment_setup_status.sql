-- ============================================================
-- ProfixBook — show owners whether their payment setup is finished.
--
-- After connecting Moniepoint or Paystack, the owner still has to paste
-- the webhook URL into the provider's dashboard, and until now nothing
-- told them whether that worked. payments-webhook now stamps
-- settings.webhook_seen_at on the business's connection whenever a
-- verified notification arrives from that provider, and
-- integration_status() hands it to the Payments screen, which turns the
-- step into a tick ("Working: last confirmation 2 days ago").
--
-- Run AFTER 0058. Then redeploy payments-webhook.
-- ============================================================

create or replace function public.integration_status()
returns jsonb
language sql stable security definer set search_path = public as $$
  with mine as (
    select * from payment_integrations where tenant_id = public.current_tenant_id()
  ), def as (
    select * from mine order by is_default desc, created_at limit 1
  )
  select jsonb_build_object(
    'connected',        exists (select 1 from mine where status = 'live'),
    'status',           coalesce((select status from def), 'not_connected'),
    'public_key',       (select public_key from def),
    'last_verified_at', (select last_verified_at from def),
    'default_provider', (select provider from def),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object(
               'provider', provider, 'status', status, 'is_default', is_default,
               'public_key', public_key, 'last_verified_at', last_verified_at,
               'environment', settings->>'environment', 'contract_code', settings->>'contract_code',
               'webhook_seen_at', settings->>'webhook_seen_at',
               'payments_count', (select count(*) from incoming_payments ip
                                   where ip.tenant_id = mine.tenant_id and ip.provider = mine.provider))
             order by is_default desc, created_at)
        from mine), '[]'::jsonb)
  )
$$;

-- For payments-webhook (service role): note that a verified notification
-- from this provider reached us.
create or replace function public.mark_payment_webhook_seen(p_tenant uuid, p_provider text)
returns void
language sql security definer set search_path = public as $$
  update payment_integrations
     set settings = settings || jsonb_build_object('webhook_seen_at', now())
   where tenant_id = p_tenant and provider = p_provider
$$;
revoke execute on function public.mark_payment_webhook_seen(uuid, text) from public, anon, authenticated;
