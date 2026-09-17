-- ============================================================
-- StockFlow — Delivery notes and waybills (Phase 6d)
--
-- Stock still leaves at the point of sale, exactly as it always has —
-- deliveries only track paperwork and status from there. A delivery note
-- is proof of what left for delivery and what a customer signed for; it
-- never touches stock_movements, fg_batches, or anything cost-related.
--
-- A sale can have more than one delivery note (a partial dispatch, then
-- the rest later) — delivery_items tracks how much of each sold line has
-- been claimed by a (non-failed) delivery note so far, the same
-- "remaining to deliver" idea Phase 6b uses for "remaining to receive."
-- ============================================================


-- ------------------------------------------------------------
-- 1. Schema
-- ------------------------------------------------------------

create table if not exists deliveries (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references tenants(id) on delete cascade,
  branch_id       uuid not null references branches(id),
  sales_order_id  uuid not null references sales_orders(id) on delete cascade,
  doc_no          text,
  driver_name     text,
  vehicle_no      text,
  destination     text,
  status          text not null default 'pending' check (status in ('pending', 'dispatched', 'delivered', 'failed')),
  dispatched_at   timestamptz,
  delivered_at    timestamptz,
  received_by_name text,
  proof_url       text,
  note            text,
  created_by      uuid references auth.users(id),
  created_at      timestamptz not null default now()
);
create unique index if not exists uq_deliveries_doc_no on deliveries (tenant_id, doc_no) where doc_no is not null;
create index if not exists idx_deliveries_sale   on deliveries (sales_order_id);
create index if not exists idx_deliveries_branch on deliveries (tenant_id, branch_id);

create table if not exists delivery_items (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid not null references tenants(id) on delete cascade,
  delivery_id   uuid not null references deliveries(id) on delete cascade,
  sale_item_id  uuid not null references sale_items(id) on delete restrict,
  qty           numeric(14,3) not null check (qty > 0)
);
create index if not exists idx_delivery_items_delivery on delivery_items (delivery_id);


-- ------------------------------------------------------------
-- 2. RLS — deliveries has no write policy at all (only the RPCs below
--    write it, each with its own explicit role check, same style as
--    receive_purchase_order/cancel_purchase_order); delivery_items is a
--    plain child table.
-- ------------------------------------------------------------

alter table deliveries enable row level security;
drop policy if exists deliveries_read on deliveries;
create policy deliveries_read on deliveries for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales', 'accounts')
         and public.can_see_branch(branch_id));

alter table delivery_items enable row level security;
drop policy if exists delivery_items_read on delivery_items;
create policy delivery_items_read on delivery_items for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales', 'accounts')
         and exists (select 1 from deliveries d where d.id = delivery_id and public.can_see_branch(d.branch_id)));


-- ------------------------------------------------------------
-- 3. Proof-of-delivery photos — private bucket, confined to the caller's
--    own tenant folder from the start (logos shipped without this and
--    needed a follow-up fix in 0019; this one gets it immediately).
-- ------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('delivery-proofs', 'delivery-proofs', false)
on conflict (id) do nothing;

