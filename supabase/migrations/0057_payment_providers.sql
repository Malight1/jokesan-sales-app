-- ============================================================
-- ProfixBook — more than one payment provider per business.
--
-- Until now a business could connect exactly one provider (Paystack):
-- payment_integrations was keyed on tenant_id alone. Many shops bank with
-- Moniepoint AND OPay, so a business can now connect several, one of
-- them marked as the default the app uses unless told otherwise.
--
-- This migration adds Moniepoint (through its Monnify gateway) as the
-- second provider. OPay follows in its own migration.
--
--   payment_integrations   key becomes (tenant_id, provider); new
--                          is_default flag. Paystack rows carry over
--                          unchanged and become the default.
--   payment_links.meta     provider extras (Monnify's transactionReference,
--                          when the link stops working).
--   integration_status()   still answers "is anything connected" in the
--                          same shape, plus a providers list.
--   set_default_payment_provider() / disconnect_payment_provider()
--                          admin-only switches.
--   store/get_tenant_payment_secret()   Vault, per provider, service role
--                          only (Paystack's old pair still works).
--
-- Secrets never sit in a plain column and the app still can't read this
-- table at all (it has no RLS policies).
--
-- Run AFTER 0001-0056. Then redeploy payments-connect,
-- payment-link-create and payments-webhook.
-- ============================================================

-- ------------------------------------------------------------
-- 1. One row per provider
-- ------------------------------------------------------------
alter table payment_integrations drop constraint if exists payment_integrations_pkey;
alter table payment_integrations add primary key (tenant_id, provider);
alter table payment_integrations add column if not exists is_default boolean not null default false;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'payment_integrations_provider_check') then
    alter table payment_integrations add constraint payment_integrations_provider_check
      check (provider in ('paystack', 'monnify', 'opay'));
  end if;
end $$;

-- Whatever was connected before is the default now.
update payment_integrations set is_default = true
 where not exists (select 1 from payment_integrations p2 where p2.tenant_id = payment_integrations.tenant_id and p2.is_default);

-- At most one default per business.
create unique index if not exists uq_payment_integrations_default
  on payment_integrations (tenant_id) where is_default;

alter table payment_links add column if not exists meta jsonb not null default '{}'::jsonb;
alter table payment_links add column if not exists expires_at timestamptz;

-- ------------------------------------------------------------
-- 2. What the app may know: connected or not, per provider, and the
--    non-secret settings (Monnify's contract code, test or live).
-- ------------------------------------------------------------
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
               'environment', settings->>'environment', 'contract_code', settings->>'contract_code')
             order by is_default desc, created_at)
        from mine), '[]'::jsonb)
  )
$$;

create or replace function public.set_default_payment_provider(p_provider text)
returns void
language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if public.real_role() is distinct from 'admin' then
    raise exception 'Only an admin can change how payments are collected.' using errcode = 'insufficient_privilege';
  end if;
  if not exists (select 1 from payment_integrations where tenant_id = v_tenant and provider = p_provider) then
    raise exception 'Connect % first.', p_provider;
  end if;
  update payment_integrations set is_default = false where tenant_id = v_tenant and is_default;
  update payment_integrations set is_default = true where tenant_id = v_tenant and provider = p_provider;
  perform public.log_audit('payment_provider_default', 'payment_integrations', p_provider, null);
end $$;
grant execute on function public.set_default_payment_provider(text) to authenticated;

