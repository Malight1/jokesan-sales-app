-- ============================================================
-- StockFlow — Custom fields (Phase 6e)
--
-- Every business tracks something StockFlow doesn't have a column for
-- (a distributor code, a customer's CAC number, a product's shelf
-- position). custom_field_defs lets an admin define one per entity;
-- the value lives in a `custom_fields` jsonb column on the entity's own
-- table, so no schema change is needed per field.
--
-- Scope: definitions + validated values on customers, suppliers,
-- finished_goods, materials and sales_orders. Deliberately NOT built —
-- see HANDOVER.md — DataTable optional columns and CSV/Excel export
-- inclusion; both are generic features the app doesn't have anywhere
-- yet, not specific to custom fields.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Schema
-- ------------------------------------------------------------

create table if not exists custom_field_defs (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null references tenants(id) on delete cascade,
  entity           text not null check (entity in ('customer', 'supplier', 'finished_good', 'material', 'sale')),
  key              text not null check (key ~ '^[a-z][a-z0-9_]*$'),
  label            text not null,
  type             text not null default 'text' check (type in ('text', 'number', 'date', 'select')),
  options          jsonb check (type <> 'select' or (options is not null and jsonb_typeof(options) = 'array')),
  required         boolean not null default false,
  show_on_invoice  boolean not null default false,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  unique (tenant_id, entity, key)
);
create index if not exists idx_custom_field_defs_entity on custom_field_defs (tenant_id, entity, sort_order);

alter table customers      add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table suppliers      add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table finished_goods add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table materials      add column if not exists custom_fields jsonb not null default '{}'::jsonb;
alter table sales_orders   add column if not exists custom_fields jsonb not null default '{}'::jsonb;

-- Direct inserts (customer_types-style admin UI) need tenant_id auto-filled,
-- same as every other tenant-only config table (0004_tenant_defaults.sql).
drop trigger if exists trg_set_tenant on custom_field_defs;
create trigger trg_set_tenant before insert on custom_field_defs
  for each row execute function public.set_tenant_id();


-- ------------------------------------------------------------
-- 2. RLS — custom_field_defs is a config/lookup table: everyone reads it
--    (a cashier's customer form needs the field labels), only admin
--    defines fields, same shape as customer_types/payment_types (0017).
-- ------------------------------------------------------------

alter table custom_field_defs enable row level security;
drop policy if exists custom_field_defs_read  on custom_field_defs;
drop policy if exists custom_field_defs_write on custom_field_defs;

create policy custom_field_defs_read on custom_field_defs for select
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'sales', 'inventory', 'accounts'));

create policy custom_field_defs_write on custom_field_defs for all
  using (tenant_id = public.current_tenant_id() and public.has_role('admin') and public.tenant_is_live())
  with check (tenant_id = public.current_tenant_id() and public.has_role('admin') and public.tenant_is_live());

-- Deleting a definition strips its key from every row that has it, rather
-- than leaving a value the validation trigger below would then call
-- "unknown" on that row's very next save.
create or replace function public.cleanup_deleted_custom_field()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_tbl text;
begin
  v_tbl := case OLD.entity
    when 'customer'      then 'customers'
    when 'supplier'       then 'suppliers'
    when 'finished_good'  then 'finished_goods'
    when 'material'       then 'materials'
    when 'sale'            then 'sales_orders'
    else null end;
  if v_tbl is not null then
    execute format('update %I set custom_fields = custom_fields - $1 where tenant_id = $2 and custom_fields ? $1', v_tbl)
      using OLD.key, OLD.tenant_id;
  end if;
  return OLD;
end $$;

drop trigger if exists trg_cleanup_deleted_custom_field on custom_field_defs;
create trigger trg_cleanup_deleted_custom_field after delete on custom_field_defs
  for each row execute function public.cleanup_deleted_custom_field();


-- ------------------------------------------------------------
-- 3. Validation — runs on every insert/update touching custom_fields on
--    any of the five tables, so a bad value can't land whichever path
--    wrote it (a direct table write on the four master-data tables, or
--    set_custom_fields() below for sales_orders, which has no direct
--    write policy at all).
--
--    "required" is enforced only for the four master-data entities —
--    NOT for a sale. A sale is created through create_sale (rewritten
--    three times already for batches/returns/pricing), and every
--    existing sale's insert would otherwise start failing the moment a
--    tenant defines one required sale field, since create_sale has no
--    way to supply custom_fields at creation time. A sale's custom
--    fields are filled in afterwards, from the sale detail screen.
-- ------------------------------------------------------------