drop policy if exists "delivery-proofs read" on storage.objects;
create policy "delivery-proofs read" on storage.objects for select to authenticated
  using (bucket_id = 'delivery-proofs' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

drop policy if exists "delivery-proofs write" on storage.objects;
create policy "delivery-proofs write" on storage.objects for insert to authenticated
  with check (bucket_id = 'delivery-proofs' and (storage.foldername(name))[1] = public.current_tenant_id()::text);

drop policy if exists "delivery-proofs update" on storage.objects;
create policy "delivery-proofs update" on storage.objects for update to authenticated
  using (bucket_id = 'delivery-proofs' and (storage.foldername(name))[1] = public.current_tenant_id()::text)
  with check (bucket_id = 'delivery-proofs' and (storage.foldername(name))[1] = public.current_tenant_id()::text);


-- ------------------------------------------------------------
-- 4. The engine — paperwork and status only, nothing here ever touches
--    stock_movements, fg_batches, or qty_balance.
-- ------------------------------------------------------------

create or replace function public.create_delivery_note(
  p_sale         uuid,
  p_items        jsonb,        -- [{sale_item_id, qty}]
  p_driver_name  text default null,
  p_vehicle_no   text default null,
  p_destination  text default null,
  p_note         text default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_so       record;
  v_delivery uuid;
  v_doc_no   text;
  v_item     jsonb;
  v_si       record;
  v_qty      numeric;
  v_already  numeric;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if not public.has_role('admin', 'sales') then
    raise exception 'Your role is not allowed to create a delivery note.' using errcode = 'insufficient_privilege';
  end if;
  if not public.tenant_is_live() then
    raise exception 'This account is suspended or its plan has expired — deliveries are read-only until billing is sorted out.';
  end if;

  select * into v_so from sales_orders where id = p_sale and tenant_id = v_tenant;
  if not found then raise exception 'Sale not found.'; end if;
  if v_so.voided then raise exception 'This sale has been voided.'; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A delivery note needs at least one item.';
  end if;

  v_doc_no := public.next_doc_no(v_tenant, 'DN');
  insert into deliveries (tenant_id, branch_id, sales_order_id, doc_no, driver_name, vehicle_no, destination, note, created_by)
  values (v_tenant, v_so.branch_id, p_sale, v_doc_no,
          nullif(trim(p_driver_name), ''), nullif(trim(p_vehicle_no), ''), nullif(trim(p_destination), ''), nullif(trim(p_note), ''),
          auth.uid())
  returning id into v_delivery;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    select * into v_si from sale_items where id = (v_item->>'sale_item_id')::uuid and sales_order_id = p_sale and tenant_id = v_tenant;
    if not found then raise exception 'That line does not belong to this sale.'; end if;

    v_qty := (v_item->>'qty')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every delivery line needs a quantity above zero.'; end if;

    select coalesce(sum(di.qty), 0) into v_already
      from delivery_items di join deliveries d on d.id = di.delivery_id
     where di.sale_item_id = v_si.id and d.status <> 'failed';
    if v_qty > (v_si.quantity - v_already) then
      raise exception 'Only % still to deliver on this line — % was sold, % already on a delivery note.',
        v_si.quantity - v_already, v_si.quantity, v_already;
    end if;

    insert into delivery_items (tenant_id, delivery_id, sale_item_id, qty) values (v_tenant, v_delivery, v_si.id, v_qty);
  end loop;

  return v_delivery;
end $$;

create or replace function public.dispatch_delivery(p_delivery uuid, p_driver_name text default null, p_vehicle_no text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  if not public.has_role('admin', 'sales') then
    raise exception 'Your role is not allowed to dispatch a delivery.' using errcode = 'insufficient_privilege';
  end if;
  select status into v_status from deliveries where id = p_delivery and tenant_id = v_tenant for update;
  if not found then raise exception 'Delivery note not found.'; end if;
  if v_status <> 'pending' then raise exception 'Only a pending delivery can be dispatched.'; end if;
  update deliveries
     set status = 'dispatched', dispatched_at = now(),
         driver_name = coalesce(nullif(trim(p_driver_name), ''), driver_name),
         vehicle_no  = coalesce(nullif(trim(p_vehicle_no), ''), vehicle_no)
   where id = p_delivery;
end $$;

create or replace function public.mark_delivery_delivered(p_delivery uuid, p_received_by_name text default null, p_proof_url text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  if not public.has_role('admin', 'sales') then
    raise exception 'Your role is not allowed to update a delivery.' using errcode = 'insufficient_privilege';
  end if;
  select status into v_status from deliveries where id = p_delivery and tenant_id = v_tenant for update;
  if not found then raise exception 'Delivery note not found.'; end if;
  if v_status <> 'dispatched' then raise exception 'Only a dispatched delivery can be marked delivered.'; end if;
  update deliveries
     set status = 'delivered', delivered_at = now(),
         received_by_name = nullif(trim(p_received_by_name), ''), proof_url = nullif(trim(p_proof_url), '')
   where id = p_delivery;
end $$;

create or replace function public.mark_delivery_failed(p_delivery uuid, p_note text default null)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_status text;
begin
  if not public.has_role('admin', 'sales') then
    raise exception 'Your role is not allowed to update a delivery.' using errcode = 'insufficient_privilege';
  end if;
  select status into v_status from deliveries where id = p_delivery and tenant_id = v_tenant for update;
  if not found then raise exception 'Delivery note not found.'; end if;
  if v_status not in ('pending', 'dispatched') then raise exception 'Only a pending or dispatched delivery can be marked failed.'; end if;
  update deliveries set status = 'failed', note = coalesce(nullif(trim(p_note), ''), note) where id = p_delivery;
end $$;
