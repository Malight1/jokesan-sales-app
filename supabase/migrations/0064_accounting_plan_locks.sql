-- ============================================================
-- ProfixBook: plan locks for the accounting features (0060-0063)
--
-- Growth  ('debt_tools'): due dates you change by hand, customer
--          statements, writing off bad debts, debts owed before
--          ProfixBook, repeat expenses. (Aging is worked out in the app.)
-- Business ('accounting'): Bank & Cash (accounts, money entries),
--          cash flow, balance sheet, bank statement checking, closed books.
--
-- Nothing is deleted on a lower plan. The money ledger keeps filling in
-- the background, so upgrading shows the full history. The accuracy
-- fixes (voids, VAT, payment balances) stay on every plan. A trial gets
-- everything, as before.
--
-- Functions are set in full (copied from where they were last defined,
-- with one line added) rather than patched, so this works however the
-- live copies were saved.
--
-- Run AFTER 0001-0063.
-- ============================================================

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
    when 'assistant'       then 2
    when 'debt_reminders'  then 2
    when 'auto_payments'   then 3
    when 'einvoicing'      then 3
    when 'custom_fields'   then 3
    when 'debt_tools'      then 2   -- 0064: aging, statements, write-offs, opening debts, repeats
    when 'accounting'      then 3   -- 0064: Bank & Cash, cash flow, balance sheet, reconciliation, closed books
    else 1 end
$$;

-- ---------------- Growth ----------------
create or replace function public.set_due_date(p_kind text, p_id uuid, p_due date)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_old    date;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('debt_tools', 'Changing due dates');
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
  perform public.require_feature('debt_tools', 'Adding what was owed before ProfixBook');
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

create or replace function public.write_off_debt(p_sale uuid, p_amount numeric, p_reason text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_so     record;
  v_id     uuid;
  v_bal    numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('debt_tools', 'Writing off bad debts');
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

create or replace function public.void_debt_writeoff(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_w      record;
  v_so     record;
  v_bal    numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('debt_tools', 'Undoing a write-off');
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

create or replace function public.customer_statement(p_customer uuid, p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_to     date := coalesce(p_to, public.shop_today());
  v_out    jsonb;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('debt_tools', 'Customer statements');
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
  -- Repeats pause on a plan without them; nothing is lost.
  if not public.tenant_has_feature('debt_tools') then return 0; end if;
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

drop policy if exists recurring_expenses_all on recurring_expenses;
create policy recurring_expenses_all on recurring_expenses for all
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live())
  with check (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live()
              and public.tenant_has_feature('debt_tools'));

-- ---------------- Business ----------------
create or replace function public.report_cash_flow(p_from date default null, p_to date default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_to     date := coalesce(p_to, public.shop_today());
  v_out    jsonb;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('accounting', 'The cash flow report');
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
  perform public.require_feature('accounting', 'The balance sheet');
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

create or replace function public.bank_check_access()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('accounting', 'Checking bank statements');
  if not public.has_role('accounts') then
    raise exception 'Only the owner or accounts can check bank statements.' using errcode = 'insufficient_privilege';
  end if;
  return v_tenant;
end $$;
revoke execute on function public.bank_check_access() from public, anon, authenticated;

-- Recording money and changing accounts. Reading stays open so nothing
-- disappears; the screens show an upgrade note instead.
drop policy if exists money_accounts_write on money_accounts;
create policy money_accounts_write on money_accounts for all
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live()
         and public.tenant_has_feature('accounting'))
  with check (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live()
              and public.tenant_has_feature('accounting'));
drop policy if exists money_entries_insert on money_entries;
create policy money_entries_insert on money_entries for insert
  with check (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts') and public.tenant_is_live()
              and public.tenant_has_feature('accounting'));

-- Closing the books.
create or replace function public.guard_books_closed_plan()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null
     and NEW.books_closed_until is distinct from OLD.books_closed_until
     and NEW.books_closed_until is not null
     and not public.tenant_has_feature('accounting') then
    raise exception 'Closing the books is on the Business plan and above. Upgrade under Settings → Billing.'
      using errcode = 'insufficient_privilege';
  end if;
  return NEW;
end $$;
drop trigger if exists trg_guard_books_closed_plan on tenants;
create trigger trg_guard_books_closed_plan before update of books_closed_until on tenants
  for each row execute function public.guard_books_closed_plan();
