-- ============================================================
-- ProfixBook: bank reconciliation and balance sheet (accounting audit 2.4, 2.10)
--
-- 1. VAT paid to the tax office: a new kind of money entry. Money leaves
--    an account but it is not a cost (the VAT was never the shop's money),
--    so it lowers "VAT owed" on the balance sheet instead of profit.
--
-- 2. Bank reconciliation. The owner uploads a bank or wallet statement
--    (CSV, read in the browser) for one money account. Each statement line
--    is matched to a movement already in ProfixBook (same account, same
--    amount, within 3 days). What is left over is shown on both sides:
--      * on the statement but not in ProfixBook: a bank charge, a payment
--        nobody recorded. The owner can add it (as an expense, owner money,
--        a loan, other income, VAT paid) or skip it.
--      * in ProfixBook but not on the statement: a payment recorded that
--        never arrived. That is the one to chase.
--    A match points at the source record (table + id), not at a ledger
--    row, so it survives the ledger being rebuilt.
--
-- 3. Balance sheet: what the business owns (cash and bank, stock at cost,
--    what customers owe, VAT to claim back), what it owes (suppliers,
--    VAT, store credit, loans), and the difference (the owner's share).
--
-- Run AFTER 0001-0062.
-- ============================================================

-- ------------------------------------------------------------
-- 1. VAT paid
-- ------------------------------------------------------------
alter table money_entries drop constraint if exists money_entries_kind_check;
alter table money_entries add constraint money_entries_kind_check
  check (kind in ('transfer', 'owner_in', 'owner_out', 'loan_in', 'loan_repay', 'other_in', 'vat_paid'));

-- Full definitions (from 0061) rather than a text patch, so this works
-- however the live copies were saved.
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
  if NEW.kind in ('owner_out', 'loan_repay', 'vat_paid') then
    if NEW.from_account is null then raise exception 'Pick the account the money came out of.'; end if;
    NEW.to_account := null;
  end if;
  if exists (select 1 from money_accounts where id in (NEW.from_account, NEW.to_account) and tenant_id <> NEW.tenant_id) then
    raise exception 'That account does not belong to this company.';
  end if;
  return NEW;
end $$;

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
      when 'vat_paid'   then 'VAT paid to the tax office'
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


-- ------------------------------------------------------------
-- 2. Statements and their lines
-- ------------------------------------------------------------
create table if not exists bank_statements (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null default public.current_tenant_id() references tenants(id) on delete cascade,
  account_id      uuid not null references money_accounts(id) on delete cascade,
  file_name       text,
  period_from     date not null,
  period_to       date not null,
  closing_balance numeric(14,2),                 -- the statement's own closing balance, when the file has one
  status          text not null default 'open' check (status in ('open', 'done')),
  created_by      uuid references auth.users(id) default auth.uid(),
  created_at      timestamptz not null default now(),
  finished_at     timestamptz,
  finished_by     uuid references auth.users(id)
);
create index if not exists idx_bank_statements_account on bank_statements (tenant_id, account_id, period_to);

create table if not exists bank_statement_lines (
  id           uuid primary key default gen_random_uuid(),
  tenant_id    uuid not null references tenants(id) on delete cascade,
  statement_id uuid not null references bank_statements(id) on delete cascade,
  account_id   uuid not null references money_accounts(id) on delete cascade,
  line_no      int not null,
  line_date    date not null,
  description  text,
  reference    text,
  amount       numeric(14,2) not null check (amount <> 0),   -- + money in, - money out
  balance      numeric(14,2),
  status       text not null default 'open' check (status in ('open', 'matched', 'ignored')),
  match_table  text,
  match_id     uuid,
  matched_how  text check (matched_how in ('auto', 'manual', 'added')),
  constraint bank_line_match_shape check ((status = 'matched') = (match_id is not null and match_table is not null))
);
create index if not exists idx_bank_lines_statement on bank_statement_lines (statement_id, line_date, line_no);
-- One movement can only be matched to one statement line.
create unique index if not exists uq_bank_lines_match
  on bank_statement_lines (account_id, match_table, match_id) where match_id is not null;

alter table bank_statements      enable row level security;
alter table bank_statement_lines enable row level security;
drop policy if exists bank_statements_read on bank_statements;
create policy bank_statements_read on bank_statements for select
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts'));
drop policy if exists bank_statement_lines_read on bank_statement_lines;
create policy bank_statement_lines_read on bank_statement_lines for select
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts'));
-- Writes only go through the functions below.


-- ------------------------------------------------------------
-- 3. Helpers
-- ------------------------------------------------------------
create or replace function public.bank_check_access()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('accounts') then
    raise exception 'Only the owner or accounts can check bank statements.' using errcode = 'insufficient_privilege';
  end if;
  return v_tenant;
end $$;
revoke execute on function public.bank_check_access() from public, anon, authenticated;

-- An open statement line of this business, locked for change.
create or replace function public.bank_open_line(p_line uuid)
returns bank_statement_lines language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.bank_check_access();
  v_line   bank_statement_lines;
begin
  if not public.tenant_is_live() then raise exception 'Your account is read-only right now.'; end if;
  select l.* into v_line from bank_statement_lines l
   where l.id = p_line and l.tenant_id = v_tenant for update;
  if not found then raise exception 'Statement line not found.'; end if;
  if exists (select 1 from bank_statements where id = v_line.statement_id and status = 'done') then
    raise exception 'This statement is finished. Reopen it to change it.';
  end if;
  return v_line;
end $$;
revoke execute on function public.bank_open_line(uuid) from public, anon, authenticated;

-- Match every open line of a statement to the closest movement with the
-- same amount in the same account, within 3 days. Returns how many matched.
create or replace function public.bank_auto_match(p_statement uuid)
returns int language plpgsql security definer set search_path = public as $$
declare
  v_line record;
  v_hit  record;
  v_n    int := 0;
begin
  for v_line in
    select l.* from bank_statement_lines l where l.statement_id = p_statement and l.status = 'open'
     order by l.line_date, l.line_no
  loop
    select g.source_table, g.source_id into v_hit
      from money_ledger g join money_accounts a on a.id = g.account_id
     where g.account_id = v_line.account_id
       and g.category <> 'opening'
       and (a.opening_date is null or g.entry_date >= a.opening_date)
       and abs(g.amount - v_line.amount) < 0.005
       and abs(g.entry_date - v_line.line_date) <= 3
       and not exists (select 1 from bank_statement_lines m
                        where m.account_id = g.account_id and m.match_table = g.source_table and m.match_id = g.source_id)
     order by abs(g.entry_date - v_line.line_date), g.entry_date, g.id
     limit 1;
    if found then
      update bank_statement_lines
         set status = 'matched', match_table = v_hit.source_table, match_id = v_hit.source_id, matched_how = 'auto'
       where id = v_line.id;
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end $$;
revoke execute on function public.bank_auto_match(uuid) from public, anon, authenticated;


-- ------------------------------------------------------------
-- 4. Upload a statement
-- ------------------------------------------------------------
-- p_lines: [{date, description, reference, amount, balance}], amount + in, - out.
-- Lines already in an earlier statement for this account (same date,
-- amount and description) are skipped, so overlapping files are safe.
create or replace function public.bank_import_statement(
  p_account uuid, p_file text, p_lines jsonb, p_closing numeric default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant  uuid := public.bank_check_access();
  v_id      uuid;
  v_total   int;
  v_added   int;
  v_matched int;
begin
  if not public.tenant_is_live() then raise exception 'Your account is read-only right now.'; end if;
  if not exists (select 1 from money_accounts where id = p_account and tenant_id = v_tenant) then
    raise exception 'Pick one of your accounts.';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'The file has no lines with a date and an amount.';
  end if;
  v_total := jsonb_array_length(p_lines);
  if v_total > 5000 then raise exception 'That file is too long. Upload at most 5,000 lines at a time.'; end if;

  create temp table if not exists _bank_in (
    line_no int, line_date date, description text, reference text, amount numeric(14,2), balance numeric(14,2)
  ) on commit drop;
  delete from _bank_in;
  begin
    insert into _bank_in
    select x.ord::int,
           (x.v->>'date')::date,
           nullif(trim(x.v->>'description'), ''),
           nullif(trim(x.v->>'reference'), ''),
           round((x.v->>'amount')::numeric, 2),
           round(nullif(x.v->>'balance', '')::numeric, 2)
      from jsonb_array_elements(p_lines) with ordinality as x(v, ord);
  exception when others then
    raise exception 'Some lines have a date or amount that could not be read.';
  end;
  delete from _bank_in where amount is null or amount = 0 or line_date is null;
  if not exists (select 1 from _bank_in) then raise exception 'The file has no lines with a date and an amount.'; end if;
  if exists (select 1 from _bank_in where line_date > public.shop_today() + 1) then
    raise exception 'Some lines are dated in the future. Check the date column.';
  end if;

  -- Already uploaded before.
  delete from _bank_in b
   where exists (select 1 from bank_statement_lines l
                  where l.account_id = p_account and l.line_date = b.line_date and l.amount = b.amount
                    and coalesce(l.description, '') = coalesce(b.description, ''));
  select count(*) into v_added from _bank_in;
  if v_added = 0 then raise exception 'Every line in this file was uploaded before.'; end if;

  insert into bank_statements (tenant_id, account_id, file_name, period_from, period_to, closing_balance)
  select v_tenant, p_account, nullif(trim(p_file), ''), min(line_date), max(line_date), round(p_closing, 2) from _bank_in
  returning id into v_id;

  insert into bank_statement_lines (tenant_id, statement_id, account_id, line_no, line_date, description, reference, amount, balance)
  select v_tenant, v_id, p_account, line_no, line_date, description, reference, amount, balance from _bank_in;

  v_matched := public.bank_auto_match(v_id);
  perform public.log_audit('bank_statement_uploaded', 'bank_statements', v_id::text,
    jsonb_build_object('account', p_account, 'lines', v_added, 'skipped', v_total - v_added, 'matched', v_matched));
  return jsonb_build_object('id', v_id, 'lines', v_added, 'skipped', v_total - v_added, 'matched', v_matched);
end $$;
grant execute on function public.bank_import_statement(uuid, text, jsonb, numeric) to authenticated;


-- ------------------------------------------------------------
-- 5. Looking at a statement
-- ------------------------------------------------------------
create or replace function public.bank_statements_list()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := public.bank_check_access();
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', s.id, 'account_id', s.account_id, 'account_name', a.name, 'file_name', s.file_name,
      'period_from', s.period_from, 'period_to', s.period_to, 'status', s.status,
      'created_at', s.created_at, 'finished_at', s.finished_at,
      'lines', (select count(*) from bank_statement_lines l where l.statement_id = s.id),
      'open',  (select count(*) from bank_statement_lines l where l.statement_id = s.id and l.status = 'open'))
      order by s.period_to desc, s.created_at desc)
      from bank_statements s join money_accounts a on a.id = s.account_id
     where s.tenant_id = v_tenant), '[]'::jsonb);
