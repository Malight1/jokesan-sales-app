-- ============================================================
-- StockFlow — Shifts and cash-up (Phase 4)
--
-- Until now cash sat in one company-wide pool. Nothing separated what
-- Amaka rang up on Tuesday morning from what Tunde rang up Tuesday
-- afternoon, so a shortfall had nowhere to surface and no one to answer
-- for it — the exact gap Moniebook and Bumpa close with a till.
--
-- After this migration:
--   • Every branch gets one or more registers ("Main till" auto-created).
--   • A cashier opens a shift on a register with a float, sells against
--     it, and closes it with a blind cash count. The server works out
--     what SHOULD be in the drawer (float + cash sales + pay-ins − pay-outs
--     − drops) and compares it to what was actually counted.
--   • Closing a shift issues a real, sequential Z number via next_doc_no
--     — the same numbering every other document in this app uses.
--   • create_sale, record_sale_payment, create_sale_return's cash refund
--     and spend_store_credit all now tag the caller's open shift, so
--     every payment method knows which till (if any) it belongs to.
--
-- Deferred out of this migration (tracked in HANDOVER.md, not silently
-- dropped): the owner dashboard's "shift short" attention card, a
-- Reports → Shifts tab, a denomination-breakdown counting UI, and a Z
-- report print layout. The engine and data these would read from are
-- both complete here — x_report()/z_report() already return everything
-- those screens need.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Schema
-- ------------------------------------------------------------

alter table payment_types add column if not exists method_group text not null default 'other'
  check (method_group in ('cash','transfer','card','store_credit','other'));

update payment_types set method_group = case
  when name ilike '%cash%' then 'cash'
  when name ilike '%transfer%' then 'transfer'
  when name ilike '%pos%' or name ilike '%card%' then 'card'
  else method_group end
where method_group = 'other';

create table if not exists registers (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  branch_id  uuid not null references branches(id) on delete cascade,
  name       text not null,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists shifts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  branch_id         uuid not null references branches(id),
  register_id       uuid not null references registers(id),
  doc_no            text,                     -- Z-000045, assigned only at close
  opened_by         uuid not null references auth.users(id),
  opened_at         timestamptz not null default now(),
  opening_float     numeric(14,2) not null,
  closed_by         uuid references auth.users(id),
  closed_at         timestamptz,
  expected          jsonb,                    -- {cash, transfer, card, ...} snapshot at close
  counted_cash      numeric(14,2),
  counted_breakdown jsonb,                    -- {"1000":42,"500":10,...}
  variance          numeric(14,2),
  notes             text,
  status            text not null default 'open' check (status in ('open','closed'))
);

create unique index if not exists one_open_shift_per_register on shifts (register_id) where status = 'open';
create unique index if not exists one_open_shift_per_user     on shifts (tenant_id, opened_by) where status = 'open';
create unique index if not exists uq_shifts_doc_no on shifts (tenant_id, doc_no) where doc_no is not null;
create index if not exists idx_shifts_branch on shifts (tenant_id, branch_id);

create table if not exists cash_movements (
  id         uuid primary key default gen_random_uuid(),
  tenant_id  uuid not null references tenants(id) on delete cascade,
  shift_id   uuid not null references shifts(id) on delete cascade,
  kind       text not null check (kind in ('pay_in','pay_out','drop')),
  amount     numeric(14,2) not null,
  reason     text not null,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists idx_cash_movements_shift on cash_movements (shift_id);

alter table sales_orders  add column if not exists shift_id uuid references shifts(id);
alter table sale_payments add column if not exists shift_id uuid references shifts(id);

-- required_for starts empty: shifts exist and can be used from day one, but
-- selling isn't BLOCKED on an open till until an admin turns it on under
-- Settings — flipping that on for every existing tenant the moment this
-- migration runs would lock staff out of a live till mid-shift.
alter table tenants add column if not exists shift_rules jsonb not null default
  '{"required_for":[],"blind_count":true,"variance_alert":1000,"pay_out_limit":5000}'::jsonb;

-- One "Main till" per existing branch, so nothing has to be set up by hand
-- before this ships.
insert into registers (tenant_id, branch_id, name)
select b.tenant_id, b.id, 'Main till'
  from branches b
 where not exists (select 1 from registers r where r.branch_id = b.id);

-- Every new branch gets one too.
create or replace function public.auto_create_register()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into registers (tenant_id, branch_id, name) values (NEW.tenant_id, NEW.id, 'Main till');
  return NEW;
end $$;

drop trigger if exists trg_auto_register on branches;
create trigger trg_auto_register after insert on branches
  for each row execute function public.auto_create_register();


-- ------------------------------------------------------------
-- 2. RLS
-- ------------------------------------------------------------

alter table registers      enable row level security;
alter table shifts         enable row level security;
alter table cash_movements enable row level security;

-- registers: like branches — everyone in the company can see the till
-- names, only admin manages them.
drop policy if exists registers_select on registers;
create policy registers_select on registers for select
  using (tenant_id = public.current_tenant_id());
drop policy if exists registers_write on registers;
create policy registers_write on registers for all
  using (tenant_id = public.current_tenant_id() and public.current_role() = 'admin')
  with check (tenant_id = public.current_tenant_id() and public.current_role() = 'admin');

-- shifts and cash_movements: no write policy at all — they only ever
-- change through open_shift/add_cash_movement/close_shift below. Read is
-- branch-scoped the same way sales_orders is.
drop policy if exists shifts_read on shifts;
create policy shifts_read on shifts for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales','accounts')
         and public.can_see_branch(branch_id));

