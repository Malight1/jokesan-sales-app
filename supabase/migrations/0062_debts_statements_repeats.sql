-- ============================================================
-- ProfixBook: due dates, opening debts, bad debts, statements and
-- repeat expenses (accounting audit, part 2.5 to 2.9)
--
--  1. Payment terms and due dates. Customers and suppliers can have
--     payment terms in days (or the business default); every invoice and
--     bill gets a due date, which the aging in Reports reads.
--  2. Opening debts. What a customer already owed (or what you already
--     owed a supplier) before ProfixBook. Stored as an invoice / bill that
--     owes money but adds nothing to sales or purchases: total_amount is 0,
--     balance and opening_amount carry the debt. So revenue, profit and
--     purchase totals are untouched everywhere, and the debt shows in
--     balances, debtors, statements, aging and collection like any other.
--  3. Bad debts. Writing off what a customer will never pay. Reduces the
--     invoice's balance (no money moves) and shows as a cost on the P&L.
--  4. Customer statements: every invoice, payment, return and write-off
--     for a period with a running balance.
--  5. Repeat expenses (rent, salaries, diesel): created on their dates by
--     run_recurring_expenses(), which the app calls when the owner or
--     accounts opens it. No scheduler needed; each date is made once.
--
-- Run AFTER 0001-0061.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Payment terms and due dates
-- ------------------------------------------------------------
alter table tenants         add column if not exists payment_terms_days int check (payment_terms_days between 0 and 365);
alter table customers       add column if not exists payment_terms_days int check (payment_terms_days between 0 and 365);
alter table suppliers       add column if not exists payment_terms_days int check (payment_terms_days between 0 and 365);
alter table sales_orders    add column if not exists due_date date;
alter table purchase_orders add column if not exists due_date date;

create or replace function public.set_due_date_default()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_days int;
begin
  if NEW.due_date is not null then return NEW; end if;
  if TG_TABLE_NAME = 'sales_orders' then
    select payment_terms_days into v_days from customers where id = NEW.customer_id;
    if v_days is null then select payment_terms_days into v_days from tenants where id = NEW.tenant_id; end if;
    NEW.due_date := NEW.transaction_date + coalesce(v_days, 0);
  else
    select payment_terms_days into v_days from suppliers where id = NEW.supplier_id;
    if v_days is null then select payment_terms_days into v_days from tenants where id = NEW.tenant_id; end if;
    NEW.due_date := NEW.purchase_date + coalesce(v_days, 0);
  end if;
  return NEW;
end $$;
drop trigger if exists trg_due_date_default on sales_orders;
create trigger trg_due_date_default before insert on sales_orders
  for each row execute function public.set_due_date_default();
drop trigger if exists trg_due_date_default on purchase_orders;
create trigger trg_due_date_default before insert on purchase_orders
  for each row execute function public.set_due_date_default();

-- Existing invoices and bills: due the day they were made.
update sales_orders    set due_date = transaction_date where due_date is null;
update purchase_orders set due_date = purchase_date    where due_date is null;

create or replace function public.set_due_date(p_kind text, p_id uuid, p_due date)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_old    date;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_due is null then raise exception 'Pick a due date.'; end if;
  if p_kind = 'sale' then
    if not public.has_role('sales', 'accounts') then
      raise exception 'Your role can''t change when an invoice is due.' using errcode = 'insufficient_privilege';
    end if;
    select due_date into v_old from sales_orders where id = p_id and tenant_id = v_tenant;
    if not found then raise exception 'Invoice not found.'; end if;
    update sales_orders set due_date = p_due where id = p_id;
    perform public.log_audit('due_date', 'sales_orders', p_id::text, jsonb_build_object('old', v_old, 'new', p_due));
  elsif p_kind = 'purchase' then
    if not public.has_role('inventory', 'accounts') then
      raise exception 'Your role can''t change when a bill is due.' using errcode = 'insufficient_privilege';
    end if;
    select due_date into v_old from purchase_orders where id = p_id and tenant_id = v_tenant;
    if not found then raise exception 'Bill not found.'; end if;
    update purchase_orders set due_date = p_due where id = p_id;
    perform public.log_audit('due_date', 'purchase_orders', p_id::text, jsonb_build_object('old', v_old, 'new', p_due));
  else
    raise exception 'Unknown kind.';
  end if;