end $$;
grant execute on function public.bank_statements_list() to authenticated;

-- Everything the matching screen needs: the lines with what each is matched
-- to, the movements in ProfixBook for the period that nothing on the
-- statement matched, and the balances side by side.
create or replace function public.bank_statement_view(p_statement uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.bank_check_access();
  v_s      bank_statements;
  v_acc    money_accounts;
  v_book   numeric;
begin
  select * into v_s from bank_statements where id = p_statement and tenant_id = v_tenant;
  if not found then raise exception 'Statement not found.'; end if;
  select * into v_acc from money_accounts where id = v_s.account_id;

  select coalesce(sum(g.amount), 0) into v_book from money_ledger g
   where g.account_id = v_acc.id and g.entry_date <= v_s.period_to
     and (v_acc.opening_date is null or g.entry_date >= v_acc.opening_date);

  return jsonb_build_object(
    'id', v_s.id, 'status', v_s.status, 'file_name', v_s.file_name,
    'period_from', v_s.period_from, 'period_to', v_s.period_to,
    'account', jsonb_build_object('id', v_acc.id, 'name', v_acc.name, 'kind', v_acc.kind,
                                  'bank_name', v_acc.bank_name, 'account_number', v_acc.account_number),
    'statement_closing', v_s.closing_balance,
    'book_closing', v_book,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'date', l.line_date, 'description', l.description, 'reference', l.reference,
        'amount', l.amount, 'balance', l.balance,
        -- A match whose movement has since gone (voided, moved to another account) counts as open.
        'status', case when l.status = 'matched' and g.id is null then 'open' else l.status end,
        'matched_how', case when g.id is null then null else l.matched_how end,
        'match', case when g.id is null then null else jsonb_build_object(
          'table', g.source_table, 'id', g.source_id, 'date', g.entry_date, 'amount', g.amount,
          'category', g.category, 'description', g.description) end)
        order by l.line_date, l.line_no)
        from bank_statement_lines l
        left join lateral (
          select g.* from money_ledger g
           where l.status = 'matched' and g.account_id = l.account_id
             and g.source_table = l.match_table and g.source_id = l.match_id
           limit 1) g on true
       where l.statement_id = v_s.id), '[]'::jsonb),
    'missing', coalesce((
      select jsonb_agg(jsonb_build_object(
        'table', g.source_table, 'id', g.source_id, 'date', g.entry_date, 'amount', g.amount,
        'category', g.category, 'description', g.description)
        order by g.entry_date, g.id)
        from money_ledger g
       where g.account_id = v_acc.id and g.category <> 'opening'
         and g.entry_date between v_s.period_from and v_s.period_to
         and (v_acc.opening_date is null or g.entry_date >= v_acc.opening_date)
         and not exists (select 1 from bank_statement_lines m
                          where m.account_id = g.account_id and m.match_table = g.source_table
                            and m.match_id = g.source_id and m.status = 'matched')), '[]'::jsonb)
  );
