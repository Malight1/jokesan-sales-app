-- ============================================================
-- StockFlow — Quotes and proforma invoices (Phase 6a)
--
-- Until now the only way to give a customer a price ahead of a sale was
-- to ring it up as a real sale — which moves stock and money for
-- something that might not even happen. Quotes are a document of their
-- own: they never touch stock, and become a real sale only when
-- convert_quote() is called.
--
-- 'quote' and 'proforma' are the same table and the same engine — kind
-- only changes what the PDF is titled and whether bank details print on
-- it (a proforma is what a buyer's finance team asks for before wiring
-- money; a quote is a plain price estimate).
--
-- Scope note: unlike a sale, a quote's price isn't put through the same
-- discount-limit/manager-PIN gate at creation — whatever unit_price the
-- creator enters is simply recorded (resolve_price() still previews the
-- list price so the discount is visible). That gate applies at
-- convert_quote() time instead, via the ordinary create_sale() call, so a
-- steep quote can still need a PIN when it's actually converted — the
-- plan's "no second PIN" note doesn't fully hold. Building a parallel
-- approval flow for a document that isn't money yet wasn't worth it here;
-- flagged in HANDOVER.md.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Schema
-- ------------------------------------------------------------

alter table tenants add column if not exists bank_details jsonb not null default '{}'::jsonb;

create table if not exists quotes (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  branch_id         uuid not null references branches(id),
  doc_no            text,
  customer_id       uuid references customers(id) on delete set null,
  kind              text not null default 'quote' check (kind in ('quote', 'proforma')),
  issue_date        date not null default current_date,
  valid_until       date,
  status            text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'converted', 'cancelled')),
  subtotal          numeric(14,2) not null default 0,
  list_value        numeric(14,2) not null default 0,
  discount_total    numeric(14,2) not null default 0,
  vat_rate          numeric(5,2) not null default 0,
  vat_amount        numeric(14,2) not null default 0,
  total             numeric(14,2) not null default 0,
  notes             text,
  terms             text,
  converted_sale_id uuid references sales_orders(id),
  created_by        uuid references auth.users(id),
  created_at        timestamptz not null default now()
);
create unique index if not exists uq_quotes_doc_no on quotes (tenant_id, doc_no) where doc_no is not null;
create index if not exists idx_quotes_branch on quotes (tenant_id, branch_id);

create table if not exists quote_items (
  id                uuid primary key default gen_random_uuid(),
  tenant_id         uuid not null references tenants(id) on delete cascade,
  quote_id          uuid not null references quotes(id) on delete cascade,
  finished_good_id  uuid not null references finished_goods(id) on delete restrict,
  quantity          numeric(14,3) not null,
  list_price        numeric(14,2) not null default 0,
  unit_price        numeric(14,2) not null,
  discount_amount   numeric(14,2) not null default 0,
  amount            numeric(14,2) not null default 0
);
create index if not exists idx_quote_items_quote on quote_items (quote_id);


-- ------------------------------------------------------------
-- 2. RLS — same shape as sales_orders: branch-scoped read, written only
--    through the engine below (child table gets no write policy at all).
-- ------------------------------------------------------------

alter table quotes       enable row level security;
alter table quote_items  enable row level security;

drop policy if exists quotes_read on quotes;
create policy quotes_read on quotes for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales', 'accounts')
         and public.can_see_branch(branch_id));

drop policy if exists quote_items_read on quote_items;
create policy quote_items_read on quote_items for select
  using (tenant_id = public.current_tenant_id() and public.has_role('sales', 'accounts')
         and exists (select 1 from quotes q where q.id = quote_id and public.can_see_branch(q.branch_id)));

drop trigger if exists trg_guard_write on quotes;
create trigger trg_guard_write before insert on quotes
  for each row execute function public.guard_money_write('admin,sales', 'create a quote');


-- ------------------------------------------------------------
-- 3. The engine
-- ------------------------------------------------------------