drop policy if exists cash_movements_read on cash_movements;
create policy cash_movements_read on cash_movements for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales','accounts')
         and exists (select 1 from shifts s where s.id = shift_id and public.can_see_branch(s.branch_id)));

drop trigger if exists trg_guard_write on shifts;
create trigger trg_guard_write before insert on shifts
  for each row execute function public.guard_money_write('admin,sales', 'open a till');

drop trigger if exists trg_guard_write on cash_movements;
create trigger trg_guard_write before insert on cash_movements
  for each row execute function public.guard_money_write('admin,sales', 'record a cash movement');


-- ------------------------------------------------------------
-- 3. Helpers
-- ------------------------------------------------------------

-- The shift the caller currently has open at this branch, if any.
create or replace function public.current_open_shift(p_branch uuid default null)
returns uuid
language plpgsql stable security definer set search_path = public as $$
declare
  v_branch uuid := coalesce(p_branch, public.work_branch_id());
  v_shift  uuid;
begin
  select id into v_shift from shifts
   where tenant_id = public.current_tenant_id() and branch_id = v_branch
     and opened_by = auth.uid() and status = 'open';
  return v_shift;
end $$;

-- Does this tenant require an open shift before the named action?
create or replace function public.shift_required(p_action text)
returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select shift_rules->'required_for' ? p_action from tenants where id = public.current_tenant_id()), false)
$$;

revoke execute on function public.shift_required(text) from public, anon, authenticated;


-- ------------------------------------------------------------
-- 4. Opening and closing a till
-- ------------------------------------------------------------

create or replace function public.open_shift(p_register uuid, p_float numeric)
returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_reg    record;
  v_shift  uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_float is null or p_float < 0 then raise exception 'The opening float can''t be negative.'; end if;

  select * into v_reg from registers where id = p_register and tenant_id = v_tenant;
  if not found then raise exception 'Register not found.'; end if;
  if not v_reg.is_active then raise exception '% has been deactivated.', v_reg.name; end if;
  perform public.resolve_branch(v_reg.branch_id);

  if exists (select 1 from shifts where register_id = p_register and status = 'open') then
    raise exception '% already has an open till.', v_reg.name;
  end if;
  if exists (select 1 from shifts where tenant_id = v_tenant and opened_by = auth.uid() and status = 'open') then
    raise exception 'You already have an open till elsewhere — close it first.';
  end if;

  begin
    insert into shifts (tenant_id, branch_id, register_id, opened_by, opening_float, status)
    values (v_tenant, v_reg.branch_id, p_register, auth.uid(), p_float, 'open')
    returning id into v_shift;
  exception when unique_violation then
    raise exception 'That till just got opened by someone else — refresh and try again.';
  end;

  perform public.log_audit('open_shift', 'shifts', v_shift::text,
    jsonb_build_object('register', v_reg.name, 'float', p_float));
  return v_shift;
end $$;

