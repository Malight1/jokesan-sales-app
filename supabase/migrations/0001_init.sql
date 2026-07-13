-- ============================================================
-- StockFlow — Initial schema (Phase 1 + 2 foundation)
-- Multi-tenant manufacturing ERP with FIFO costing
-- Paste this whole file into Supabase → SQL Editor → Run
-- ============================================================

-- ---------- Extensions ----------
create extension if not exists "pgcrypto";   -- gen_random_uuid()

-- ---------- Enums ----------
do $$ begin
  create type tenant_type   as enum ('single', 'multi_branch');
exception when duplicate_object then null; end $$;

do $$ begin
  create type plan_tier     as enum ('trial', 'starter', 'growth', 'enterprise');
exception when duplicate_object then null; end $$;

do $$ begin
  create type user_role     as enum ('admin', 'sales', 'inventory', 'accounts');
exception when duplicate_object then null; end $$;

do $$ begin
  create type movement_type as enum ('PURCHASE', 'PRODUCTION', 'SALE', 'ADJUSTMENT');
exception when duplicate_object then null; end $$;

do $$ begin
  create type pay_status    as enum ('unpaid', 'part', 'full');
exception when duplicate_object then null; end $$;

-- ============================================================
-- PLATFORM TABLES
-- ============================================================

create table if not exists tenants (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  slug          text unique not null,
  type          tenant_type not null default 'single',
  plan          plan_tier   not null default 'trial',
  trial_ends_at timestamptz default (now() + interval '14 days'),
  currency      text not null default 'NGN',
  country       text not null default 'NG',
  logo_url      text,
  is_active     boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists branches (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  name       text not null,
  address    text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

-- Mirrors auth.users 1:1; holds tenant, branch, role
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  tenant_id  uuid references tenants(id) on delete cascade,
  branch_id  uuid references branches(id) on delete set null,
  role       user_role not null default 'admin',
  full_name  text,
  phone      text,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists subscriptions (
  id                 uuid primary key default gen_random_uuid(),
  tenant_id          uuid not null references tenants(id) on delete cascade,
  plan               plan_tier not null,
  status             text not null default 'trialing',
  provider           text default 'paystack',
  amount             numeric(14,2) default 0,
  interval           text default 'monthly',
  current_period_end timestamptz,
  paystack_sub_code  text,
  created_at         timestamptz not null default now()
);

create table if not exists audit_logs (
  id         bigint generated always as identity primary key,
  tenant_id  uuid references tenants(id) on delete cascade,
  user_id    uuid references auth.users(id) on delete set null,
  action     text not null,
  entity     text,
  entity_id  text,
  meta       jsonb,
  created_at timestamptz not null default now()
);

-- ============================================================
-- HELPER FUNCTIONS (used by RLS — security definer bypasses RLS)
-- ============================================================

create or replace function public.current_tenant_id()
returns uuid language sql stable security definer set search_path = public as $$
  select tenant_id from public.profiles where id = auth.uid()
$$;

create or replace function public.current_role()
returns user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

create or replace function public.current_branch_id()
returns uuid language sql stable security definer set search_path = public as $$
  select branch_id from public.profiles where id = auth.uid()
$$;

-- ============================================================
-- BUSINESS LOOKUP TABLES
-- ============================================================

create table if not exists customer_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null
);

create table if not exists payment_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null
);

create table if not exists expense_types (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null
);

-- ============================================================
-- CONTACTS
-- ============================================================

