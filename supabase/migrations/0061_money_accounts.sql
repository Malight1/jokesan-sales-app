-- ============================================================
-- ProfixBook: money accounts and cash flow (accounting audit, part 2.1-2.3)
--
-- Where the money sits. Every business gets:
--   * a cash drawer per branch (the till's cash),
--   * a main bank account (where transfers and card money land unless
--     told otherwise),
--   * a wallet per connected payment provider (Moniepoint, OPay, Paystack).
-- More can be added (a second bank, a safe, petty cash).
--
-- money_ledger is one line per movement of money, kept in step by
-- triggers from the records that already exist: customer payments and
-- refunds, supplier payments, expenses, till pay in / pay out / banked
-- cash, till short/over at close, plus the new money_entries (moving money
-- between accounts, owner putting money in or taking it out, loans, other
-- income). It is never written by the app directly.
--
-- An account's balance = its starting balance on its start date, plus
-- every movement from that date on. Movements before the start date are
-- history that the starting balance already includes.
--
-- Run AFTER 0001-0060.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------
create table if not exists money_accounts (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null default public.current_tenant_id() references tenants(id) on delete cascade,
  name            text not null check (length(trim(name)) > 0),
  kind            text not null check (kind in ('cash', 'bank', 'wallet')),
  branch_id       uuid references branches(id) on delete set null,
  is_till         boolean not null default false,   -- the branch's cash drawer
  is_default      boolean not null default false,   -- where unassigned non-cash money lands
  provider        text check (provider in ('paystack', 'monnify', 'opay')),
  bank_name       text,
  account_number  text,
  opening_balance numeric(14,2) not null default 0,
  opening_date    date,
  is_active       boolean not null default true,
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_money_accounts_till     on money_accounts (tenant_id, branch_id) where is_till;
create unique index if not exists uq_money_accounts_default  on money_accounts (tenant_id) where is_default;
create unique index if not exists uq_money_accounts_provider on money_accounts (tenant_id, provider) where provider is not null;

create table if not exists money_entries (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null default public.current_tenant_id() references tenants(id) on delete cascade,
  kind         text not null check (kind in ('transfer', 'owner_in', 'owner_out', 'loan_in', 'loan_repay', 'other_in')),
  from_account uuid references money_accounts(id),
  to_account   uuid references money_accounts(id),
  amount       numeric(14,2) not null check (amount > 0),
  entry_date   date not null default public.shop_today(),
  note         text,
  voided       boolean not null default false,
  voided_at    timestamptz,
  voided_by    uuid references auth.users(id),
  created_by   uuid references auth.users(id) default auth.uid(),
  created_at   timestamptz not null default now()
);

create table if not exists money_ledger (
  id           bigserial primary key,
  tenant_id    uuid not null references tenants(id) on delete cascade,
  account_id   uuid not null references money_accounts(id) on delete cascade,
  entry_date   date not null,
  amount       numeric(14,2) not null,          -- + in, - out
  category     text not null,
  source_table text not null,
  source_id    uuid not null,
  description  text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_money_ledger_account on money_ledger (tenant_id, account_id, entry_date);
create index if not exists idx_money_ledger_source  on money_ledger (source_table, source_id);

-- Which account a payment method lands in (optional; sensible defaults otherwise).
alter table payment_types     add column if not exists money_account_id uuid references money_accounts(id) on delete set null;
-- An explicit choice on the row wins over the payment method's default.
alter table sale_payments     add column if not exists money_account_id uuid references money_accounts(id) on delete set null;
alter table purchase_payments add column if not exists money_account_id uuid references money_accounts(id) on delete set null;
alter table expenses          add column if not exists money_account_id uuid references money_accounts(id) on delete set null;

alter table money_accounts enable row level security;
alter table money_entries  enable row level security;
alter table money_ledger   enable row level security;

drop policy if exists money_accounts_read on money_accounts;
create policy money_accounts_read on money_accounts for select
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts'));
drop policy if exists money_accounts_write on money_accounts;
create policy money_accounts_write on money_accounts for all
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live())
  with check (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live());

drop policy if exists money_entries_read on money_entries;
create policy money_entries_read on money_entries for select
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts'));
drop policy if exists money_entries_insert on money_entries;
create policy money_entries_insert on money_entries for insert
  with check (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live());
drop policy if exists money_entries_update on money_entries;
create policy money_entries_update on money_entries for update
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live());

drop policy if exists money_ledger_read on money_ledger;
create policy money_ledger_read on money_ledger for select
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts'));


-- ------------------------------------------------------------
-- 2. Which account a movement belongs to
-- ------------------------------------------------------------
create or replace function public.money_default_account(p_tenant uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from money_accounts
   where tenant_id = p_tenant and kind <> 'cash'
   order by is_default desc, (kind = 'bank') desc, created_at
   limit 1
$$;

create or replace function public.money_till_account(p_tenant uuid, p_branch uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select id from money_accounts
   where tenant_id = p_tenant and kind = 'cash'
   order by (is_till and branch_id is not distinct from p_branch) desc, is_till desc, created_at
   limit 1
$$;

create or replace function public.money_account_for(
  p_tenant uuid, p_branch uuid, p_payment_type uuid, p_incoming uuid, p_explicit uuid
) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_id    uuid;
  v_prov  text;
  v_group text;
  v_map   uuid;
begin
  if p_explicit is not null then return p_explicit; end if;
  if p_incoming is not null then
    select provider into v_prov from incoming_payments where id = p_incoming;
    select id into v_id from money_accounts where tenant_id = p_tenant and provider = v_prov;
    if v_id is not null then return v_id; end if;
  end if;
  if p_payment_type is not null then
    select method_group, money_account_id into v_group, v_map from payment_types where id = p_payment_type;
    if v_map is not null then return v_map; end if;
    if v_group = 'store_credit' then return null; end if;   -- no real money moves
    if v_group = 'cash' then
      return coalesce(public.money_till_account(p_tenant, p_branch), public.money_default_account(p_tenant));
    end if;
  end if;
  return public.money_default_account(p_tenant);
end $$;


-- ------------------------------------------------------------
-- 3. Keeping the ledger in step
-- ------------------------------------------------------------
create or replace function public.money_sync(p_table text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  r       record;
  v_acc   uuid;
  v_acc2  uuid;
  v_date  date;
  v_label text;
begin
  delete from money_ledger where source_table = p_table and source_id = p_id;

  if p_table = 'sale_payments' then
    select sp.tenant_id, sp.amount_paid, sp.payment_date, sp.payment_type_id, sp.incoming_payment_id, sp.money_account_id,
           sp.reference, so.branch_id, so.voided, so.doc_no
      into r from sale_payments sp join sales_orders so on so.id = sp.sales_order_id where sp.id = p_id;
    if not found or r.voided or r.amount_paid = 0 or r.reference = 'STORE_CREDIT' then return; end if;
    v_acc := public.money_account_for(r.tenant_id, r.branch_id, r.payment_type_id, r.incoming_payment_id, r.money_account_id);
    if v_acc is null then return; end if;
    insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
    values (r.tenant_id, v_acc, r.payment_date, r.amount_paid,
            case when r.amount_paid > 0 then 'customer_payment' else 'refund' end, p_table, p_id,
            case when r.amount_paid > 0 then 'Payment for ' else 'Refund on ' end || coalesce(r.doc_no, 'a sale'));

  elsif p_table = 'purchase_payments' then
    select pp.tenant_id, pp.amount_paid, pp.payment_date, pp.payment_type_id, pp.money_account_id,
           po.branch_id, po.voided, po.doc_no
      into r from purchase_payments pp join purchase_orders po on po.id = pp.purchase_order_id where pp.id = p_id;
    if not found or r.voided or r.amount_paid = 0 then return; end if;
    v_acc := public.money_account_for(r.tenant_id, r.branch_id, r.payment_type_id, null, r.money_account_id);
    if v_acc is null then return; end if;
    insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
    values (r.tenant_id, v_acc, r.payment_date, -r.amount_paid, 'supplier_payment', p_table, p_id,
            'Paid supplier for ' || coalesce(r.doc_no, 'a purchase'));

  elsif p_table = 'expenses' then
    select e.tenant_id, e.amount, e.expense_date, e.payment_type_id, e.money_account_id, e.branch_id, e.voided,
           e.description, et.name as type_name
      into r from expenses e left join expense_types et on et.id = e.expense_type_id where e.id = p_id;
    if not found or r.voided or r.amount = 0 then return; end if;
    v_acc := public.money_account_for(r.tenant_id, r.branch_id, r.payment_type_id, null, r.money_account_id);
    if v_acc is null then return; end if;
    insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
    values (r.tenant_id, v_acc, r.expense_date, -r.amount, 'expense', p_table, p_id,
            coalesce(nullif(trim(r.description), ''), r.type_name, 'Expense'));

  elsif p_table = 'cash_movements' then
    select cm.tenant_id, cm.kind, cm.amount, cm.reason, cm.expense_id, cm.created_at, s.branch_id
      into r from cash_movements cm join shifts s on s.id = cm.shift_id where cm.id = p_id;
    if not found or r.expense_id is not null then return; end if;   -- the expense carries it
    v_acc  := public.money_till_account(r.tenant_id, r.branch_id);
    if v_acc is null then return; end if;
    v_date := (r.created_at at time zone 'Africa/Lagos')::date;
    if r.kind = 'pay_in' then
      insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
      values (r.tenant_id, v_acc, v_date, r.amount, 'till_pay_in', p_table, p_id, 'Paid into the till: ' || r.reason);
    elsif r.kind = 'pay_out' then
      insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
      values (r.tenant_id, v_acc, v_date, -r.amount, 'till_pay_out', p_table, p_id, 'Paid out of the till: ' || r.reason);
    else
      -- Cash taken to the bank: out of the drawer, into the main bank account.
      v_acc2 := public.money_default_account(r.tenant_id);
      insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
      values (r.tenant_id, v_acc, v_date, -r.amount, 'transfer', p_table, p_id, 'Cash taken from the till: ' || r.reason);
      if v_acc2 is not null and v_acc2 <> v_acc then
        insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
        values (r.tenant_id, v_acc2, v_date, r.amount, 'transfer', p_table, p_id, 'Cash banked from the till: ' || r.reason);
      end if;
    end if;

  elsif p_table = 'shifts' then
    select tenant_id, branch_id, status, variance, closed_at, doc_no into r from shifts where id = p_id;
    if not found or r.status <> 'closed' or coalesce(r.variance, 0) = 0 then return; end if;
    v_acc := public.money_till_account(r.tenant_id, r.branch_id);
    if v_acc is null then return; end if;
    insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
    values (r.tenant_id, v_acc, (r.closed_at at time zone 'Africa/Lagos')::date, r.variance, 'till_difference', p_table, p_id,
            case when r.variance < 0 then 'Till short at close' else 'Till over at close' end || coalesce(' (' || r.doc_no || ')', ''));

  elsif p_table = 'money_entries' then
    select * into r from money_entries where id = p_id;
    if not found or r.voided then return; end if;
    v_label := case r.kind
      when 'transfer'   then 'Moved money'
      when 'owner_in'   then 'Owner put money in'
      when 'owner_out'  then 'Owner took money out'
      when 'loan_in'    then 'Loan received'
      when 'loan_repay' then 'Loan repayment'
      else 'Other money in' end || coalesce(': ' || nullif(trim(r.note), ''), '');
    if r.from_account is not null then
      insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
      values (r.tenant_id, r.from_account, r.entry_date, -r.amount, r.kind, p_table, p_id, v_label);
    end if;
    if r.to_account is not null then
      insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
      values (r.tenant_id, r.to_account, r.entry_date, r.amount, r.kind, p_table, p_id, v_label);
    end if;

  elsif p_table = 'money_accounts' then
    select * into r from money_accounts where id = p_id;
    if not found or r.opening_balance = 0 then return; end if;
    insert into money_ledger (tenant_id, account_id, entry_date, amount, category, source_table, source_id, description)
    values (r.tenant_id, r.id, coalesce(r.opening_date, (r.created_at at time zone 'Africa/Lagos')::date),
            r.opening_balance, 'opening', p_table, p_id, 'Starting balance');
  end if;
end $$;
revoke execute on function public.money_sync(text, uuid) from public, anon, authenticated;

-- Rebuild one business's ledger from scratch (after the defaults change).
create or replace function public.money_rebuild(p_tenant uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  delete from money_ledger where tenant_id = p_tenant;
  for v in select id from money_accounts where tenant_id = p_tenant loop perform public.money_sync('money_accounts', v); end loop;
  for v in select id from sale_payments where tenant_id = p_tenant loop perform public.money_sync('sale_payments', v); end loop;
  for v in select id from purchase_payments where tenant_id = p_tenant loop perform public.money_sync('purchase_payments', v); end loop;
  for v in select id from expenses where tenant_id = p_tenant loop perform public.money_sync('expenses', v); end loop;
  for v in select id from cash_movements where tenant_id = p_tenant loop perform public.money_sync('cash_movements', v); end loop;
  for v in select id from shifts where tenant_id = p_tenant and status = 'closed' loop perform public.money_sync('shifts', v); end loop;
  for v in select id from money_entries where tenant_id = p_tenant loop perform public.money_sync('money_entries', v); end loop;
end $$;
revoke execute on function public.money_rebuild(uuid) from public, anon, authenticated;

create or replace function public.trg_money_sync()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.money_sync(TG_TABLE_NAME, coalesce(NEW.id, OLD.id));
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['sale_payments', 'purchase_payments', 'expenses', 'cash_movements', 'shifts', 'money_entries'] loop
    execute format('drop trigger if exists trg_money_sync on %I;', t);
    execute format('create trigger trg_money_sync after insert or update or delete on %I for each row execute function public.trg_money_sync();', t);
  end loop;
end $$;

-- A voided sale or purchase takes its payments out of the money figures.
create or replace function public.trg_money_sync_parent()
returns trigger language plpgsql security definer set search_path = public as $$
declare v uuid;
begin
  if NEW.voided is not distinct from OLD.voided then return null; end if;
  if TG_TABLE_NAME = 'sales_orders' then
    for v in select id from sale_payments where sales_order_id = NEW.id loop perform public.money_sync('sale_payments', v); end loop;
  else
    for v in select id from purchase_payments where purchase_order_id = NEW.id loop perform public.money_sync('purchase_payments', v); end loop;
  end if;
  return null;
end $$;
drop trigger if exists trg_money_sync_parent on sales_orders;
create trigger trg_money_sync_parent after update of voided on sales_orders
  for each row execute function public.trg_money_sync_parent();
drop trigger if exists trg_money_sync_parent on purchase_orders;
create trigger trg_money_sync_parent after update of voided on purchase_orders
  for each row execute function public.trg_money_sync_parent();

-- An account's starting balance, or the defaults changing, rebuilds.
create or replace function public.trg_money_accounts_changed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if current_setting('profixbook.skip_money_rebuild', true) = 'on' then return null; end if;
  if TG_OP = 'INSERT' then
    perform public.money_sync('money_accounts', NEW.id);
    if NEW.is_default or NEW.is_till or NEW.provider is not null then perform public.money_rebuild(NEW.tenant_id); end if;
  elsif (NEW.is_default, NEW.is_till, NEW.branch_id, NEW.provider) is distinct from (OLD.is_default, OLD.is_till, OLD.branch_id, OLD.provider) then
    perform public.money_rebuild(NEW.tenant_id);
  elsif (NEW.opening_balance, NEW.opening_date) is distinct from (OLD.opening_balance, OLD.opening_date) then
    perform public.money_sync('money_accounts', NEW.id);
  end if;
  return null;
end $$;
drop trigger if exists trg_money_accounts_changed on money_accounts;
create trigger trg_money_accounts_changed after insert or update on money_accounts
  for each row execute function public.trg_money_accounts_changed();

create or replace function public.trg_payment_type_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if NEW.money_account_id is distinct from OLD.money_account_id then
    perform public.money_rebuild(NEW.tenant_id);
  end if;
  return null;
end $$;
drop trigger if exists trg_payment_type_account on payment_types;
create trigger trg_payment_type_account after update of money_account_id on payment_types
  for each row execute function public.trg_payment_type_account();


-- ------------------------------------------------------------
-- 4. Rules for accounts and entries
-- ------------------------------------------------------------
create or replace function public.guard_money_account()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'DELETE' then
    if auth.uid() is not null and exists (select 1 from money_ledger where account_id = OLD.id and source_table <> 'money_accounts') then
      raise exception 'This account has money movements, so it can''t be deleted. Switch it off instead.';
    end if;
    return OLD;
  end if;
  if NEW.kind = 'cash' then NEW.provider := null; end if;
  if NEW.kind <> 'cash' then NEW.is_till := false; end if;
  if NEW.is_till and NEW.branch_id is null then
    raise exception 'A till''s cash drawer needs a branch.';
  end if;
  if NEW.is_default and NEW.kind = 'cash' then
    raise exception 'The main account for transfers has to be a bank or wallet.';
  end if;
  if NEW.branch_id is not null and not exists (select 1 from branches where id = NEW.branch_id and tenant_id = NEW.tenant_id) then
    raise exception 'That branch does not belong to this company.';
  end if;
  return NEW;
end $$;
drop trigger if exists trg_guard_money_account on money_accounts;
create trigger trg_guard_money_account before insert or update or delete on money_accounts
  for each row execute function public.guard_money_account();

create or replace function public.guard_money_entry()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'DELETE' then
    if auth.uid() is not null then
      raise exception 'Money entries can''t be deleted. Void it instead, so there is a record of it.';
    end if;
    return OLD;
  end if;
  if TG_OP = 'UPDATE' then
    if OLD.voided then raise exception 'This entry was voided and can''t be changed.'; end if;
    if NEW.voided then
      NEW.voided_at := now(); NEW.voided_by := auth.uid();
      return NEW;
    end if;
  end if;
  -- Which side each kind needs.
  if NEW.kind = 'transfer' and (NEW.from_account is null or NEW.to_account is null) then
    raise exception 'Pick the account the money left and the one it went into.';
  end if;
  if NEW.kind = 'transfer' and NEW.from_account = NEW.to_account then
    raise exception 'The two accounts have to be different.';
  end if;
  if NEW.kind in ('owner_in', 'loan_in', 'other_in') then
    if NEW.to_account is null then raise exception 'Pick the account the money went into.'; end if;
    NEW.from_account := null;
  end if;
  if NEW.kind in ('owner_out', 'loan_repay') then
    if NEW.from_account is null then raise exception 'Pick the account the money came out of.'; end if;
    NEW.to_account := null;
  end if;
  if exists (select 1 from money_accounts where id in (NEW.from_account, NEW.to_account) and tenant_id <> NEW.tenant_id) then
    raise exception 'That account does not belong to this company.';
  end if;
  return NEW;
end $$;
drop trigger if exists trg_guard_money_entry on money_entries;
create trigger trg_guard_money_entry before insert or update or delete on money_entries
  for each row execute function public.guard_money_entry();

-- Closed books (0060) apply to money entries too.
drop trigger if exists trg_guard_closed_period on money_entries;
create trigger trg_guard_closed_period before insert or update or delete on money_entries
  for each row execute function public.guard_closed_period('entry_date', 'entry_date,amount,kind,from_account,to_account,voided');

-- Activity log.
drop trigger if exists trg_audit_row_change on money_entries;
create trigger trg_audit_row_change after insert or update or delete on money_entries
  for each row execute function public.audit_row_change('kind,from_account,to_account,amount,entry_date,note,voided', 'tenant_id');
drop trigger if exists trg_audit_row_change on money_accounts;
create trigger trg_audit_row_change after insert or update or delete on money_accounts
  for each row execute function public.audit_row_change('name,kind,branch_id,is_default,provider,bank_name,account_number,opening_balance,opening_date,is_active', 'tenant_id');


-- ------------------------------------------------------------
-- 5. Default accounts for every business
-- ------------------------------------------------------------
create or replace function public.ensure_money_accounts(p_tenant uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  b record;
  p record;
  v_bank jsonb;
  v_multi boolean;
  v_label text;
begin
  if p_tenant is null then return; end if;
  select count(*) > 1 into v_multi from branches where tenant_id = p_tenant;
  for b in select id, name from branches where tenant_id = p_tenant order by created_at loop
    if not exists (select 1 from money_accounts where tenant_id = p_tenant and is_till and branch_id = b.id) then
      insert into money_accounts (tenant_id, name, kind, branch_id, is_till)
      values (p_tenant, case when v_multi then 'Cash drawer, ' || b.name else 'Cash drawer' end, 'cash', b.id, true);
    end if;
  end loop;
  if not exists (select 1 from money_accounts where tenant_id = p_tenant and kind = 'bank') then
    select bank_details into v_bank from tenants where id = p_tenant;
    insert into money_accounts (tenant_id, name, kind, is_default, bank_name, account_number)
    values (p_tenant, coalesce(nullif(trim(v_bank->>'bank_name'), ''), 'Main bank account'), 'bank',
            not exists (select 1 from money_accounts where tenant_id = p_tenant and is_default),
            nullif(trim(v_bank->>'bank_name'), ''), nullif(trim(v_bank->>'account_number'), ''));
  end if;
  for p in select provider from payment_integrations where tenant_id = p_tenant loop
    if not exists (select 1 from money_accounts where tenant_id = p_tenant and provider = p.provider) then
      v_label := case p.provider when 'monnify' then 'Moniepoint' when 'opay' then 'OPay' else 'Paystack' end;
      insert into money_accounts (tenant_id, name, kind, provider) values (p_tenant, v_label, 'wallet', p.provider);
    end if;
  end loop;
end $$;
revoke execute on function public.ensure_money_accounts(uuid) from public, anon, authenticated;

create or replace function public.trg_ensure_money_accounts()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.ensure_money_accounts(NEW.tenant_id);
  return null;
end $$;
drop trigger if exists trg_ensure_money_accounts on branches;
create trigger trg_ensure_money_accounts after insert on branches
  for each row execute function public.trg_ensure_money_accounts();
drop trigger if exists trg_ensure_money_accounts on payment_integrations;
create trigger trg_ensure_money_accounts after insert on payment_integrations
  for each row execute function public.trg_ensure_money_accounts();

-- Existing businesses: accounts first, then one rebuild each.
do $$
declare t uuid;
begin
  perform set_config('profixbook.skip_money_rebuild', 'on', true);
  for t in select id from tenants loop perform public.ensure_money_accounts(t); end loop;
  perform set_config('profixbook.skip_money_rebuild', 'off', true);
  for t in select id from tenants loop perform public.money_rebuild(t); end loop;
end $$;


-- ------------------------------------------------------------
-- 6. Provider charges come out of that provider's wallet
-- ------------------------------------------------------------
create or replace function public.record_payment_fee(
  p_tenant   uuid,
  p_provider text,
  p_ref      text,
  p_fee      numeric,
  p_branch   uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_type   uuid;
  v_branch uuid;
  v_id     uuid;
  v_label  text := case p_provider when 'monnify' then 'Moniepoint' when 'opay' then 'OPay'
                                   when 'paystack' then 'Paystack' else p_provider end;
begin
  if p_fee is null or p_fee <= 0 then return null; end if;

  update incoming_payments set fee = p_fee
   where tenant_id = p_tenant and provider = p_provider and provider_ref = p_ref;

  select id into v_type from expense_types
   where tenant_id = p_tenant and lower(name) = 'payment charges' limit 1;
  if v_type is null then
    insert into expense_types (tenant_id, name) values (p_tenant, 'Payment charges') returning id into v_type;
  end if;
  v_branch := coalesce(p_branch, public.default_branch_id(p_tenant));

  insert into expenses (tenant_id, branch_id, expense_date, expense_type_id, description, amount, source, source_ref, money_account_id)
  values (p_tenant, v_branch, public.shop_today(), v_type, v_label || ' charge on payment ' || p_ref,
          round(p_fee, 2), 'payment_fee', p_provider || ':' || p_ref,
          (select id from money_accounts where tenant_id = p_tenant and provider = p_provider))
  on conflict (tenant_id, source, source_ref) where source is not null do nothing
  returning id into v_id;
  return v_id;
end $$;
revoke execute on function public.record_payment_fee(uuid, text, text, numeric, uuid) from public, anon, authenticated;


-- ------------------------------------------------------------
-- 7. Balances and the cash flow report
-- ------------------------------------------------------------
-- Per account: balance at the start of the period, money in, money out,
-- balance at the end. Per kind of movement: how much came in and went out.
-- Movements before an account's start date are left out (its starting
-- balance already includes them).
create or replace function public.report_cash_flow(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_to     date := coalesce(p_to, public.shop_today());
  v_out    jsonb;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('accounts') then
    raise exception 'Only the owner or accounts can see this.' using errcode = 'insufficient_privilege';
  end if;

  with lines as (
    select l.*, (p_from is null or l.entry_date >= p_from) and l.entry_date <= v_to as in_range
      from money_ledger l join money_accounts a on a.id = l.account_id
     where l.tenant_id = v_tenant
       and (a.opening_date is null or l.entry_date >= a.opening_date)
       and l.entry_date <= v_to
  ), per_account as (
    select a.id, a.name, a.kind, a.is_till, a.is_default, a.provider, a.branch_id, a.bank_name, a.account_number,
           a.opening_balance, a.opening_date, a.is_active,
           coalesce(sum(l.amount), 0) as closing,
           coalesce(sum(l.amount) filter (where l.in_range and l.amount > 0 and l.category <> 'opening'), 0) as money_in,
           coalesce(-sum(l.amount) filter (where l.in_range and l.amount < 0 and l.category <> 'opening'), 0) as money_out,
           count(l.id) filter (where l.category <> 'opening') as movements
      from money_accounts a left join lines l on l.account_id = a.id
     where a.tenant_id = v_tenant
     group by a.id
  ), per_category as (
    select category,
           coalesce(sum(amount) filter (where amount > 0), 0) as money_in,
           coalesce(-sum(amount) filter (where amount < 0), 0) as money_out
      from lines where in_range and category <> 'opening'
     group by category
  )
  select jsonb_build_object(
    'from', p_from, 'to', v_to,
    'accounts', coalesce((select jsonb_agg(jsonb_build_object(
        'id', id, 'name', name, 'kind', kind, 'is_till', is_till, 'is_default', is_default, 'provider', provider,
        'branch_id', branch_id, 'bank_name', bank_name, 'account_number', account_number,
        'opening_balance', opening_balance, 'opening_date', opening_date, 'is_active', is_active,
        'start', closing - money_in + money_out, 'money_in', money_in, 'money_out', money_out,
        'closing', closing, 'movements', movements)
        order by case kind when 'cash' then 0 when 'bank' then 1 else 2 end, name) from per_account), '[]'::jsonb),
    'categories', coalesce((select jsonb_agg(jsonb_build_object('category', category, 'money_in', money_in, 'money_out', money_out)
        order by category) from per_category), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
grant execute on function public.report_cash_flow(date, date) to authenticated;
