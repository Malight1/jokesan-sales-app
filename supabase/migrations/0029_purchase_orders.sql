-- ============================================================
-- StockFlow — Purchase orders: ordered before received (Phase 6b)
--
-- Until now create_purchase() always received stock immediately — there
-- was no way to record "we ordered 500kg of caustic soda" without also
-- claiming it had already arrived. That stays exactly as it is today
-- ("Quick purchase" — a supplier who delivers on the spot doesn't need
-- an order/receive round trip) but now also gets a real PO- number, same
-- as every other document in this app.
--
-- The new path: create_purchase_order() places an order (no stock, no
-- money owed yet — you don't owe a supplier for goods you haven't got),
-- then one or more calls to receive_purchase_order() create the actual
-- FIFO purchase_items layers as goods arrive, each stamped with a real
-- GRN- number. What you owe grows only by what's actually been received,
-- never by what was merely ordered — a cancelled order that was half
-- delivered keeps the half that arrived and cancels the rest.
--
-- "Advance payments allowed" (FEATURE_PLAN.md's 6b) meant relaxing
-- record_purchase_payment's old "can't pay more than the balance" cap —
-- paying a supplier ahead of receiving goods is completely normal, and a
-- negative balance is the intended signal for "supplier owes you goods."
-- ============================================================


-- ------------------------------------------------------------
-- 1. Schema
-- ------------------------------------------------------------

alter table purchase_orders
  add column if not exists doc_no        text,
  add column if not exists status        text not null default 'received'
    check (status in ('draft', 'ordered', 'partial', 'received', 'cancelled')),
  add column if not exists expected_date date,
  add column if not exists ordered_at    timestamptz;

create unique index if not exists uq_purchase_orders_doc_no on purchase_orders (tenant_id, doc_no) where doc_no is not null;

-- Number every existing purchase, in the order it happened, per company —
-- same backfill shape 0021 used for sales_orders.
do $$
declare r record;
begin
  for r in
    select id, tenant_id from purchase_orders
     where doc_no is null
     order by tenant_id, created_at, id
  loop
    update purchase_orders set doc_no = public.next_doc_no(r.tenant_id, 'PO') where id = r.id;
  end loop;
end $$;

create table if not exists purchase_order_lines (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  material_id       uuid not null references materials(id) on delete restrict,
  qty_ordered       numeric(14,3) not null,
  qty_received      numeric(14,3) not null default 0,
  unit_cost         numeric(14,2) not null
);
create index if not exists idx_po_lines_po on purchase_order_lines (purchase_order_id);

create table if not exists goods_receipts (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  branch_id         uuid not null references branches(id),
  purchase_order_id uuid not null references purchase_orders(id) on delete cascade,
  doc_no            text,
  received_at       timestamptz not null default now(),
  received_by       uuid references auth.users(id),
  note              text
);
create unique index if not exists uq_goods_receipts_doc_no on goods_receipts (tenant_id, doc_no) where doc_no is not null;
create index if not exists idx_goods_receipts_po on goods_receipts (purchase_order_id);

alter table purchase_items add column if not exists goods_receipt_id uuid references goods_receipts(id);
alter table purchase_items add column if not exists po_line_id       uuid references purchase_order_lines(id);

-- A simple "most recently observed" lead time, not a rolling average —
-- set once a PO reaches 'received' status. Good enough to show "usually
-- takes about N days"; a proper average is a later refinement.
alter table suppliers add column if not exists lead_time_days int;


-- ------------------------------------------------------------
-- 2. RLS
-- ------------------------------------------------------------

alter table purchase_order_lines enable row level security;
drop policy if exists purchase_order_lines_read on purchase_order_lines;
create policy purchase_order_lines_read on purchase_order_lines for select
  using (tenant_id = public.current_tenant_id() and public.has_role('inventory', 'accounts')
         and exists (select 1 from purchase_orders po where po.id = purchase_order_id and public.can_see_branch(po.branch_id)));
-- No write policy — only ever written from inside create_purchase_order()/receive_purchase_order().

alter table goods_receipts enable row level security;
drop policy if exists goods_receipts_read on goods_receipts;
create policy goods_receipts_read on goods_receipts for select
  using (tenant_id = public.current_tenant_id() and public.has_role('inventory', 'accounts')
         and public.can_see_branch(branch_id));
-- No write policy — only ever written from inside receive_purchase_order().


-- ------------------------------------------------------------
-- 3. create_purchase gets a real PO- number too (body otherwise
--    unchanged — this stays the immediate-receipt "Quick purchase" path)
-- ------------------------------------------------------------

create or replace function public.create_purchase(
  p_supplier      uuid,
  p_date          date,
  p_payment_type  uuid,
  p_amount_paid   numeric,
  p_items         jsonb,
  p_branch        uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid;
  v_po     uuid;
  v_item   jsonb;
  v_total  numeric := 0;
  v_amount numeric;
  v_paid   numeric;
  v_status pay_status;
  v_qty    numeric;
  v_cost   numeric;
  v_mat    uuid;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.resolve_branch(p_branch);

  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A purchase needs at least one item.';
  end if;
  perform public.assert_same_tenant('suppliers', p_supplier);
  perform public.assert_same_tenant('payment_types', p_payment_type);

  insert into purchase_orders(tenant_id, branch_id, supplier_id, purchase_date, payment_type_id, created_by, doc_no, status)
  values (v_tenant, v_branch, p_supplier, coalesce(p_date, current_date), p_payment_type, auth.uid(),
          public.next_doc_no(v_tenant, 'PO'), 'received')
  returning id into v_po;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_mat  := (v_item->>'material_id')::uuid;
    v_qty  := (v_item->>'qty')::numeric;
    v_cost := (v_item->>'cost_price')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Every purchase line needs a quantity above zero.';
    end if;
    if v_cost is null or v_cost < 0 then
      raise exception 'Cost price can''t be negative.';
    end if;
    perform public.assert_same_tenant('materials', v_mat);

    v_amount := v_qty * v_cost;
    v_total  := v_total + v_amount;

    insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining,
                               cost_price, amount, branch_id, origin, supplier_batch_no, expiry_date)
    values (v_tenant, v_po, v_mat, v_qty, v_qty, v_cost, v_amount, v_branch, 'purchase',
            nullif(trim(v_item->>'supplier_batch_no'), ''),
            nullif(v_item->>'expiry_date', '')::date);

    update materials set qty_balance = qty_balance + v_qty
     where id = v_mat and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_branch, 'material', v_mat, 'PURCHASE', v_qty, v_po, auth.uid());
  end loop;

  v_paid   := greatest(0, least(coalesce(p_amount_paid, 0), v_total));
  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid >= v_total then 'full'
                   else 'part' end;

  update purchase_orders
     set total_amount = v_total, total_paid = v_paid, balance = v_total - v_paid,
         payment_status = v_status, processed = true
   where id = v_po;

  if v_paid > 0 then
    insert into purchase_payments(tenant_id, purchase_order_id, amount_paid, payment_type_id)
    values (v_tenant, v_po, v_paid, p_payment_type);
  end if;

  return v_po;