end $$;
grant execute on function public.bank_statement_view(uuid) to authenticated;

-- Movements a line could be matched to by hand: same direction, not matched
-- yet, within a month, closest amount first.
create or replace function public.bank_candidates(p_line uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.bank_check_access();
  v_line   bank_statement_lines;
begin
  select * into v_line from bank_statement_lines where id = p_line and tenant_id = v_tenant;
  if not found then raise exception 'Statement line not found.'; end if;
  return coalesce((
    select jsonb_agg(c order by c_rank)
      from (
        select jsonb_build_object('table', g.source_table, 'id', g.source_id, 'date', g.entry_date,
                                  'amount', g.amount, 'category', g.category, 'description', g.description) as c,
               row_number() over (order by abs(g.amount - v_line.amount), abs(g.entry_date - v_line.line_date), g.id) as c_rank
          from money_ledger g join money_accounts a on a.id = g.account_id
         where g.account_id = v_line.account_id and g.category <> 'opening'
           and sign(g.amount) = sign(v_line.amount)
           and abs(g.entry_date - v_line.line_date) <= 31
           and (a.opening_date is null or g.entry_date >= a.opening_date)
           and not exists (select 1 from bank_statement_lines m
                            where m.account_id = g.account_id and m.match_table = g.source_table
                              and m.match_id = g.source_id and m.status = 'matched' and m.id <> v_line.id)
         order by 2 limit 20) x), '[]'::jsonb);
end $$;
grant execute on function public.bank_candidates(uuid) to authenticated;


-- ------------------------------------------------------------
-- 6. Changing lines
-- ------------------------------------------------------------
create or replace function public.bank_match_line(p_line uuid, p_table text, p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_line bank_statement_lines := public.bank_open_line(p_line);
begin
  if not exists (select 1 from money_ledger where account_id = v_line.account_id and source_table = p_table and source_id = p_id) then
    raise exception 'That movement is not in this account.';
  end if;
  if exists (select 1 from bank_statement_lines where account_id = v_line.account_id and match_table = p_table
               and match_id = p_id and id <> p_line) then
    raise exception 'That movement is already matched to another statement line.';
  end if;
  update bank_statement_lines
     set status = 'matched', match_table = p_table, match_id = p_id, matched_how = 'manual'
   where id = p_line;
end $$;
grant execute on function public.bank_match_line(uuid, text, uuid) to authenticated;

create or replace function public.bank_unmatch_line(p_line uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_line bank_statement_lines := public.bank_open_line(p_line);
begin
  update bank_statement_lines set status = 'open', match_table = null, match_id = null, matched_how = null where id = v_line.id;
end $$;
grant execute on function public.bank_unmatch_line(uuid) to authenticated;

create or replace function public.bank_ignore_line(p_line uuid, p_ignore boolean default true)
returns void language plpgsql security definer set search_path = public as $$
declare v_line bank_statement_lines := public.bank_open_line(p_line);
begin
  update bank_statement_lines
     set status = case when p_ignore then 'ignored' else 'open' end,
         match_table = null, match_id = null, matched_how = null
   where id = v_line.id;
end $$;
grant execute on function public.bank_ignore_line(uuid, boolean) to authenticated;

-- Record what a statement line is (when nobody put it in ProfixBook) and
-- match it. Money out: an expense, owner taking money, a loan repayment or
-- VAT paid. Money in: owner money, a loan, or other income.
create or replace function public.bank_add_from_line(
  p_line uuid, p_kind text, p_expense_type uuid default null, p_note text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_line  bank_statement_lines := public.bank_open_line(p_line);
  v_acc   money_accounts;
  v_id    uuid;
  v_table text;
  v_note  text := coalesce(nullif(trim(p_note), ''), v_line.description, 'From the bank statement');
begin
  select * into v_acc from money_accounts where id = v_line.account_id;
  if v_line.status = 'matched' then raise exception 'This line is already matched.'; end if;

  if p_kind = 'expense' then
    if v_line.amount > 0 then raise exception 'Money that came in can''t be an expense.'; end if;
    if p_expense_type is not null and not exists (
      select 1 from expense_types where id = p_expense_type and tenant_id = v_line.tenant_id) then
      raise exception 'Pick one of your expense types.';
    end if;
    insert into expenses (tenant_id, branch_id, expense_date, expense_type_id, description, amount,
                          money_account_id, created_by, source, source_ref)
    values (v_line.tenant_id, v_acc.branch_id, v_line.line_date, p_expense_type, left(v_note, 300), -v_line.amount,
            v_acc.id, auth.uid(), 'bank_statement', v_line.id::text)
    returning id into v_id;
    v_table := 'expenses';
  elsif p_kind in ('owner_in', 'loan_in', 'other_in') then
    if v_line.amount < 0 then raise exception 'That is for money coming in.'; end if;
    insert into money_entries (tenant_id, kind, to_account, amount, entry_date, note)
    values (v_line.tenant_id, p_kind, v_acc.id, v_line.amount, v_line.line_date, left(v_note, 300))
    returning id into v_id;
    v_table := 'money_entries';
  elsif p_kind in ('owner_out', 'loan_repay', 'vat_paid') then
    if v_line.amount > 0 then raise exception 'That is for money going out.'; end if;
    insert into money_entries (tenant_id, kind, from_account, amount, entry_date, note)
    values (v_line.tenant_id, p_kind, v_acc.id, -v_line.amount, v_line.line_date, left(v_note, 300))
    returning id into v_id;
    v_table := 'money_entries';
  else
    raise exception 'Pick what this money was.';
  end if;

  update bank_statement_lines
     set status = 'matched', match_table = v_table, match_id = v_id, matched_how = 'added'
   where id = v_line.id;
end $$;
grant execute on function public.bank_add_from_line(uuid, text, uuid, text) to authenticated;


-- ------------------------------------------------------------
-- 7. Finishing, reopening, removing
-- ------------------------------------------------------------
create or replace function public.bank_finish_statement(p_statement uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.bank_check_access();
  v_open   int;
begin
  if not exists (select 1 from bank_statements where id = p_statement and tenant_id = v_tenant and status = 'open') then
    raise exception 'Statement not found, or already finished.';
  end if;
  -- Re-check matches whose movement has gone since.
  update bank_statement_lines l
     set status = 'open', match_table = null, match_id = null, matched_how = null
   where l.statement_id = p_statement and l.status = 'matched'
     and not exists (select 1 from money_ledger g where g.account_id = l.account_id
                       and g.source_table = l.match_table and g.source_id = l.match_id);
  select count(*) into v_open from bank_statement_lines where statement_id = p_statement and status = 'open';
  if v_open > 0 then
    raise exception 'Match, add or skip every line first. % still to do.', v_open;
  end if;
  update bank_statements set status = 'done', finished_at = now(), finished_by = auth.uid() where id = p_statement;
  perform public.log_audit('bank_statement_finished', 'bank_statements', p_statement::text, '{}'::jsonb);
end $$;
grant execute on function public.bank_finish_statement(uuid) to authenticated;

create or replace function public.bank_reopen_statement(p_statement uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.bank_check_access();
begin
  if public.current_role() <> 'admin' then
    raise exception 'Only the owner can reopen a finished statement.' using errcode = 'insufficient_privilege';
  end if;
  update bank_statements set status = 'open', finished_at = null, finished_by = null
   where id = p_statement and tenant_id = v_tenant and status = 'done';
  if not found then raise exception 'Statement not found, or not finished.'; end if;
  perform public.log_audit('bank_statement_reopened', 'bank_statements', p_statement::text, '{}'::jsonb);
end $$;
grant execute on function public.bank_reopen_statement(uuid) to authenticated;

-- Removes the upload only. Anything added from its lines stays recorded.
create or replace function public.bank_delete_statement(p_statement uuid)
returns void language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.bank_check_access();
begin
  if exists (select 1 from bank_statements where id = p_statement and tenant_id = v_tenant and status = 'done') then
    raise exception 'A finished statement can''t be removed.';
  end if;
  delete from bank_statements where id = p_statement and tenant_id = v_tenant;
  if not found then raise exception 'Statement not found.'; end if;
  perform public.log_audit('bank_statement_removed', 'bank_statements', p_statement::text, '{}'::jsonb);
end $$;
grant execute on function public.bank_delete_statement(uuid) to authenticated;


-- ------------------------------------------------------------
-- 8. Balance sheet (right now)
-- ------------------------------------------------------------
create or replace function public.report_balance_sheet()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_today     date := public.shop_today();
  v_cash      jsonb;
  v_cash_tot  numeric;
  v_stock     numeric;
  v_debtors   numeric;
  v_debt_n    int;
  v_creditors numeric;
  v_cred_n    int;
  v_vat_out   numeric;
  v_vat_in    numeric;
  v_vat_paid  numeric;
  v_credit    numeric;
  v_loans     numeric;
  v_owner_in  numeric;
  v_owner_out numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('accounts') then
    raise exception 'Only the owner or accounts can see this.' using errcode = 'insufficient_privilege';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'name', name, 'kind', kind, 'balance', bal, 'checked_to', checked_to)
                  order by case kind when 'cash' then 0 when 'bank' then 1 else 2 end, name), '[]'::jsonb),
         coalesce(sum(bal), 0)
    into v_cash, v_cash_tot
    from (
      select a.id, a.name, a.kind,
             coalesce((select sum(g.amount) from money_ledger g
                        where g.account_id = a.id and g.entry_date <= v_today
                          and (a.opening_date is null or g.entry_date >= a.opening_date)), 0) as bal,
             (select max(s.period_to) from bank_statements s where s.account_id = a.id and s.status = 'done') as checked_to
        from money_accounts a
       where a.tenant_id = v_tenant
         and (a.is_active or exists (select 1 from money_ledger g where g.account_id = a.id))
    ) x
   where bal <> 0 or kind <> 'wallet' or checked_to is not null;

  select coalesce(sum(fb.qty_remaining * fb.unit_cost), 0) into v_stock
    from fg_batches fb where fb.tenant_id = v_tenant and fb.qty_remaining > 0;
  v_stock := v_stock + coalesce((select sum(pi.qty_remaining * pi.cost_price) from purchase_items pi
                                  where pi.tenant_id = v_tenant and pi.qty_remaining > 0 and pi.material_id is not null), 0);

  select coalesce(sum(balance), 0), count(distinct coalesce(customer_id::text, id::text)) into v_debtors, v_debt_n
    from sales_orders where tenant_id = v_tenant and not voided and balance > 0.005;
  select coalesce(sum(balance), 0), count(distinct coalesce(supplier_id::text, id::text)) into v_creditors, v_cred_n
    from purchase_orders where tenant_id = v_tenant and not voided and balance > 0.005;

  v_vat_out := coalesce((select sum(vat_amount) from sales_orders where tenant_id = v_tenant and not voided), 0)
             - coalesce((select sum(vat_amount) from sale_returns where tenant_id = v_tenant and not voided), 0);
  v_vat_in  := coalesce((select sum(vat_amount) from purchase_orders where tenant_id = v_tenant and not voided), 0)
             + coalesce((select sum(vat_amount) from expenses where tenant_id = v_tenant and not voided), 0);
  v_vat_paid := coalesce((select sum(amount) from money_entries where tenant_id = v_tenant and not voided and kind = 'vat_paid'), 0);

  v_credit := coalesce((select sum(credit_balance) from customers where tenant_id = v_tenant and credit_balance > 0), 0);

  v_loans := greatest(0,
      coalesce((select sum(amount) from money_entries where tenant_id = v_tenant and not voided and kind = 'loan_in'), 0)
    - coalesce((select sum(amount) from money_entries where tenant_id = v_tenant and not voided and kind = 'loan_repay'), 0));
  v_owner_in  := coalesce((select sum(amount) from money_entries where tenant_id = v_tenant and not voided and kind = 'owner_in'), 0);
  v_owner_out := coalesce((select sum(amount) from money_entries where tenant_id = v_tenant and not voided and kind = 'owner_out'), 0);

  return jsonb_build_object(
    'as_of', v_today,
    'accounts', v_cash,
    'cash_total', round(v_cash_tot, 2),
    'stock', round(v_stock, 2),
    'debtors', round(v_debtors, 2), 'debtor_count', v_debt_n,
    'creditors', round(v_creditors, 2), 'creditor_count', v_cred_n,
    'vat_charged', round(v_vat_out, 2), 'vat_claimable', round(v_vat_in, 2), 'vat_paid', round(v_vat_paid, 2),
    'vat_net', round(v_vat_out - v_vat_in - v_vat_paid, 2),       -- + owed to the tax office, - to claim back
    'store_credit', round(v_credit, 2),
    'loans', round(v_loans, 2),
    'owner_in', round(v_owner_in, 2), 'owner_out', round(v_owner_out, 2)
  );
end $$;
grant execute on function public.report_balance_sheet() to authenticated;