-- Every payment-method group's total for a shift, plus a reconciled
-- 'cash' figure (float + cash sales + pay-ins − pay-outs − drops).
-- Internal — x_report()/z_report()/close_shift() are the public surface.
create or replace function public.shift_expected(p_shift uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_shift     record;
  v_by_method jsonb;
  v_cash_raw  numeric;
  v_pay_in    numeric;
  v_pay_out   numeric;
  v_drop      numeric;
begin
  select * into v_shift from shifts where id = p_shift and tenant_id = v_tenant;
  if not found then raise exception 'Shift not found.'; end if;

  select coalesce(jsonb_object_agg(method_group, total), '{}'::jsonb)
    into v_by_method
    from (
      select coalesce(pt.method_group, 'store_credit') as method_group, sum(sp.amount_paid) as total
        from sale_payments sp
        left join payment_types pt on pt.id = sp.payment_type_id
       where sp.shift_id = p_shift and sp.tenant_id = v_tenant
       group by coalesce(pt.method_group, 'store_credit')
    ) g;

  v_cash_raw := coalesce((v_by_method->>'cash')::numeric, 0);

  select coalesce(sum(amount) filter (where kind = 'pay_in'), 0),
         coalesce(sum(amount) filter (where kind = 'pay_out'), 0),
         coalesce(sum(amount) filter (where kind = 'drop'), 0)
    into v_pay_in, v_pay_out, v_drop
    from cash_movements where shift_id = p_shift and tenant_id = v_tenant;

  return (v_by_method - 'cash') || jsonb_build_object(
    'cash', v_shift.opening_float + v_cash_raw + v_pay_in - v_pay_out - v_drop,
    'opening_float', v_shift.opening_float,
    'cash_sales', v_cash_raw,
    'pay_in', v_pay_in, 'pay_out', v_pay_out, 'drop', v_drop
  );
end $$;

revoke execute on function public.shift_expected(uuid) from public, anon, authenticated;

create or replace function public.add_cash_movement(
  p_kind     text,
  p_amount   numeric,
  p_reason   text,
  p_approval jsonb default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant      uuid := public.current_tenant_id();
  v_shift       uuid;
  v_id          uuid;
  v_limit       numeric;
  v_approved_by uuid;
begin
  if p_kind not in ('pay_in','pay_out','drop') then raise exception 'Unknown cash-movement kind.'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'The amount has to be more than zero.'; end if;
  if p_reason is null or trim(p_reason) = '' then raise exception 'A reason is required.'; end if;

  v_shift := public.current_open_shift();
  if v_shift is null then raise exception 'Open your till first.'; end if;

  if p_kind = 'pay_out' and public.current_role() <> 'admin' then
    select coalesce((shift_rules->>'pay_out_limit')::numeric, 0) into v_limit from tenants where id = v_tenant;
    if v_limit > 0 and p_amount > v_limit then
      v_approved_by := nullif(p_approval->>'user_id', '')::uuid;
      if v_approved_by is null or not public.verify_approval_pin(v_approved_by, p_approval->>'pin') then
        raise exception 'A pay-out over ₦%s needs a manager''s PIN.', to_char(v_limit, 'FM999,999,999');
      end if;
    end if;
  end if;

  insert into cash_movements (tenant_id, shift_id, kind, amount, reason, created_by)
  values (v_tenant, v_shift, p_kind, p_amount, p_reason, auth.uid())
  returning id into v_id;

  perform public.log_audit('cash_' || p_kind, 'cash_movements', v_id::text,
    jsonb_build_object('amount', p_amount, 'reason', p_reason, 'approved_by', v_approved_by));
  return v_id;
end $$;

create or replace function public.x_report(p_shift uuid default null)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_shift    record;
  v_expected jsonb;
  v_sales    record;
  v_refunds  numeric;
begin
  if not public.has_role('sales','accounts') then
    raise exception 'Your role is not allowed to see till reports.' using errcode = 'insufficient_privilege';
  end if;
  if p_shift is null then
    select * into v_shift from shifts
     where tenant_id = v_tenant and opened_by = auth.uid() and status = 'open';
  else
    select * into v_shift from shifts where id = p_shift and tenant_id = v_tenant;
  end if;
  if not found then raise exception 'No shift found — open a till first, or pass a shift id.'; end if;
  if not public.can_see_branch(v_shift.branch_id) then
    raise exception 'You can''t see this branch''s tills.';
  end if;

  v_expected := public.shift_expected(v_shift.id);

  select count(*) as n, coalesce(sum(total_amount), 0) as total, coalesce(sum(discount_total), 0) as discounts
    into v_sales
    from sales_orders where shift_id = v_shift.id and tenant_id = v_tenant and not voided;

  select coalesce(sum(-amount_paid), 0) into v_refunds
    from sale_payments where shift_id = v_shift.id and tenant_id = v_tenant and sale_return_id is not null;

  return jsonb_build_object(
    'shift_id', v_shift.id, 'register_id', v_shift.register_id, 'branch_id', v_shift.branch_id,
    'opened_by', v_shift.opened_by, 'opened_at', v_shift.opened_at, 'opening_float', v_shift.opening_float,
    'status', v_shift.status,
    'sales_count', v_sales.n, 'sales_total', v_sales.total, 'discount_total', v_sales.discounts,
    'refunds_total', v_refunds, 'expected', v_expected
  );
end $$;

create or replace function public.z_report(p_shift uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_shift   record;
  v_sales   record;
  v_refunds numeric;
begin
  if not public.has_role('sales','accounts') then
    raise exception 'Your role is not allowed to see till reports.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_shift from shifts where id = p_shift and tenant_id = v_tenant;
  if not found then raise exception 'Shift not found.'; end if;
  if not public.can_see_branch(v_shift.branch_id) then
    raise exception 'You can''t see this branch''s tills.';
  end if;
  if v_shift.status <> 'closed' then
    raise exception 'This till hasn''t been closed yet — use the X report while it''s open.';
  end if;

  select count(*) as n, coalesce(sum(total_amount), 0) as total, coalesce(sum(discount_total), 0) as discounts
    into v_sales
    from sales_orders where shift_id = p_shift and tenant_id = v_tenant and not voided;

  select coalesce(sum(-amount_paid), 0) into v_refunds
    from sale_payments where shift_id = p_shift and tenant_id = v_tenant and sale_return_id is not null;

  return jsonb_build_object(
    'shift_id', v_shift.id, 'doc_no', v_shift.doc_no, 'register_id', v_shift.register_id,
    'branch_id', v_shift.branch_id, 'opened_by', v_shift.opened_by, 'opened_at', v_shift.opened_at,
    'closed_by', v_shift.closed_by, 'closed_at', v_shift.closed_at, 'opening_float', v_shift.opening_float,
    'sales_count', v_sales.n, 'sales_total', v_sales.total, 'discount_total', v_sales.discounts,
    'refunds_total', v_refunds,
    'expected', v_shift.expected, 'counted_cash', v_shift.counted_cash,
    'counted_breakdown', v_shift.counted_breakdown, 'variance', v_shift.variance, 'notes', v_shift.notes
  );
end $$;

-- Snapshots the expected figure, records what was actually counted, and
-- issues the shift's Z number. Returns the same shape as z_report().
create or replace function public.close_shift(
  p_counted_cash numeric,
  p_breakdown    jsonb default null,
  p_notes        text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant        uuid := public.current_tenant_id();
  v_shift         record;
  v_expected      jsonb;
  v_expected_cash numeric;
  v_variance      numeric;
  v_doc_no        text;
  v_alert         numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select * into v_shift from shifts
   where tenant_id = v_tenant and opened_by = auth.uid() and status = 'open' for update;
  if not found then raise exception 'You have no open till.'; end if;
  if p_counted_cash is null or p_counted_cash < 0 then raise exception 'The counted cash can''t be negative.'; end if;

  v_expected      := public.shift_expected(v_shift.id);
  v_expected_cash := coalesce((v_expected->>'cash')::numeric, 0);
  v_variance      := p_counted_cash - v_expected_cash;
  v_doc_no        := public.next_doc_no(v_tenant, 'Z');

  update shifts
     set closed_by = auth.uid(), closed_at = now(), expected = v_expected,
         counted_cash = p_counted_cash, counted_breakdown = p_breakdown,
         variance = v_variance, notes = p_notes, status = 'closed', doc_no = v_doc_no
   where id = v_shift.id;

  select coalesce((shift_rules->>'variance_alert')::numeric, 1000) into v_alert from tenants where id = v_tenant;
  if abs(v_variance) >= v_alert then
    perform public.log_audit('shift_variance', 'shifts', v_shift.id::text,
      jsonb_build_object('expected', v_expected_cash, 'counted', p_counted_cash, 'variance', v_variance));
  end if;
  perform public.log_audit('close_shift', 'shifts', v_shift.id::text,
    jsonb_build_object('doc_no', v_doc_no, 'variance', v_variance));

  return public.z_report(v_shift.id);
end $$;


-- ------------------------------------------------------------
-- 5. New tenants must get a correctly-classified 'Cash' type too
-- ------------------------------------------------------------
-- The backfill above only reaches rows that exist today. Without this, a
-- business signing up tomorrow gets a seeded 'Cash' payment type stuck at
-- method_group 'other' forever, and its own cash-up would never balance.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  new_tenant_id uuid;
  new_branch_id uuid;
  company text;
  ttype tenant_type;
  base_slug text;
  v_invite record;
begin
  select * into v_invite
    from staff_invites
   where lower(email) = lower(new.email) and status = 'pending'
   order by created_at desc limit 1;

  if found then
    insert into profiles (id, tenant_id, branch_id, role, full_name, email)
    values (new.id, v_invite.tenant_id,
            coalesce(v_invite.branch_id, public.default_branch_id(v_invite.tenant_id)),
            v_invite.role, new.raw_user_meta_data ->> 'full_name', new.email);
    update staff_invites set status = 'accepted' where id = v_invite.id;
    return new;
  end if;

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

  insert into profiles (id, tenant_id, branch_id, role, full_name, email)
    values (new.id, new_tenant_id, new_branch_id, 'admin',
            new.raw_user_meta_data ->> 'full_name', new.email);

  insert into payment_types (tenant_id, name, method_group) values
    (new_tenant_id, 'Cash', 'cash'), (new_tenant_id, 'Bank Transfer', 'transfer'), (new_tenant_id, 'Credit', 'other');
  insert into customer_types (tenant_id, name) values
    (new_tenant_id, 'Corporate'), (new_tenant_id, 'Private');
  insert into expense_types (tenant_id, name) values
    (new_tenant_id, 'Transport'), (new_tenant_id, 'Salary'), (new_tenant_id, 'Rent');

  return new;
end $$;


-- ------------------------------------------------------------
-- 6. Tag every payment-moving RPC with the caller's open shift
-- ------------------------------------------------------------
-- Bodies copied verbatim from 0025/0020/0023/0024 except where marked
-- "-- Phase 4". Signatures are unchanged, so no drop-and-recreate needed.

create or replace function public.create_sale(
  p_customer       uuid,
  p_date           date,
  p_payment_type   uuid,
  p_amount_paid    numeric,
  p_items          jsonb,
  p_vat_rate       numeric default 0,   -- accepted for compatibility; ignored
  p_branch         uuid default null,
  p_order_discount numeric default 0,   -- a flat ₦ amount off the whole sale
  p_approval       jsonb default null   -- {"user_id": "...", "pin": "1234"}, only when over the limit
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant    uuid := public.current_tenant_id();
  v_role      user_role := public.current_role();
  v_branch    uuid;
  v_shift     uuid;   -- Phase 4
  v_sale      uuid;
  v_date      date := coalesce(p_date, current_date);
  v_item      jsonb;
  v_fg        uuid;
  v_pin       uuid;
  v_pinned    record;
  v_qty       numeric;
  v_price     numeric;
  v_line      numeric;
  v_list_price numeric;
  v_line_list_id uuid;
  v_sale_list_id uuid;
  v_line_discount numeric;
  v_reason    text;
  v_subtotal  numeric := 0;
  v_total_list_value numeric := 0;
  v_total_discount   numeric := 0;
  v_vat_rate  numeric := 0;
  v_allow     boolean := false;
  v_below_cost text := 'warn';
  v_vat       numeric := 0;
  v_total     numeric := 0;
  v_cogs      numeric := 0;
  v_line_cogs numeric;
  v_sale_item uuid;
  v_need      numeric;
  v_take      numeric;
  v_batch     record;
  v_avail     numeric;
  v_onhand    numeric;
  v_rule      text;
  v_paid      numeric;
  v_status    pay_status;
  v_name      text;
  v_unit      text;
  v_max_pct   numeric;
  v_discount_pct numeric;
  v_approved_by uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.resolve_branch(p_branch);

  -- Phase 4: an open till, if this tenant requires one for selling.
  v_shift := public.current_open_shift(v_branch);
  if v_shift is null and public.shift_required('sales') then
    raise exception 'Open your till before selling.';
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A sale needs at least one item.';
  end if;
  perform public.assert_same_tenant('customers', p_customer);
  perform public.assert_same_tenant('payment_types', p_payment_type);

  select case when vat_enabled then coalesce(vat_rate, 0) else 0 end, coalesce(allow_expired_sale, false),
         coalesce(pricing_rules->>'below_cost', 'warn')
    into v_vat_rate, v_allow, v_below_cost from tenants where id = v_tenant;

  insert into sales_orders(tenant_id, branch_id, customer_id, transaction_date, payment_type_id, created_by, shift_id)
  values (v_tenant, v_branch, p_customer, v_date, p_payment_type, auth.uid(), v_shift)
  returning id into v_sale;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_fg    := (v_item->>'finished_good_id')::uuid;
    v_qty   := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    v_pin   := nullif(v_item->>'fg_batch_id', '')::uuid;
    v_reason := nullif(trim(v_item->>'discount_reason'), '');
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every sale line needs a quantity above zero.';
    end if;
    if v_price is null or v_price < 0 then
      raise exception 'Selling price can''t be negative.';
    end if;
    perform public.assert_same_tenant('finished_goods', v_fg);
    select name, unit, pick_rule into v_name, v_unit, v_rule from finished_goods where id = v_fg;

    select rp.unit_price, rp.price_list_id into v_list_price, v_line_list_id from public.resolve_price(v_fg, p_customer, v_qty) rp;
    if v_sale_list_id is null then v_sale_list_id := v_line_list_id; end if;

    v_line := v_qty * v_price;
    v_subtotal := v_subtotal + v_line;
    v_total_list_value := v_total_list_value + (v_qty * v_list_price);
    -- Charging less than list is a discount; charging more is a price-up,
    -- not tracked as a negative discount.
    v_line_discount := greatest((v_qty * v_list_price) - v_line, 0);
    v_total_discount := v_total_discount + v_line_discount;

    if v_pin is not null then
      select * into v_pinned from fg_batches
       where id = v_pin and tenant_id = v_tenant and branch_id = v_branch and finished_good_id = v_fg;
      if not found then
        raise exception 'That batch of % isn''t at %.', v_name, public.branch_name(v_branch);
      end if;
      if v_pinned.status <> 'available' then
        raise exception 'Batch % of % is %, so it can''t be sold.', coalesce(v_pinned.batch_no, ''), v_name,
          case v_pinned.status when 'recalled' then 'recalled' else 'on hold' end;
      end if;
      if not public.batch_is_sellable(v_pinned.status, v_pinned.expiry_date, v_date, v_allow) then
        raise exception 'Batch % of % expired on %, so it can''t be sold.', coalesce(v_pinned.batch_no, ''), v_name,
          to_char(v_pinned.expiry_date, 'DD Mon YYYY');
      end if;
      if v_pinned.qty_remaining < v_qty then
        raise exception 'Only % % left in batch % of %.', v_pinned.qty_remaining, coalesce(v_unit, ''),
          coalesce(v_pinned.batch_no, ''), v_name;
      end if;
    else
      select coalesce(sum(qty_remaining) filter (
               where public.batch_is_sellable(status, expiry_date, v_date, v_allow)), 0),
             coalesce(sum(qty_remaining), 0)
        into v_avail, v_onhand
        from fg_batches
       where tenant_id = v_tenant and branch_id = v_branch and finished_good_id = v_fg;
      if v_avail < v_qty then
        if v_onhand > v_avail then
          raise exception 'Only % % of % can be sold at % — % % are expired, recalled or on hold.',
            v_avail, coalesce(v_unit, ''), v_name, public.branch_name(v_branch),
            v_onhand - v_avail, coalesce(v_unit, '');
        end if;
        raise exception 'Only % % of % left at % — can''t sell %.',
          v_avail, coalesce(v_unit, ''), v_name, public.branch_name(v_branch), v_qty;
      end if;
    end if;

    insert into sale_items(tenant_id, sales_order_id, finished_good_id, quantity, unit_price, amount,
                           list_price, discount_amount, discount_reason)
    values (v_tenant, v_sale, v_fg, v_qty, v_price, v_line, v_list_price, v_line_discount, v_reason)
    returning id into v_sale_item;

    v_need := v_qty;
    v_line_cogs := 0;
    for v_batch in
      select id, qty_remaining, unit_cost from fg_batches
       where tenant_id = v_tenant and branch_id = v_branch
         and finished_good_id = v_fg and qty_remaining > 0
         and (v_pin is null or id = v_pin)
         and public.batch_is_sellable(status, expiry_date, v_date, v_allow)
       order by case when v_rule = 'fefo' then expiry_date end asc nulls last,
                produced_at asc, id asc
         for update
    loop
      exit when v_need <= 0;
      v_take := least(v_need, v_batch.qty_remaining);
      update fg_batches set qty_remaining = qty_remaining - v_take where id = v_batch.id;
      insert into sales_consumption(tenant_id, sale_item_id, fg_batch_id, finished_good_id, qty, unit_cost, selling_price)
      values (v_tenant, v_sale_item, v_batch.id, v_fg, v_take, v_batch.unit_cost, v_price);
      v_line_cogs := v_line_cogs + (v_take * v_batch.unit_cost);
      v_need := v_need - v_take;
    end loop;
    if v_need > 0 then
      raise exception '% just sold out at % — please check the quantity and try again.',
        v_name, public.branch_name(v_branch);
    end if;
    v_cogs := v_cogs + v_line_cogs;

    if v_line < v_line_cogs then
      if v_below_cost = 'block' then
        raise exception '% would sell below its cost — charging %s but it cost %s. Raise the price, or ask a manager.',
          v_name, to_char(v_price, 'FM999,999,999.00'), to_char(round(v_line_cogs / v_qty, 2), 'FM999,999,999.00');
      else
        perform public.log_audit('below_cost_sale', 'finished_goods', v_fg::text,
          jsonb_build_object('charged', v_price, 'cost_per_unit', round(v_line_cogs / v_qty, 2), 'sale_item_id', v_sale_item));
      end if;
    end if;

    update finished_goods set qty_balance = qty_balance - v_qty where id = v_fg and tenant_id = v_tenant;
    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_branch, 'finished_good', v_fg, 'SALE', -v_qty, v_sale, auth.uid());
  end loop;

  if coalesce(p_order_discount, 0) < 0 then raise exception 'The order discount can''t be negative.'; end if;
  if p_order_discount > v_subtotal then raise exception 'The order discount can''t be more than the sale total.'; end if;
  v_total_discount := v_total_discount + coalesce(p_order_discount, 0);
  v_subtotal := v_subtotal - coalesce(p_order_discount, 0);

  v_max_pct := case when v_role = 'admin' then 100
                     else coalesce((
                       select (pricing_rules->'max_discount_pct'->>v_role::text)::numeric from tenants where id = v_tenant
                     ), 0) end;
  v_discount_pct := case when v_total_list_value > 0 then round(100 * v_total_discount / v_total_list_value, 2) else 0 end;

  if v_discount_pct > v_max_pct then
    v_approved_by := nullif(p_approval->>'user_id', '')::uuid;
    if v_approved_by is null or not public.verify_approval_pin(v_approved_by, p_approval->>'pin') then
      raise exception 'This %s%% discount is above your %s%% limit — a manager''s PIN is needed to go ahead.',
        to_char(v_discount_pct, 'FM999990.0'), to_char(v_max_pct, 'FM999990');
    end if;
  else
    v_approved_by := null;
  end if;

  v_vat   := round(v_subtotal * v_vat_rate / 100, 2);
  v_total := v_subtotal + v_vat;

  v_paid   := greatest(0, least(coalesce(p_amount_paid, 0), v_total));
  v_status := case when v_paid <= 0 then 'unpaid' when v_paid >= v_total then 'full' else 'part' end;

  update sales_orders
     set subtotal = v_subtotal, vat_amount = v_vat, vat_rate = v_vat_rate,
         total_amount = v_total, amount_paid = v_paid, balance = v_total - v_paid,
         cogs = v_cogs, gross_profit = v_subtotal - v_cogs,   -- VAT is never profit
         payment_status = v_status, processed = true,
         price_list_id = v_sale_list_id, discount_total = v_total_discount, approved_by = v_approved_by
   where id = v_sale;

  if v_paid > 0 then
    insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id, shift_id)
    values (v_tenant, v_sale, v_paid, p_payment_type, v_shift);
  end if;

  if v_total_discount > 0 then
    perform public.log_audit('discount', 'sales_orders', v_sale::text,
      jsonb_build_object('discount_total', v_total_discount, 'discount_pct', v_discount_pct, 'approved_by', v_approved_by));
  end if;

  return v_sale;
end $$;

create or replace function public.record_sale_payment(
  p_sale         uuid,
  p_amount       numeric,
  p_payment_type uuid,
  p_reference    text default null,
  p_notes        text default null
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_row    record;
  v_paid   numeric;
  v_status pay_status;
  v_shift  uuid;   -- Phase 4
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment has to be more than zero.';
  end if;
  perform public.assert_same_tenant('payment_types', p_payment_type);

  select * into v_row from sales_orders where id = p_sale and tenant_id = v_tenant for update;
  if not found then raise exception 'Sale not found.'; end if;
  if v_row.voided then raise exception 'This sale has been voided — it can''t take a payment.'; end if;
  if p_amount > v_row.balance + 0.005 then
    raise exception 'That''s more than the ₦% still owed on this sale.', v_row.balance;
  end if;

  v_shift := public.current_open_shift(v_row.branch_id);   -- Phase 4

  insert into sale_payments(tenant_id, sales_order_id, payment_date, amount_paid, payment_type_id, reference, notes, shift_id)
  values (v_tenant, p_sale, current_date, p_amount, p_payment_type, p_reference, p_notes, v_shift);

  select coalesce(sum(amount_paid), 0) into v_paid
    from sale_payments where sales_order_id = p_sale and tenant_id = v_tenant;
  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid >= v_row.total_amount then 'full'
                   else 'part' end;

  update sales_orders
     set amount_paid = v_paid, balance = v_row.total_amount - v_paid, payment_status = v_status
   where id = p_sale and tenant_id = v_tenant;
end $$;

create or replace function public.create_sale_return(
  p_sale             uuid,
  p_items            jsonb,
  p_reason           text default null,
  p_remainder_method text default 'cash',
  p_payment_type     uuid default null,
  p_date             date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_role     user_role := public.current_role();
  v_policy   text;
  v_so       record;
  v_date     date := coalesce(p_date, current_date);
  v_item     jsonb;
  v_line     record;
  v_ret_item_id uuid;
  v_qty      numeric;
  v_cond     text;
  v_line_subtotal numeric;
  v_line_vat      numeric;
  v_return_subtotal numeric := 0;
  v_return_vat      numeric := 0;
  v_cogs_reversed   numeric := 0;
  v_need numeric; v_take numeric; v_cons record;
  v_return_id uuid;
  v_doc_no text;
  v_applied numeric; v_remainder numeric; v_new_balance numeric;
  v_net_total numeric; v_status pay_status;
  v_any boolean := false;
  v_refund_id uuid;
  v_shift    uuid;   -- Phase 4
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('sales','accounts') then
    raise exception 'Your role is not allowed to record a return.' using errcode = 'insufficient_privilege';
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — returns are read-only until billing is sorted out.';
  end if;
  if p_remainder_method not in ('cash','store_credit') then
    raise exception 'Unknown refund method %.', p_remainder_method;
  end if;

  select * into v_so from sales_orders where id = p_sale and tenant_id = v_tenant for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_so.voided then raise exception 'This sale is voided — there is nothing left to return.'; end if;
  if v_date < v_so.transaction_date then raise exception 'A return can''t be dated before the sale.'; end if;

  -- How far a cashier may go is a per-business setting (tenants.cashier_returns):
  -- 'none' (admin/accounts only), 'same_day_own' (the default), or 'any'.
  if v_role = 'sales' then
    select coalesce(cashier_returns, 'same_day_own') into v_policy from tenants where id = v_tenant;
    if v_policy = 'none' then
      raise exception 'Cashiers cannot process returns at this business — ask an admin or accounts.'
        using errcode = 'insufficient_privilege';
    end if;
    if v_policy <> 'any' and v_so.created_by is distinct from auth.uid() then
      raise exception 'You can only process returns for sales you rang up yourself.';
    end if;
    if v_policy = 'same_day_own' and v_so.transaction_date <> current_date then
      raise exception 'You can only return something the same day it was sold — ask an admin or accounts for an older sale.';
    end if;
  end if;

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A return needs at least one item.';
  end if;

  v_shift := public.current_open_shift(v_so.branch_id);   -- Phase 4

  v_doc_no := public.next_doc_no(v_tenant, 'CN');
  insert into sale_returns(tenant_id, branch_id, sales_order_id, doc_no, return_date, reason, created_by)
  values (v_tenant, v_so.branch_id, p_sale, v_doc_no, v_date, nullif(trim(p_reason), ''), auth.uid())
  returning id into v_return_id;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_line from sale_items
     where id = (v_item->>'sale_item_id')::uuid and sales_order_id = p_sale and tenant_id = v_tenant
       for update;
    if not found then raise exception 'That line does not belong to this sale.'; end if;

    v_qty  := (v_item->>'qty')::numeric;
    v_cond := coalesce(nullif(v_item->>'condition', ''), 'resellable');
    if v_cond not in ('resellable','damaged','expired') then
      raise exception 'Unknown condition %.', v_cond;
    end if;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every return line needs a quantity above zero.';
    end if;
    if v_qty > (v_line.quantity - v_line.qty_returned) then
      raise exception 'Only % of this line is still returnable — % of it has already come back.',
        v_line.quantity - v_line.qty_returned, v_line.qty_returned;
    end if;

    v_any := true;
    v_line_subtotal := v_qty * v_line.unit_price;
    v_line_vat      := round(v_line_subtotal * v_so.vat_rate / 100, 2);
    v_return_subtotal := v_return_subtotal + v_line_subtotal;
    v_return_vat      := v_return_vat + v_line_vat;

    update sale_items set qty_returned = qty_returned + v_qty where id = v_line.id;

    insert into sale_return_items(tenant_id, sale_return_id, sale_item_id, finished_good_id, qty, unit_price, amount, condition)
    values (v_tenant, v_return_id, v_line.id, v_line.finished_good_id, v_qty, v_line.unit_price, v_line_subtotal, v_cond)
    returning id into v_ret_item_id;

    -- Resellable: walk the FIFO trace newest draw first (the last batch
    -- this line took from) and put the stock straight back at its own
    -- cost — recorded per-return, so voiding this return later touches
    -- only what THIS return moved. Damaged/expired: the units don't come
    -- back and their cost stays a loss, so sales_consumption is untouched.
    if v_cond = 'resellable' then
      v_need := v_qty;
      for v_cons in
        select * from sales_consumption
         where sale_item_id = v_line.id and tenant_id = v_tenant and qty > qty_returned
         order by id desc
           for update
      loop
        exit when v_need <= 0;
        v_take := least(v_need, v_cons.qty - v_cons.qty_returned);
        update sales_consumption set qty_returned = qty_returned + v_take where id = v_cons.id;
        if v_cons.fg_batch_id is not null then
          update fg_batches set qty_remaining = qty_remaining + v_take
           where id = v_cons.fg_batch_id and tenant_id = v_tenant;
        end if;
        update finished_goods set qty_balance = qty_balance + v_take
         where id = v_line.finished_good_id and tenant_id = v_tenant;
        insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
        values (v_tenant, v_so.branch_id, 'finished_good', v_line.finished_good_id, 'RETURN', v_take, v_return_id, auth.uid());
        insert into sale_return_consumption(tenant_id, sale_return_item_id, fg_batch_id, qty, unit_cost)
        values (v_tenant, v_ret_item_id, v_cons.fg_batch_id, v_take, v_cons.unit_cost);
        v_cogs_reversed := v_cogs_reversed + v_take * v_cons.unit_cost;
        v_need := v_need - v_take;
      end loop;
      if v_need > 0 then
        raise exception 'Couldn''t trace % of this line back to what was actually sold — try a smaller quantity.', v_need;
      end if;
    end if;
  end loop;

  if not v_any then raise exception 'A return needs at least one item.'; end if;

  declare
    v_return_total  numeric := v_return_subtotal + v_return_vat;
    v_profit_impact numeric := v_return_subtotal - v_cogs_reversed;
  begin
    v_applied     := least(v_return_total, v_so.balance);
    v_remainder   := v_return_total - v_applied;
    v_new_balance := v_so.balance - v_applied;

    if v_remainder > 0 then
      if p_remainder_method = 'store_credit' then
        if v_so.customer_id is null then
          raise exception 'Store credit needs a named customer on this sale — pick one, or refund in cash instead.';
        end if;
        update customers set credit_balance = credit_balance + v_remainder
         where id = v_so.customer_id and tenant_id = v_tenant;
        insert into customer_credit_ledger(tenant_id, customer_id, amount, source_type, source_id)
        values (v_tenant, v_so.customer_id, v_remainder, 'return', v_return_id);
      else
        perform public.assert_same_tenant('payment_types', p_payment_type);
        insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id, reference, notes, sale_return_id, shift_id)
        values (v_tenant, p_sale, -v_remainder, p_payment_type, 'RETURN', 'Refund for ' || v_doc_no, v_return_id, v_shift)
        returning id into v_refund_id;
      end if;
    end if;

    v_net_total := v_so.total_amount - (v_so.returned_total + v_return_total);
    v_status := case
      when v_new_balance <= 0 then 'full'
      when v_new_balance >= v_net_total then 'unpaid'
      else 'part' end;

    update sale_returns
       set subtotal = v_return_subtotal, vat_amount = v_return_vat, total = v_return_total,
           cogs_reversed = v_cogs_reversed, applied_to_balance = v_applied,
           refunded        = case when p_remainder_method = 'cash'         then v_remainder else 0 end,
           to_store_credit = case when p_remainder_method = 'store_credit' then v_remainder else 0 end,
           refund_payment_type_id = case when p_remainder_method = 'cash' then p_payment_type else null end
     where id = v_return_id;

    update sales_orders
       set returned_total  = returned_total + v_return_total,
           returned_profit = returned_profit + v_profit_impact,
           balance         = v_new_balance,
           payment_status  = v_status
     where id = p_sale;
  end;

  perform public.log_audit('return', 'sales_orders', p_sale::text,
    jsonb_build_object('return_id', v_return_id, 'doc_no', v_doc_no, 'total', v_return_subtotal + v_return_vat));

  return v_return_id;
end $$;

create or replace function public.spend_store_credit(p_sale uuid, p_amount numeric)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_so     record;
  v_credit numeric;
  v_shift  uuid;   -- Phase 4
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('sales','accounts') then
    raise exception 'Your role is not allowed to record a payment.' using errcode = 'insufficient_privilege';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount above zero.'; end if;

  select * into v_so from sales_orders where id = p_sale and tenant_id = v_tenant for update;
  if not found then raise exception 'Sale not found'; end if;
  if v_so.voided then raise exception 'This sale has been voided.'; end if;
  if v_so.customer_id is null then raise exception 'This sale has no customer — store credit needs one.'; end if;
  if p_amount > v_so.balance then
    raise exception 'That is more than the %s still owed on this sale.', to_char(v_so.balance, 'FM999,999,999.00');
  end if;

  select credit_balance into v_credit from customers where id = v_so.customer_id and tenant_id = v_tenant for update;
  if coalesce(v_credit, 0) < p_amount then
    raise exception 'This customer only has %s in store credit.', to_char(coalesce(v_credit, 0), 'FM999,999,999.00');
  end if;

  v_shift := public.current_open_shift(v_so.branch_id);   -- Phase 4

  update customers set credit_balance = credit_balance - p_amount where id = v_so.customer_id and tenant_id = v_tenant;
  insert into customer_credit_ledger(tenant_id, customer_id, amount, source_type, source_id)
  values (v_tenant, v_so.customer_id, -p_amount, 'sale', p_sale);

  insert into sale_payments(tenant_id, sales_order_id, amount_paid, payment_type_id, reference, notes, shift_id)
  values (v_tenant, p_sale, p_amount, null, 'STORE_CREDIT', 'Paid from store credit', v_shift);

  update sales_orders
     set balance = balance - p_amount,
         payment_status = case when balance - p_amount <= 0 then 'full'::pay_status else 'part'::pay_status end
   where id = p_sale;
end $$;