end $$;


-- ------------------------------------------------------------
-- 4. The order/receive engine
-- ------------------------------------------------------------

create or replace function public.create_purchase_order(
  p_supplier uuid,
  p_lines    jsonb,          -- [{material_id, qty, unit_cost}]
  p_expected date default null,
  p_branch   uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_branch uuid;
  v_po     uuid;
  v_line   jsonb;
  v_mat    uuid;
  v_qty    numeric;
  v_cost   numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  v_branch := public.resolve_branch(p_branch);

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'A purchase order needs at least one line.';
  end if;
  perform public.assert_same_tenant('suppliers', p_supplier);

  insert into purchase_orders(tenant_id, branch_id, supplier_id, purchase_date, doc_no, status, expected_date, ordered_at, created_by)
  values (v_tenant, v_branch, p_supplier, current_date, public.next_doc_no(v_tenant, 'PO'), 'ordered', p_expected, now(), auth.uid())
  returning id into v_po;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    v_mat  := (v_line->>'material_id')::uuid;
    v_qty  := (v_line->>'qty')::numeric;
    v_cost := (v_line->>'unit_cost')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every line needs a quantity above zero.'; end if;
    if v_cost is null or v_cost < 0 then raise exception 'Cost can''t be negative.'; end if;
    perform public.assert_same_tenant('materials', v_mat);

    insert into purchase_order_lines(tenant_id, purchase_order_id, material_id, qty_ordered, unit_cost)
    values (v_tenant, v_po, v_mat, v_qty, v_cost);
  end loop;

  return v_po;
end $$;

-- Records what actually arrived. Can be called more than once for the
-- same order (a partial delivery, then the rest later) — each call is
-- its own GRN and its own FIFO layers, never mixed together.
create or replace function public.receive_purchase_order(
  p_po    uuid,
  p_lines jsonb,     -- [{line_id, qty, unit_cost?, supplier_batch_no?, expiry_date?}]
  p_date  date default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_po_row   record;
  v_gr       uuid;
  v_doc_no   text;
  v_line     jsonb;
  v_pol      record;
  v_qty      numeric;
  v_cost     numeric;
  v_amount   numeric;
  v_received numeric := 0;
  v_fully    boolean;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('admin', 'inventory') then
    raise exception 'Your role is not allowed to receive a purchase order.' using errcode = 'insufficient_privilege';
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — receiving is read-only until billing is sorted out.';
  end if;

  select * into v_po_row from purchase_orders where id = p_po and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase order not found.'; end if;
  if v_po_row.status not in ('ordered', 'partial') then
    raise exception 'This purchase order is % — there''s nothing left to receive.', v_po_row.status;
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Receiving needs at least one line.';
  end if;

  v_doc_no := public.next_doc_no(v_tenant, 'GRN');
  insert into goods_receipts(tenant_id, branch_id, purchase_order_id, doc_no, received_at, received_by)
  values (v_tenant, v_po_row.branch_id, p_po, v_doc_no, coalesce(p_date::timestamptz, now()), auth.uid())
  returning id into v_gr;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    select * into v_pol from purchase_order_lines
     where id = (v_line->>'line_id')::uuid and purchase_order_id = p_po and tenant_id = v_tenant
     for update;
    if not found then raise exception 'That line does not belong to this purchase order.'; end if;

    v_qty := (v_line->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every received line needs a quantity above zero.'; end if;
    if v_qty > (v_pol.qty_ordered - v_pol.qty_received) then
      raise exception 'Only % still expected on this line — % was ordered, % already received.',
        v_pol.qty_ordered - v_pol.qty_received, v_pol.qty_ordered, v_pol.qty_received;
    end if;
    v_cost := coalesce((v_line->>'unit_cost')::numeric, v_pol.unit_cost);
    if v_cost < 0 then raise exception 'Cost can''t be negative.'; end if;
    v_amount   := v_qty * v_cost;
    v_received := v_received + v_amount;

    update purchase_order_lines set qty_received = qty_received + v_qty where id = v_pol.id;

    insert into purchase_items(tenant_id, purchase_order_id, material_id, qty, qty_remaining, cost_price, amount,
                               branch_id, origin, supplier_batch_no, expiry_date, goods_receipt_id, po_line_id)
    values (v_tenant, p_po, v_pol.material_id, v_qty, v_qty, v_cost, v_amount, v_po_row.branch_id, 'purchase',
            nullif(trim(v_line->>'supplier_batch_no'), ''), nullif(v_line->>'expiry_date', '')::date, v_gr, v_pol.id);

    update materials set qty_balance = qty_balance + v_qty where id = v_pol.material_id and tenant_id = v_tenant;

    insert into stock_movements(tenant_id, branch_id, product_kind, product_id, movement_type, quantity, reference_id, user_id)
    values (v_tenant, v_po_row.branch_id, 'material', v_pol.material_id, 'PURCHASE', v_qty, v_gr, auth.uid());
  end loop;

  select not exists (
    select 1 from purchase_order_lines where purchase_order_id = p_po and qty_received < qty_ordered
  ) into v_fully;

  update purchase_orders
     set status = case when v_fully then 'received' else 'partial' end,
         total_amount = total_amount + v_received,
         balance = balance + v_received
   where id = p_po;

  if v_fully and v_po_row.ordered_at is not null then
    update suppliers set lead_time_days = greatest(0, extract(day from (now() - v_po_row.ordered_at))::int)
     where id = v_po_row.supplier_id and tenant_id = v_tenant;
  end if;

  perform public.log_audit('goods_received', 'purchase_orders', p_po::text,
    jsonb_build_object('grn', v_doc_no, 'value', v_received));

  return v_gr;
end $$;

-- Stops an order from receiving any more — whatever already arrived
-- (a partial receipt) stays exactly as it is; only the unreceived
-- remainder is cancelled.
create or replace function public.cancel_purchase_order(p_po uuid, p_reason text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('admin', 'inventory') then
    raise exception 'Your role is not allowed to cancel a purchase order.' using errcode = 'insufficient_privilege';
  end if;
  select status into v_status from purchase_orders where id = p_po and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase order not found.'; end if;
  if v_status not in ('ordered', 'partial') then
    raise exception 'Only an order that''s still ordered or partially received can be cancelled.';
  end if;
  update purchase_orders set status = 'cancelled' where id = p_po;
  perform public.log_audit('purchase_order_cancelled', 'purchase_orders', p_po::text, jsonb_build_object('reason', p_reason));
end $$;


-- ------------------------------------------------------------
-- 5. Advance payments — a supplier can be paid ahead of receiving goods.
--    A negative balance is the intended signal for "supplier owes you
--    goods," so the old "can't pay more than the balance" cap is gone.
-- ------------------------------------------------------------

create or replace function public.record_purchase_payment(
  p_purchase     uuid,
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
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_amount is null or p_amount <= 0 then
    raise exception 'A payment has to be more than zero.';
  end if;
  perform public.assert_same_tenant('payment_types', p_payment_type);

  select * into v_row from purchase_orders where id = p_purchase and tenant_id = v_tenant for update;
  if not found then raise exception 'Purchase not found.'; end if;
  if v_row.voided then raise exception 'This purchase has been voided — it can''t take a payment.'; end if;

  insert into purchase_payments(tenant_id, purchase_order_id, payment_date, amount_paid, payment_type_id, reference, notes)
  values (v_tenant, p_purchase, current_date, p_amount, p_payment_type, p_reference, p_notes);

  select coalesce(sum(amount_paid), 0) into v_paid
    from purchase_payments where purchase_order_id = p_purchase and tenant_id = v_tenant;
  v_status := case when v_paid <= 0 then 'unpaid'
                   when v_paid >= v_row.total_amount then 'full'
                   else 'part' end;

  update purchase_orders
     set total_paid = v_paid, balance = v_row.total_amount - v_paid, payment_status = v_status
   where id = p_purchase and tenant_id = v_tenant;
end $$;