create table if not exists customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  branch_id uuid references branches(id) on delete set null,
  first_name text,
  last_name  text,
  company_store text,
  address text,
  phone text,
  email text,
  customer_type_id uuid references customer_types(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  branch_id uuid references branches(id) on delete set null,
  first_name text,
  last_name  text,
  company_store text,
  address text,
  email text,
  phone text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- INVENTORY: raw materials + finished goods
-- ============================================================

create table if not exists materials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  unit text,
  type_of_material text default 'Raw Material',  -- 'Raw Material' | 'Packaging Material'
  qty_balance numeric(14,3) not null default 0,
  min_stock_level numeric(14,3) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists finished_goods (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  name text not null,
  unit text default 'pcs',
  qty_balance numeric(14,3) not null default 0,
  min_stock_level numeric(14,3) not null default 0,
  default_markup numeric(6,3) not null default 1.5,  -- selling = unit_cost * markup (Access used 1.5)
  selling_price numeric(14,2) default 0,
  created_at timestamptz not null default now()
);

-- ============================================================
-- BILL OF MATERIALS (recipe per finished good)
-- ============================================================

create table if not exists boms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  finished_good_id uuid not null references finished_goods(id) on delete cascade,
  yield_qty numeric(14,3) not null default 1,  -- recipe makes this many units
  created_at timestamptz not null default now()
);

create table if not exists bom_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  bom_id uuid not null references boms(id) on delete cascade,
  material_id uuid not null references materials(id) on delete cascade,
  quantity numeric(14,3) not null default 0,
  unit text
);

-- ============================================================
-- PURCHASES (supplier orders) — purchase_items are FIFO cost source
-- ============================================================

create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  branch_id uuid references branches(id) on delete set null,
  supplier_id uuid references suppliers(id) on delete set null,
  purchase_date date not null default current_date,
  total_amount numeric(14,2) not null default 0,
  total_paid   numeric(14,2) not null default 0,
  balance      numeric(14,2) not null default 0,
  payment_type_id uuid references payment_types(id) on delete set null,
  payment_status pay_status not null default 'unpaid',
  processed boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- each row = a purchase batch of a material, with qty_remaining for FIFO
create table if not exists purchase_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  material_id uuid not null references materials(id) on delete restrict,
  qty numeric(14,3) not null,
  qty_remaining numeric(14,3) not null,
  cost_price numeric(14,2) not null,   -- per-unit cost for THIS batch
  amount numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists purchase_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  payment_date date not null default current_date,
  amount_paid numeric(14,2) not null,
  payment_type_id uuid references payment_types(id) on delete set null,
  reference text,
  notes text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- PRODUCTION — runs, what they consumed (FIFO), resulting FG batches
-- ============================================================

create table if not exists production_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  branch_id uuid references branches(id) on delete set null,
  finished_good_id uuid not null references finished_goods(id) on delete restrict,
  production_date date not null default current_date,
  expenses numeric(14,2) not null default 0,
  material_cost numeric(14,2) not null default 0,
  total_cost numeric(14,2) not null default 0,
  unit_cost numeric(14,2) not null default 0,
  qty_produced numeric(14,3) not null default 0,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- which purchase batch each material was drawn from (FIFO trace)
create table if not exists production_consumption (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  production_run_id uuid not null references production_runs(id) on delete cascade,
  material_id uuid not null references materials(id) on delete restrict,
  purchase_item_id uuid references purchase_items(id) on delete set null,
  qty numeric(14,3) not null,
  cost_price numeric(14,2) not null,   -- batch cost used
  created_at timestamptz not null default now()
);

-- finished-goods batches; qty_remaining drives FIFO on sale
create table if not exists fg_batches (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  production_run_id uuid references production_runs(id) on delete set null,
  finished_good_id uuid not null references finished_goods(id) on delete cascade,
  qty numeric(14,3) not null,
  qty_remaining numeric(14,3) not null,
  unit_cost numeric(14,2) not null,
  selling_price numeric(14,2) not null,
  produced_at timestamptz not null default now()
);

-- ============================================================
-- SALES — orders, line items, payments, FIFO consumption (COGS)
-- ============================================================