create or replace function public.create_quote(
  p_customer   uuid,
  p_kind       text,
  p_items      jsonb,
  p_valid_until date default null,
  p_notes      text default null,
  p_terms      text default null,
  p_branch     uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant   uuid := public.current_tenant_id();
  v_branch   uuid;
  v_quote    uuid;
  v_doc_no   text;
  v_vat_rate numeric := 0;
  v_item     jsonb;
  v_fg       uuid;
  v_qty      numeric;
  v_price    numeric;
  v_list     uuid;
  v_list_price numeric;
  v_line     numeric;
  v_subtotal numeric := 0;
  v_list_value numeric := 0;
  v_discount numeric := 0;
  v_vat      numeric := 0;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if p_kind not in ('quote', 'proforma') then raise exception 'Unknown document kind %.', p_kind; end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'A quote needs at least one item.';
  end if;
  v_branch := public.resolve_branch(p_branch);

  select case when vat_enabled then coalesce(vat_rate, 0) else 0 end into v_vat_rate
    from tenants where id = v_tenant;

  v_doc_no := public.next_doc_no(v_tenant, case when p_kind = 'proforma' then 'PF' else 'QT' end);

  insert into quotes (tenant_id, branch_id, doc_no, customer_id, kind, valid_until, notes, terms, created_by)
  values (v_tenant, v_branch, v_doc_no, p_customer, p_kind, p_valid_until, p_notes, p_terms, auth.uid())
  returning id into v_quote;

  for v_item in select * from jsonb_array_elements(p_items)
  loop
    v_fg    := (v_item->>'finished_good_id')::uuid;
    v_qty   := (v_item->>'quantity')::numeric;
    v_price := (v_item->>'unit_price')::numeric;
    if v_qty is null or v_qty <= 0 then raise exception 'Every quote line needs a quantity above zero.'; end if;
    if v_price is null or v_price < 0 then raise exception 'Price can''t be negative.'; end if;
    perform public.assert_same_tenant('finished_goods', v_fg);

    select rp.unit_price, rp.price_list_id into v_list_price, v_list from public.resolve_price(v_fg, p_customer, v_qty) rp;
    v_line := v_qty * v_price;
    v_subtotal   := v_subtotal + v_line;
    v_list_value := v_list_value + (v_qty * v_list_price);
    v_discount   := v_discount + greatest((v_qty * v_list_price) - v_line, 0);

    insert into quote_items (tenant_id, quote_id, finished_good_id, quantity, list_price, unit_price, discount_amount, amount)
    values (v_tenant, v_quote, v_fg, v_qty, v_list_price, v_price, greatest((v_qty * v_list_price) - v_line, 0), v_line);
  end loop;

  v_vat := round(v_subtotal * v_vat_rate / 100, 2);

  update quotes
     set subtotal = v_subtotal, list_value = v_list_value, discount_total = v_discount,
         vat_rate = v_vat_rate, vat_amount = v_vat, total = v_subtotal + v_vat
   where id = v_quote;

  return v_quote;
end $$;

-- Draft → sent/accepted/declined/cancelled. A converted quote can never
-- move again — its sale is the record from here on.
create or replace function public.update_quote_status(p_quote uuid, p_status text)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_current text;
begin
  if not public.has_role('admin', 'sales') then
    raise exception 'Your role is not allowed to update a quote.' using errcode = 'insufficient_privilege';
  end if;
  if p_status not in ('draft', 'sent', 'accepted', 'declined', 'cancelled') then
    raise exception 'Unknown status %.', p_status;
  end if;
  select status into v_current from quotes where id = p_quote and tenant_id = v_tenant for update;
  if not found then raise exception 'Quote not found.'; end if;
  if v_current = 'converted' then raise exception 'This quote has already been converted to a sale.'; end if;
  update quotes set status = p_status where id = p_quote;
end $$;

-- Turns a quote into a real sale at the quoted prices. Discounts and any
-- customer/date on the quote carry through unchanged; if stock has moved
-- since the quote was made, create_sale's own "only N left" error names
-- exactly what's short.
create or replace function public.convert_quote(
  p_quote        uuid,
  p_amount_paid  numeric default 0,
  p_payment_type uuid default null,
  p_branch       uuid default null,
  p_approval     jsonb default null   -- {"user_id": "...", "pin": "1234"}, only when the quote's discount is over the converting user's limit
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_quote  record;
  v_items  jsonb;
  v_sale   uuid;
begin
  select * into v_quote from quotes where id = p_quote and tenant_id = v_tenant for update;
  if not found then raise exception 'Quote not found.'; end if;
  if v_quote.status = 'converted' then raise exception 'This quote has already been converted.'; end if;
  if v_quote.status in ('declined', 'cancelled') then
    raise exception 'A %s quote can''t be converted — create a new one instead.', v_quote.status;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'finished_good_id', finished_good_id, 'quantity', quantity, 'unit_price', unit_price
         )), '[]'::jsonb)
    into v_items
    from quote_items where quote_id = p_quote;

  v_sale := public.create_sale(
    p_customer := v_quote.customer_id, p_date := current_date, p_payment_type := p_payment_type,
    p_amount_paid := coalesce(p_amount_paid, 0), p_items := v_items,
    p_branch := coalesce(p_branch, v_quote.branch_id), p_approval := p_approval
  );

  update quotes set status = 'converted', converted_sale_id = v_sale where id = p_quote;
  perform public.log_audit('quote_converted', 'quotes', p_quote::text, jsonb_build_object('sale_id', v_sale));

  return v_sale;
end $$;
