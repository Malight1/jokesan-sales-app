-- ============================================================
-- StockFlow — Foundations for the next phases
--
--   1. Real invoice numbers. The POS receipt printed INV-<timestamp> and
--      the Sales page INV-<first 8 of the uuid>, so one sale carried two
--      different numbers and neither was sequential. Tax records, credit
--      notes and quotes all need one gap-free number per document, issued
--      by the server. Every sale now gets one (INV-000123) on insert, and
--      it can never be changed afterwards.
--   2. log_audit(): one way for every engine function to record who did
--      something sensitive. Voids are logged from here on.
--   3. tenant_has_feature(): which plan unlocks which feature, decided in
--      the database so it can't be bypassed from the browser. A trial gets
--      everything so people can try it all.
--
-- Run AFTER 0001–0020.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Document numbers
-- ------------------------------------------------------------
create table if not exists doc_sequences (
  tenant_id uuid not null references tenants(id) on delete cascade,
  doc_type  text not null,              -- INV, CN, QT, PO, GRN, DN, SR, Z
  prefix    text not null,
  next_no   bigint not null default 1,
  primary key (tenant_id, doc_type)
);
alter table doc_sequences enable row level security;
drop policy if exists doc_sequences_read on doc_sequences;
create policy doc_sequences_read on doc_sequences for select
  using (tenant_id = public.current_tenant_id());
-- No write policies: numbers are only ever issued by next_doc_no().