create table if not exists sales_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  branch_id uuid references branches(id) on delete set null,
  customer_id uuid references customers(id) on delete set null,
  transaction_date date not null default current_date,
  total_amount numeric(14,2) not null default 0,
  amount_paid  numeric(14,2) not null default 0,
  balance      numeric(14,2) not null default 0,
  cogs         numeric(14,2) not null default 0,   -- cost of goods sold (from FIFO)
  gross_profit numeric(14,2) not null default 0,
  payment_type_id uuid references payment_types(id) on delete set null,
  payment_status pay_status not null default 'unpaid',
  reference text,
  notes text,
  processed boolean not null default false,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create table if not exists sale_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  sales_order_id uuid not null references sales_orders(id) on delete cascade,
  finished_good_id uuid not null references finished_goods(id) on delete restrict,
  quantity numeric(14,3) not null,
  unit_price numeric(14,2) not null,
  amount numeric(14,2) not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists sale_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  sales_order_id uuid not null references sales_orders(id) on delete cascade,
  payment_date date not null default current_date,
  amount_paid numeric(14,2) not null,
  payment_type_id uuid references payment_types(id) on delete set null,
  reference text,
  notes text,
  created_at timestamptz not null default now()
);

-- which fg_batch each sold unit came from (FIFO trace → exact COGS)
create table if not exists sales_consumption (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  sale_item_id uuid not null references sale_items(id) on delete cascade,
  fg_batch_id uuid references fg_batches(id) on delete set null,
  finished_good_id uuid not null references finished_goods(id) on delete restrict,
  qty numeric(14,3) not null,
  unit_cost numeric(14,2) not null,
  selling_price numeric(14,2) not null,
  created_at timestamptz not null default now()
);

-- ============================================================
-- EXPENSES + STOCK LEDGER
-- ============================================================

create table if not exists expenses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references tenants(id) on delete cascade,
  branch_id uuid references branches(id) on delete set null,
  expense_date date not null default current_date,
  expense_type_id uuid references expense_types(id) on delete set null,
  description text,
  amount numeric(14,2) not null default 0,
  payment_type_id uuid references payment_types(id) on delete set null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- immutable audit ledger; source of truth for stock balances
create table if not exists stock_movements (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references tenants(id) on delete cascade,
  branch_id uuid references branches(id) on delete set null,
  product_kind text not null,            -- 'material' | 'finished_good'
  product_id uuid not null,
  movement_type movement_type not null,
  quantity numeric(14,3) not null,       -- + in, - out
  reference_id uuid,                     -- sale/purchase/production id
  user_id uuid references auth.users(id),
  created_at timestamptz not null default now()
);

-- ============================================================
-- INDEXES (tenant + common filters)
-- ============================================================
create index if not exists idx_customers_tenant   on customers(tenant_id);
create index if not exists idx_suppliers_tenant    on suppliers(tenant_id);
create index if not exists idx_materials_tenant     on materials(tenant_id);
create index if not exists idx_fg_tenant            on finished_goods(tenant_id);
create index if not exists idx_po_tenant_date       on purchase_orders(tenant_id, purchase_date);
create index if not exists idx_pi_tenant_mat        on purchase_items(tenant_id, material_id);
create index if not exists idx_prod_tenant_date     on production_runs(tenant_id, production_date);
create index if not exists idx_fgb_tenant_fg        on fg_batches(tenant_id, finished_good_id);
create index if not exists idx_so_tenant_date       on sales_orders(tenant_id, transaction_date);
create index if not exists idx_si_tenant_so         on sale_items(tenant_id, sales_order_id);
create index if not exists idx_sm_tenant_prod       on stock_movements(tenant_id, product_id);
create index if not exists idx_exp_tenant_date      on expenses(tenant_id, expense_date);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================

-- enable RLS on every table
do $$
declare t text;
begin
  foreach t in array array[
    'tenants','branches','profiles','subscriptions','audit_logs',
    'customer_types','payment_types','expense_types','customers','suppliers',
    'materials','finished_goods','boms','bom_items',
    'purchase_orders','purchase_items','purchase_payments',
    'production_runs','production_consumption','fg_batches',
    'sales_orders','sale_items','sale_payments','sales_consumption',
    'expenses','stock_movements'
  ]
  loop
    execute format('alter table %I enable row level security;', t);
  end loop;