create or replace function public.disconnect_payment_provider(p_provider text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_was_default boolean;
begin
  if public.real_role() is distinct from 'admin' then
    raise exception 'Only an admin can change how payments are collected.' using errcode = 'insufficient_privilege';
  end if;
  delete from payment_integrations where tenant_id = v_tenant and provider = p_provider
    returning is_default into v_was_default;
  if v_was_default then
    update payment_integrations set is_default = true
     where tenant_id = v_tenant
       and provider = (select provider from payment_integrations where tenant_id = v_tenant order by created_at limit 1);
  end if;
  perform public.log_audit('payment_provider_disconnected', 'payment_integrations', p_provider, null);
end $$;
grant execute on function public.disconnect_payment_provider(text) to authenticated;

-- For the Edge Functions (service role): which provider to use, and its
-- non-secret settings.
create or replace function public.tenant_payment_provider(p_tenant uuid, p_provider text default null)
returns table (provider text, public_key text, settings jsonb)
language sql stable security definer set search_path = public as $$
  select provider, public_key, settings from payment_integrations
   where tenant_id = p_tenant and status = 'live'
     and (p_provider is null or provider = p_provider)
   order by is_default desc, created_at
   limit 1
$$;
revoke execute on function public.tenant_payment_provider(uuid, text) from public, anon, authenticated;

-- ------------------------------------------------------------
-- 3. Secrets in Vault, per provider. Same guard as 0027: only created
--    where Supabase Vault exists (the live project, not the test harness).
-- ------------------------------------------------------------
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    execute $sql$
      create or replace function public.store_tenant_payment_secret(
        p_tenant uuid, p_provider text, p_secret text, p_public_key text, p_settings jsonb default '{}'::jsonb)
      returns void
      language plpgsql security definer set search_path = public, vault as $fn$
      declare
        v_vault_id uuid;
        v_first boolean;
      begin
        v_first := not exists (select 1 from payment_integrations where tenant_id = p_tenant);
        v_vault_id := vault.create_secret(p_secret, p_provider || '_secret_' || p_tenant::text || '_' || extract(epoch from clock_timestamp())::bigint);
        insert into payment_integrations (tenant_id, provider, status, public_key, secret_vault_id, last_verified_at, settings, is_default)
        values (p_tenant, p_provider, 'live', p_public_key, v_vault_id, now(), coalesce(p_settings, '{}'::jsonb), v_first)
        on conflict (tenant_id, provider) do update
          set status = 'live', public_key = excluded.public_key, secret_vault_id = excluded.secret_vault_id,
              settings = excluded.settings, last_verified_at = now(), last_error = null;
      end $fn$;
    $sql$;
    execute 'revoke execute on function public.store_tenant_payment_secret(uuid, text, text, text, jsonb) from public, anon, authenticated';

    execute $sql$
      create or replace function public.get_tenant_payment_secret(p_tenant uuid, p_provider text)
      returns text
      language plpgsql security definer set search_path = public, vault as $fn$
      declare v_vault_id uuid; v_secret text;
      begin
        select secret_vault_id into v_vault_id from payment_integrations where tenant_id = p_tenant and provider = p_provider;
        if v_vault_id is null then return null; end if;
        select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_vault_id;
        return v_secret;
      end $fn$;
    $sql$;
    execute 'revoke execute on function public.get_tenant_payment_secret(uuid, text) from public, anon, authenticated';

    -- Paystack's original pair, rebuilt on the per-provider key so the
    -- deployed functions keep working until they are redeployed.
    execute $sql$
      create or replace function public.store_tenant_paystack_secret(p_tenant uuid, p_secret text, p_public_key text)
      returns void language sql security definer set search_path = public as $fn$
        select public.store_tenant_payment_secret(p_tenant, 'paystack', p_secret, p_public_key, '{}'::jsonb)
      $fn$;
    $sql$;
    execute 'revoke execute on function public.store_tenant_paystack_secret(uuid, text, text) from public, anon, authenticated';

    execute $sql$
      create or replace function public.get_tenant_paystack_secret(p_tenant uuid)
      returns text language sql security definer set search_path = public as $fn$
        select public.get_tenant_payment_secret(p_tenant, 'paystack')
      $fn$;
    $sql$;
    execute 'revoke execute on function public.get_tenant_paystack_secret(uuid) from public, anon, authenticated';
  end if;
end $$;