-- Issues the next number. An UPDATE on a row (not a Postgres sequence) so
-- a sale that fails and rolls back gives its number back — no gaps.
create or replace function public.next_doc_no(p_tenant uuid, p_type text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_no     bigint;
  v_prefix text;
begin
  insert into doc_sequences (tenant_id, doc_type, prefix, next_no)
  values (p_tenant, p_type, p_type || '-', 1)
  on conflict (tenant_id, doc_type) do nothing;

  update doc_sequences
     set next_no = next_no + 1
   where tenant_id = p_tenant and doc_type = p_type
  returning next_no - 1, prefix into v_no, v_prefix;

  -- lpad would truncate past six digits; just grow instead.
  return v_prefix || case when v_no >= 1000000 then v_no::text else lpad(v_no::text, 6, '0') end;
end $$;

alter table sales_orders add column if not exists doc_no text;

-- Number existing sales in the order they happened, per company.
do $$
declare r record;
begin
  for r in
    select id, tenant_id from sales_orders
     where doc_no is null
     order by tenant_id, created_at, id
  loop
    update sales_orders set doc_no = public.next_doc_no(r.tenant_id, 'INV') where id = r.id;
  end loop;
end $$;

create unique index if not exists uq_sales_orders_doc_no on sales_orders (tenant_id, doc_no);

-- The server always issues the number; once issued it's permanent.
create or replace function public.assign_doc_no()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    NEW.doc_no := public.next_doc_no(NEW.tenant_id, TG_ARGV[0]);
  elsif OLD.doc_no is not null and NEW.doc_no is distinct from OLD.doc_no then
    raise exception 'A document number can''t be changed once it has been issued.';
  end if;
  return NEW;
end $$;

drop trigger if exists trg_doc_no on sales_orders;
create trigger trg_doc_no before insert or update of doc_no on sales_orders
  for each row execute function public.assign_doc_no('INV');

-- An admin may brand their numbers (e.g. JKS-INV-). The running number
-- carries on, so nothing already issued can collide.
create or replace function public.set_doc_prefix(p_type text, p_prefix text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_prefix text := trim(coalesce(p_prefix, ''));
begin
  if public.current_role() <> 'admin' then
    raise exception 'Only an admin can change document numbering.' using errcode = 'insufficient_privilege';
  end if;
  if p_type not in ('INV','CN','QT','PO','GRN','DN','SR','Z') then
    raise exception 'Unknown document type %.', p_type;
  end if;
  if v_prefix !~ '^[A-Za-z0-9/_-]{1,12}$' then
    raise exception 'Use up to 12 letters, numbers, dashes or slashes for the prefix.';
  end if;
  insert into doc_sequences (tenant_id, doc_type, prefix, next_no)
  values (v_tenant, p_type, v_prefix, 1)
  on conflict (tenant_id, doc_type) do update set prefix = excluded.prefix;
  perform public.log_audit('doc_prefix', 'doc_sequences', p_type, jsonb_build_object('prefix', v_prefix));
end $$;


-- ------------------------------------------------------------
-- 2. Audit trail
-- ------------------------------------------------------------
-- Written only from inside SECURITY DEFINER functions and triggers; the
-- app itself can't write (or forge) an audit row.
create or replace function public.log_audit(
  p_action    text,
  p_entity    text,
  p_entity_id text,
  p_meta      jsonb default null
) returns void
language sql security definer set search_path = public as $$
  insert into audit_logs (tenant_id, user_id, action, entity, entity_id, meta)
  values (public.current_tenant_id(), auth.uid(), p_action, p_entity, p_entity_id, p_meta)
$$;

create index if not exists idx_audit_logs_tenant on audit_logs (tenant_id, created_at desc);

-- Voids reverse stock and money: always leave a trace of who and what.
create or replace function public.audit_void()
returns trigger language plpgsql security definer set search_path = public as $$
declare v jsonb := to_jsonb(NEW);
begin
  if NEW.voided and not OLD.voided then
    perform public.log_audit('void', TG_TABLE_NAME, NEW.id::text, jsonb_build_object(
      'doc_no', v->>'doc_no',
      'total',  coalesce(v->>'total_amount', v->>'total_cost')
    ));
  end if;
  return NEW;
end $$;

do $$
declare v_tbl text;
begin
  foreach v_tbl in array array['sales_orders','purchase_orders','production_runs'] loop
    execute format('drop trigger if exists trg_audit_void on %I;', v_tbl);
    execute format('create trigger trg_audit_void after update of voided on %I
                    for each row execute function public.audit_void();', v_tbl);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 3. Which plan unlocks what
-- ------------------------------------------------------------
-- Compared as text on purpose: 'business' was added to plan_tier in 0019,
-- and an enum literal added in one transaction can't be used in the next
-- statement of the same one on older Postgres.
create or replace function public.plan_level(p_plan text)
returns int language sql immutable as $$
  select case p_plan
    when 'starter'    then 1
    when 'growth'     then 2
    when 'business'   then 3
    when 'enterprise' then 4
    when 'trial'      then 3   -- a trial gets everything so people can try it
    else 1 end
$$;

-- Keep in step with src/lib/features.ts.
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
    when 'auto_payments'   then 3
    when 'einvoicing'      then 3
    when 'assistant'       then 3
    when 'custom_fields'   then 3
    else 1 end
$$;

create or replace function public.tenant_has_feature(p_feature text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((
    select public.plan_level(t.plan::text) >= public.feature_level(p_feature)
      from tenants t where t.id = public.current_tenant_id()
  ), false)
$$;

create or replace function public.require_feature(p_feature text, p_label text)
returns void
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.tenant_has_feature(p_feature) then
    raise exception '% is on the % plan and above. Upgrade under Settings → Billing.',
      p_label,
      case public.feature_level(p_feature) when 2 then 'Growth' when 3 then 'Business' else 'Starter' end
      using errcode = 'insufficient_privilege';
  end if;
end $$;


-- ------------------------------------------------------------
-- 4. Grants
-- ------------------------------------------------------------
-- Internal helpers: callable by the engine, never straight from the API.
revoke execute on function public.next_doc_no(uuid, text)             from public, anon, authenticated;
revoke execute on function public.log_audit(text, text, text, jsonb)  from public, anon, authenticated;
revoke execute on function public.assign_doc_no()                     from public, anon, authenticated;
revoke execute on function public.audit_void()                        from public, anon, authenticated;

grant execute on function public.set_doc_prefix(text, text)     to authenticated;
grant execute on function public.tenant_has_feature(text)       to authenticated;
grant execute on function public.require_feature(text, text)    to authenticated;
grant execute on function public.plan_level(text)               to authenticated;
grant execute on function public.feature_level(text)            to authenticated;