end $$;

-- tenants: a user sees only their own tenant
create policy tenant_self_select on tenants for select
  using (id = public.current_tenant_id());
create policy tenant_self_update on tenants for update
  using (id = public.current_tenant_id() and public.current_role() = 'admin');

-- profiles: see profiles in same tenant; admin manages
create policy profiles_select on profiles for select
  using (tenant_id = public.current_tenant_id());
create policy profiles_insert on profiles for insert
  with check (tenant_id = public.current_tenant_id() and public.current_role() = 'admin');
create policy profiles_update on profiles for update
  using (tenant_id = public.current_tenant_id() and public.current_role() = 'admin');

-- branches: tenant-scoped; admin writes
create policy branches_select on branches for select
  using (tenant_id = public.current_tenant_id());
create policy branches_write on branches for all
  using (tenant_id = public.current_tenant_id() and public.current_role() = 'admin')
  with check (tenant_id = public.current_tenant_id() and public.current_role() = 'admin');

-- subscriptions / audit: tenant-scoped read; admin only for subs
create policy subs_select on subscriptions for select
  using (tenant_id = public.current_tenant_id());
create policy audit_select on audit_logs for select
  using (tenant_id = public.current_tenant_id());

-- Generic tenant-isolation policy for all remaining business tables.
-- (Branch-level scoping for sales/inventory roles is added in a later
--  migration once roles are exercised; tenant isolation is the hard wall.)
do $$
declare t text;
begin
  foreach t in array array[
    'customer_types','payment_types','expense_types','customers','suppliers',
    'materials','finished_goods','boms','bom_items',
    'purchase_orders','purchase_items','purchase_payments',
    'production_runs','production_consumption','fg_batches',
    'sales_orders','sale_items','sale_payments','sales_consumption',
    'expenses','stock_movements'
  ]
  loop
    execute format($f$
      create policy %1$s_tenant_all on %1$I for all
      using (tenant_id = public.current_tenant_id())
      with check (tenant_id = public.current_tenant_id());
    $f$, t);
  end loop;
end $$;

-- ============================================================
-- SIGNUP TRIGGER — create tenant + branch + admin profile
-- Reads company info passed in auth metadata at sign-up.
-- ============================================================

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_tenant_id uuid;
  new_branch_id uuid;
  company text;
  ttype tenant_type;
  base_slug text;
begin
  company := coalesce(new.raw_user_meta_data ->> 'company_name', 'My Company');
  ttype   := coalesce((new.raw_user_meta_data ->> 'tenant_type')::tenant_type, 'single');
  base_slug := lower(regexp_replace(company, '[^a-zA-Z0-9]+', '-', 'g'))
               || '-' || substr(new.id::text, 1, 6);

  insert into tenants (name, slug, type)
    values (company, base_slug, ttype)
    returning id into new_tenant_id;

  insert into branches (tenant_id, name)
    values (new_tenant_id, 'Main')
    returning id into new_branch_id;

  insert into profiles (id, tenant_id, branch_id, role, full_name)
    values (new.id, new_tenant_id, new_branch_id, 'admin',
            new.raw_user_meta_data ->> 'full_name');

  -- seed default lookups
  insert into payment_types (tenant_id, name) values
    (new_tenant_id,'Cash'), (new_tenant_id,'Bank Transfer'), (new_tenant_id,'Credit');
  insert into customer_types (tenant_id, name) values
    (new_tenant_id,'Corporate'), (new_tenant_id,'Private');
  insert into expense_types (tenant_id, name) values
    (new_tenant_id,'Transport'), (new_tenant_id,'Salary'), (new_tenant_id,'Rent');

  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ============================================================
-- Done. Next migration adds the FIFO costing RPC functions.
-- ============================================================