create or replace function public.validate_custom_fields()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_entity           text    := TG_ARGV[0];
  v_enforce_required boolean := TG_ARGV[1]::boolean;
  v_def   record;
  v_val   jsonb;
  v_key   text;
  v_text  text;
begin
  if NEW.custom_fields is null then
    NEW.custom_fields := '{}'::jsonb;
  end if;

  for v_key in select jsonb_object_keys(NEW.custom_fields) loop
    if not exists (
      select 1 from public.custom_field_defs
       where tenant_id = NEW.tenant_id and entity = v_entity and key = v_key
    ) then
      raise exception 'Unknown custom field "%" — define it first under Settings → Custom fields.', v_key;
    end if;
  end loop;

  for v_def in
    select * from public.custom_field_defs
     where tenant_id = NEW.tenant_id and entity = v_entity
  loop
    v_val := NEW.custom_fields -> v_def.key;

    if v_val is null or jsonb_typeof(v_val) = 'null' or v_val = '""'::jsonb then
      if v_enforce_required and v_def.required then
        raise exception '% is required.', v_def.label;
      end if;
      continue;
    end if;

    v_text := v_val #>> '{}';
    if v_def.type = 'number' then
      if jsonb_typeof(v_val) <> 'number' then
        raise exception '% must be a number.', v_def.label;
      end if;
    elsif v_def.type = 'date' then
      begin
        perform v_text::date;
      exception when others then
        raise exception '% must be a valid date.', v_def.label;
      end;
    elsif v_def.type = 'select' then
      if not (v_def.options ? v_text) then
        raise exception '% must be one of the allowed options.', v_def.label;
      end if;
    end if;
  end loop;

  return NEW;
end $$;

do $$
declare g record;
begin
  for g in
    select * from (values
      ('customers',       'customer',       true),
      ('suppliers',        'supplier',       true),
      ('finished_goods',   'finished_good',  true),
      ('materials',        'material',       true),
      ('sales_orders',     'sale',           false)
    ) as t(tbl, entity, enforce_required)
  loop
    execute format('drop trigger if exists trg_validate_custom_fields on %I;', g.tbl);
    execute format($f$
      create trigger trg_validate_custom_fields before insert or update of custom_fields on %I
      for each row execute function public.validate_custom_fields(%L, %L);
    $f$, g.tbl, g.entity, g.enforce_required::text);
  end loop;
end $$;


-- ------------------------------------------------------------
-- 4. set_custom_fields — the only way to set a sale's custom fields
--    (sales_orders has no direct write policy at all, per 0017), and
--    also available for the other four entities so the frontend has one
--    call to make regardless of entity.
-- ------------------------------------------------------------

create or replace function public.set_custom_fields(p_entity text, p_entity_id uuid, p_fields jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_tbl    text;
  v_roles  text[];
  v_rows   int;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;

  v_tbl := case p_entity
    when 'customer'      then 'customers'
    when 'supplier'       then 'suppliers'
    when 'finished_good'  then 'finished_goods'
    when 'material'       then 'materials'
    when 'sale'            then 'sales_orders'
    else null end;
  if v_tbl is null then
    raise exception 'Unknown entity "%".', p_entity;
  end if;

  v_roles := case p_entity
    when 'customer' then array['admin', 'sales']
    when 'sale'     then array['admin', 'sales']
    else array['admin', 'inventory'] end;
  if not public.has_role(variadic v_roles) then
    raise exception 'Your role is not allowed to edit custom fields on a %.', p_entity
      using errcode = 'insufficient_privilege';
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — custom fields are read-only until billing is sorted out.';
  end if;

  execute format('update %I set custom_fields = $1 where id = $2 and tenant_id = $3', v_tbl)
    using coalesce(p_fields, '{}'::jsonb), p_entity_id, v_tenant;
  get diagnostics v_rows = row_count;
  if v_rows = 0 then
    raise exception '% not found.', p_entity;
  end if;
end $$;