end $$;
grant execute on function public.set_due_date(text, uuid, date) to authenticated;


-- ------------------------------------------------------------
-- 2. Opening debts
-- ------------------------------------------------------------
alter table sales_orders    add column if not exists opening_amount numeric(14,2) not null default 0;
alter table purchase_orders add column if not exists opening_amount numeric(14,2) not null default 0;

-- An opening debt is not a sale this month, so the Free plan's monthly
-- sales count leaves it out.
create or replace function public.guard_free_sales_limit()
returns trigger language plpgsql set search_path = public as $$
declare
  v_limit int := public.plan_monthly_sales_limit(public.effective_plan(NEW.tenant_id));
  v_used  int;
begin
  if NEW.opening_amount > 0 then return NEW; end if;
  if v_limit is not null then
    select count(*) into v_used from sales_orders
     where tenant_id = NEW.tenant_id and created_at >= date_trunc('month', now()) and opening_amount = 0;
    if v_used >= v_limit then
      raise exception 'The Free plan allows % sales a month and this month''s are used up. Upgrade to Growth under Settings → Billing to keep selling.',
        v_limit
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return NEW;
end $$;

-- Opening debts are numbered OB-000001, not as invoices or purchases.
create or replace function public.assign_doc_no()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if TG_OP = 'INSERT' then
    NEW.doc_no := public.next_doc_no(NEW.tenant_id,
      case when coalesce((to_jsonb(NEW) ->> 'opening_amount')::numeric, 0) > 0 then 'OB' else TG_ARGV[0] end);
  elsif OLD.doc_no is not null and NEW.doc_no is distinct from OLD.doc_no then
    raise exception 'A document number can''t be changed once it has been issued.';
  end if;
  return NEW;
end $$;
revoke execute on function public.assign_doc_no() from public, anon, authenticated;

create or replace function public.create_opening_debt(
  p_kind   text,      -- 'customer': they owe you; 'supplier': you owe them
  p_party  uuid,
  p_amount numeric,
  p_date   date,
  p_due    date default null,
  p_note   text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid;
  v_id     uuid;
  v_note   text := coalesce(nullif(trim(p_note), ''), 'Owed before ProfixBook');
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if public.current_role() <> 'admin' then
    raise exception 'Only the owner can add what was owed before ProfixBook.' using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero.'; end if;
  if p_date is null or p_date > public.shop_today() then raise exception 'Pick the date it was owed on (today or earlier).'; end if;
  v_branch := public.default_branch_id(v_tenant);

  if p_kind = 'customer' then
    perform public.assert_same_tenant('customers', p_party);
    insert into sales_orders (tenant_id, branch_id, customer_id, transaction_date, due_date, total_amount, amount_paid,
                              balance, opening_amount, payment_status, notes, created_by)
    values (v_tenant, v_branch, p_party, p_date, coalesce(p_due, p_date), 0, 0,
            round(p_amount, 2), round(p_amount, 2), 'unpaid', v_note, auth.uid())
    returning id into v_id;
  elsif p_kind = 'supplier' then
    perform public.assert_same_tenant('suppliers', p_party);
    insert into purchase_orders (tenant_id, branch_id, supplier_id, purchase_date, due_date, total_amount, total_paid,
                                 balance, opening_amount, payment_status, created_by, status, doc_no)
    values (v_tenant, v_branch, p_party, p_date, coalesce(p_due, p_date), 0, 0,
            round(p_amount, 2), round(p_amount, 2), 'unpaid', auth.uid(), 'received', public.next_doc_no(v_tenant, 'OB'))
    returning id into v_id;
  else
    raise exception 'Unknown kind.';
  end if;

  perform public.log_audit('opening_debt', case when p_kind = 'customer' then 'sales_orders' else 'purchase_orders' end, v_id::text,
    jsonb_build_object('kind', p_kind, 'party', p_party, 'amount', round(p_amount, 2), 'date', p_date, 'note', v_note));
  return v_id;
end $$;
grant execute on function public.create_opening_debt(text, uuid, numeric, date, date, text) to authenticated;


-- ------------------------------------------------------------
-- 3. Bad debts
-- ------------------------------------------------------------
create table if not exists debt_writeoffs (
  id             uuid primary key default gen_random_uuid(),
  tenant_id      uuid not null references tenants(id) on delete cascade,
  sales_order_id uuid not null references sales_orders(id) on delete cascade,
  amount         numeric(14,2) not null check (amount > 0),
  writeoff_date  date not null default public.shop_today(),
  reason         text,
  voided         boolean not null default false,
  voided_at      timestamptz,
  created_by     uuid references auth.users(id) default auth.uid(),
  created_at     timestamptz not null default now()
);
create index if not exists idx_debt_writeoffs_sale on debt_writeoffs (tenant_id, sales_order_id);
alter table debt_writeoffs enable row level security;
drop policy if exists debt_writeoffs_read on debt_writeoffs;
create policy debt_writeoffs_read on debt_writeoffs for select
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'sales', 'accounts'));

drop trigger if exists trg_guard_closed_period on debt_writeoffs;
create trigger trg_guard_closed_period before insert or update or delete on debt_writeoffs
  for each row execute function public.guard_closed_period('writeoff_date', 'writeoff_date,amount,voided');

create or replace function public.write_off_debt(p_sale uuid, p_amount numeric, p_reason text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_so     record;
  v_id     uuid;
  v_bal    numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if public.current_role() <> 'admin' then
    raise exception 'Only the owner can write off a debt.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_so from sales_orders where id = p_sale and tenant_id = v_tenant for update;
  if not found then raise exception 'Invoice not found.'; end if;
  if v_so.voided then raise exception 'This invoice is voided.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero.'; end if;
  if p_amount > v_so.balance + 0.005 then
    raise exception 'Only ₦% is still owed on this invoice.', v_so.balance;
  end if;

  insert into debt_writeoffs (tenant_id, sales_order_id, amount, reason)
  values (v_tenant, p_sale, round(p_amount, 2), nullif(trim(p_reason), ''))
  returning id into v_id;

  v_bal := greatest(0, v_so.balance - round(p_amount, 2));
  update sales_orders
     set balance = v_bal,
         payment_status = case when v_bal <= 0.005 then 'full'::pay_status
                               when v_so.amount_paid <= 0 then 'unpaid'::pay_status else 'part'::pay_status end
   where id = p_sale;

  perform public.log_audit('debt_written_off', 'sales_orders', p_sale::text,
    jsonb_build_object('amount', round(p_amount, 2), 'reason', p_reason, 'writeoff_id', v_id));
  return v_id;
end $$;
grant execute on function public.write_off_debt(uuid, numeric, text) to authenticated;

create or replace function public.void_debt_writeoff(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_w      record;
  v_so     record;
  v_bal    numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if public.current_role() <> 'admin' then
    raise exception 'Only the owner can undo a write-off.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_w from debt_writeoffs where id = p_id and tenant_id = v_tenant for update;
  if not found then raise exception 'Write-off not found.'; end if;
  if v_w.voided then raise exception 'This write-off was already undone.'; end if;
  select * into v_so from sales_orders where id = v_w.sales_order_id for update;

  update debt_writeoffs set voided = true, voided_at = now() where id = p_id;
  v_bal := v_so.balance + v_w.amount;
  update sales_orders
     set balance = v_bal,
         payment_status = case when v_bal <= 0.005 then 'full'::pay_status
                               when v_so.amount_paid <= 0 then 'unpaid'::pay_status else 'part'::pay_status end
   where id = v_w.sales_order_id;
  perform public.log_audit('debt_writeoff_undone', 'sales_orders', v_w.sales_order_id::text,
    jsonb_build_object('amount', v_w.amount, 'writeoff_id', p_id));
end $$;
grant execute on function public.void_debt_writeoff(uuid) to authenticated;

-- Bad debts reach the P&L through report_extras().
create or replace function public.report_extras(p_from date default null, p_to date default null, p_branch uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('accounts') then
    raise exception 'Only the owner or accounts can see this.' using errcode = 'insufficient_privilege';
  end if;

  return jsonb_build_object(
    'stock_loss', coalesce((
      select round(sum(total_cost), 2) from stock_adjustments
       where tenant_id = v_tenant and qty_delta < 0
         and (p_branch is null or branch_id = p_branch)
         and (p_from is null or (created_at at time zone 'Africa/Lagos')::date >= p_from)
         and (p_to   is null or (created_at at time zone 'Africa/Lagos')::date <= p_to)), 0),
    'stock_loss_count', (
      select count(*) from stock_adjustments
       where tenant_id = v_tenant and qty_delta < 0
         and (p_branch is null or branch_id = p_branch)
         and (p_from is null or (created_at at time zone 'Africa/Lagos')::date >= p_from)
         and (p_to   is null or (created_at at time zone 'Africa/Lagos')::date <= p_to)),
    'till_short', coalesce((
      select sum(-variance) from shifts
       where tenant_id = v_tenant and status = 'closed' and variance < 0
         and (p_branch is null or branch_id = p_branch)
         and (p_from is null or (closed_at at time zone 'Africa/Lagos')::date >= p_from)
         and (p_to   is null or (closed_at at time zone 'Africa/Lagos')::date <= p_to)), 0),
    'till_over', coalesce((
      select sum(variance) from shifts
       where tenant_id = v_tenant and status = 'closed' and variance > 0
         and (p_branch is null or branch_id = p_branch)
         and (p_from is null or (closed_at at time zone 'Africa/Lagos')::date >= p_from)
         and (p_to   is null or (closed_at at time zone 'Africa/Lagos')::date <= p_to)), 0),
    'bad_debts', coalesce((
      select sum(w.amount) from debt_writeoffs w join sales_orders so on so.id = w.sales_order_id
       where w.tenant_id = v_tenant and not w.voided and not so.voided
         and (p_branch is null or so.branch_id = p_branch)
         and (p_from is null or w.writeoff_date >= p_from)
         and (p_to   is null or w.writeoff_date <= p_to)), 0),
    'store_credit_owed', coalesce((
      select sum(credit_balance) from customers where tenant_id = v_tenant and credit_balance > 0), 0),
    'store_credit_customers', (
      select count(*) from customers where tenant_id = v_tenant and credit_balance > 0)
  );
end $$;
grant execute on function public.report_extras(date, date, uuid) to authenticated;


-- ------------------------------------------------------------
-- 4. Customer statement
-- ------------------------------------------------------------
-- Everything that changed what the customer owes, oldest first, with a
-- running balance. The balance at the end equals the unpaid balances of
-- their invoices on that day.
create or replace function public.customer_statement(p_customer uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_to     date := coalesce(p_to, public.shop_today());
  v_out    jsonb;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('sales', 'accounts') then
    raise exception 'Your role can''t see customer statements.' using errcode = 'insufficient_privilege';
  end if;
  perform public.assert_same_tenant('customers', p_customer);

  with so as (
    select * from sales_orders
     where tenant_id = v_tenant and customer_id = p_customer and not voided
  ), ev as (
    select transaction_date as d, 1 as ord, created_at as at, doc_no as ref,
           case when opening_amount > 0 then 'Owed before ProfixBook' else 'Invoice' end as what,
           total_amount + opening_amount as amount
      from so
    union all
    select sr.return_date, 2, sr.created_at, so.doc_no, 'Goods returned', -sr.total
      from sale_returns sr join so on so.id = sr.sales_order_id where not sr.voided
    union all
    select sr.return_date, 2, sr.created_at, so.doc_no, 'Return kept as store credit', sr.to_store_credit
      from sale_returns sr join so on so.id = sr.sales_order_id where not sr.voided and sr.to_store_credit > 0
    union all
    select sp.payment_date, 3, sp.created_at, so.doc_no,
           case when sp.reference = 'STORE_CREDIT' then 'Paid from store credit'
                when sp.amount_paid < 0 then 'Refund paid to them'
                else 'Payment received' end,
           -sp.amount_paid
      from sale_payments sp join so on so.id = sp.sales_order_id
    union all
    select w.writeoff_date, 4, w.created_at, so.doc_no, 'Written off', -w.amount
      from debt_writeoffs w join so on so.id = w.sales_order_id where not w.voided
  ), upto as (
    select * from ev where d <= v_to and amount <> 0
  ), opening as (
    select coalesce(sum(amount), 0) as v from upto where p_from is not null and d < p_from
  ), shown as (
    select u.*, (select v from opening) + sum(u.amount) over (order by u.d, u.ord, u.at rows unbounded preceding) as running
      from upto u where p_from is null or u.d >= p_from
  )
  select jsonb_build_object(
    'from', p_from, 'to', v_to,
    'opening', (select v from opening),
    'closing', (select coalesce(sum(amount), 0) from upto),
    'lines', coalesce((select jsonb_agg(jsonb_build_object('date', d, 'ref', ref, 'what', what, 'amount', amount, 'balance', running)
                                        order by d, ord, at) from shown), '[]'::jsonb)
  ) into v_out;
  return v_out;
end $$;
grant execute on function public.customer_statement(uuid, date, date) to authenticated;


-- ------------------------------------------------------------
-- 5. Repeat expenses
-- ------------------------------------------------------------
create table if not exists recurring_expenses (
  id               uuid primary key default gen_random_uuid(),
  tenant_id        uuid not null default public.current_tenant_id() references tenants(id) on delete cascade,
  branch_id        uuid references branches(id) on delete set null,
  expense_type_id  uuid references expense_types(id) on delete set null,
  description      text not null check (length(trim(description)) > 0),
  amount           numeric(14,2) not null check (amount > 0),
  payment_type_id  uuid references payment_types(id) on delete set null,
  money_account_id uuid references money_accounts(id) on delete set null,
  frequency        text not null check (frequency in ('monthly', 'weekly')),
  anchor_day       int,            -- monthly: the day of the month it falls on
  next_date        date not null,
  is_active        boolean not null default true,
  created_by       uuid references auth.users(id) default auth.uid(),
  created_at       timestamptz not null default now()
);
alter table recurring_expenses enable row level security;
drop policy if exists recurring_expenses_all on recurring_expenses;
create policy recurring_expenses_all on recurring_expenses for all
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live())
  with check (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live());

drop trigger if exists trg_audit_row_change on recurring_expenses;
create trigger trg_audit_row_change after insert or update or delete on recurring_expenses
  for each row execute function public.audit_row_change('description,amount,frequency,next_date,is_active,expense_type_id', 'tenant_id');

create or replace function public.recurring_next(p_date date, p_frequency text, p_anchor int)
returns date language sql immutable as $$
  select case
    when p_frequency = 'weekly' then p_date + 7
    else (date_trunc('month', p_date) + interval '1 month')::date
         + (least(coalesce(p_anchor, extract(day from p_date)::int),
                  extract(day from (date_trunc('month', p_date) + interval '2 month' - interval '1 day'))::int) - 1)
  end
$$;

create or replace function public.guard_recurring_expense()
returns trigger language plpgsql as $$
begin
  if NEW.frequency = 'monthly' and NEW.anchor_day is null then
    NEW.anchor_day := extract(day from NEW.next_date)::int;
  end if;
  return NEW;
end $$;
drop trigger if exists trg_guard_recurring_expense on recurring_expenses;
create trigger trg_guard_recurring_expense before insert or update on recurring_expenses
  for each row execute function public.guard_recurring_expense();

-- Makes every expense that has come due, once each. Returns how many.
create or replace function public.run_recurring_expenses()
returns int language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_today  date := public.shop_today();
  v_lock   date;
  r        record;
  v_n      int := 0;
  v_guard  int;
  v_new    uuid;
begin
  if v_tenant is null then return 0; end if;
  if not public.has_role('accounts') or not public.tenant_is_live() then return 0; end if;
  select books_closed_until into v_lock from tenants where id = v_tenant;

  for r in select * from recurring_expenses
            where tenant_id = v_tenant and is_active and next_date <= v_today
            for update loop
    v_guard := 0;
    while r.next_date <= v_today and v_guard < 400 loop
      if v_lock is null or r.next_date > v_lock then
        insert into expenses (tenant_id, branch_id, expense_date, expense_type_id, description, amount,
                              payment_type_id, money_account_id, created_by, source, source_ref)
        values (v_tenant, r.branch_id, r.next_date, r.expense_type_id, r.description, r.amount,
                r.payment_type_id, r.money_account_id, r.created_by, 'recurring', r.id::text || ':' || r.next_date::text)
        on conflict (tenant_id, source, source_ref) where source is not null do nothing
        returning id into v_new;
        if v_new is not null then v_n := v_n + 1; end if;
      end if;
      r.next_date := public.recurring_next(r.next_date, r.frequency, r.anchor_day);
      v_guard := v_guard + 1;
    end loop;
    update recurring_expenses set next_date = r.next_date where id = r.id;
  end loop;
  return v_n;
end $$;
grant execute on function public.run_recurring_expenses() to authenticated;
