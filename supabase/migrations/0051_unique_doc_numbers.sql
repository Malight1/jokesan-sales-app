-- ============================================================
-- ProfixBook — document numbers that are unique across every business.
-- Run AFTER 0001–0050.
--
-- Until now each business counted from INV-000001, so two shops on
-- ProfixBook handed their customers identical invoice numbers, and two
-- admins could type the same custom prefix in Settings. Within one
-- business numbers were already unique (a locked counter plus the
-- (tenant_id, doc_no) unique index from 0021); this closes the gap
-- between businesses.
--
-- Every business now has a short code of its own (MTS for Mama Tolu
-- Stores), and every document it issues carries it:
--     MTS-INV-000124   MTS-CN-000003   MTS-QT-000017   MTS-Z-000040 ...
-- A code belongs to one business forever: changing it later keeps the old
-- one reserved, so numbers already printed can never be reissued to
-- anyone else.
--
-- Nothing already issued changes (0021's trigger still forbids it). The
-- running count simply carries on with the new format. A business that had
-- branded its invoices as XYZ-INV- keeps XYZ as its code, so its numbers
-- carry on exactly as before.
--
-- The codes live in their own table, written only by the functions below.
-- (Business settings are saved with a direct update on tenants, so a code
-- stored there could be changed from the browser past these checks.)
-- ============================================================

create table if not exists doc_codes (
  code       text primary key,             -- e.g. MTS; never reused by another business
  tenant_id  uuid not null references tenants(id) on delete cascade,
  is_current boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_doc_codes_current on doc_codes (tenant_id) where is_current;

alter table doc_codes enable row level security;
drop policy if exists doc_codes_read on doc_codes;
create policy doc_codes_read on doc_codes for select using (tenant_id = public.current_tenant_id());
-- No write policies.

-- Document types themselves can't be codes (INV-INV-000001 would just confuse).
create or replace function public.doc_code_reserved(p_code text)
returns boolean language sql immutable as $$
  select upper(p_code) in ('INV', 'CN', 'QT', 'PF', 'PO', 'GRN', 'DN', 'SR', 'Z', 'PB')
$$;

-- A first guess from the business name: initials of up to three words, or
-- the first three letters of a one-word name. "Mama Tolu Stores" → MTS,
-- "Jokesan" → JOK.
create or replace function public.doc_code_base(p_name text)
returns text language plpgsql immutable as $$
declare
  v_words text[];
  v_base  text := '';
  w       text;
begin
  v_words := regexp_split_to_array(upper(regexp_replace(coalesce(p_name, ''), '[^A-Za-z0-9 ]', ' ', 'g')), '\s+');
  foreach w in array v_words loop
    if w <> '' and length(v_base) < 3 then v_base := v_base || left(w, 1); end if;
  end loop;
  if length(v_base) < 2 then
    v_base := left(regexp_replace(upper(coalesce(p_name, '')), '[^A-Z0-9]', '', 'g'), 3);
  end if;
  if length(v_base) < 2 or public.doc_code_reserved(v_base) then v_base := 'PB' || v_base; end if;
  return left(v_base, 4);
end $$;

-- Claims the first free code starting from p_base (MTS, MTS2, MTS3 ...).
-- Caller holds the per-business lock.
create or replace function public.claim_doc_code(p_tenant uuid, p_base text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_try text;
  i     int := 1;
begin
  loop
    v_try := case when i = 1 then p_base else left(p_base, 3) || i end;   -- MTS2 … MTS999, never over 6 characters
    if not public.doc_code_reserved(v_try) then
      insert into doc_codes (code, tenant_id, is_current) values (v_try, p_tenant, true)
      on conflict (code) do nothing;
      if found then return v_try; end if;
    end if;
    i := i + 1;
    if i > 999 then raise exception 'Could not find a free document code for this business.'; end if;
  end loop;
end $$;

-- The business's current code, claiming one the first time it's needed.
create or replace function public.doc_code_for(p_tenant uuid)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_code text;
begin
  select code into v_code from doc_codes where tenant_id = p_tenant and is_current;
  if v_code is not null then return v_code; end if;
  perform pg_advisory_xact_lock(hashtext('pfb_doc_code:' || p_tenant::text));
  select code into v_code from doc_codes where tenant_id = p_tenant and is_current;
  if v_code is not null then return v_code; end if;
  return public.claim_doc_code(p_tenant, public.doc_code_base((select name from tenants where id = p_tenant)));
end $$;

-- For Settings: what this business's documents start with.
create or replace function public.my_doc_code()
returns text language plpgsql security definer set search_path = public as $$
declare v_tenant uuid := public.current_tenant_id();
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  return public.doc_code_for(v_tenant);
end $$;

-- An admin can pick their own code (2–6 letters or numbers) if it's free.
create or replace function public.set_doc_code(p_code text)
returns text language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_code   text := upper(trim(coalesce(p_code, '')));
  v_owner  uuid;
  v_old    text;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  if public.current_role() <> 'admin' then
    raise exception 'Only an admin can change document numbering.' using errcode = 'insufficient_privilege';
  end if;
  if v_code !~ '^[A-Z0-9]{2,6}$' then
    raise exception 'Use 2 to 6 letters or numbers for the business code, like MTS.';
  end if;
  if public.doc_code_reserved(v_code) then
    raise exception '% is a document type, so it can''t be a business code. Try something else.', v_code;
  end if;

  perform pg_advisory_xact_lock(hashtext('pfb_doc_code:' || v_tenant::text));
  v_old := public.doc_code_for(v_tenant);
  if v_old = v_code then return v_code; end if;

  select tenant_id into v_owner from doc_codes where code = v_code;
  if v_owner is not null and v_owner <> v_tenant then
    raise exception 'The code % is already used by another business on ProfixBook. Pick a different one.', v_code;
  end if;

  update doc_codes set is_current = false where tenant_id = v_tenant and is_current;
  if v_owner = v_tenant then
    update doc_codes set is_current = true where code = v_code;   -- going back to one of its own old codes
  else
    insert into doc_codes (code, tenant_id, is_current) values (v_code, v_tenant, true);
  end if;
  perform public.log_audit('doc_code', 'doc_codes', v_code, jsonb_build_object('from', v_old, 'to', v_code));
  return v_code;
end $$;

-- 0021's prefix setting, kept so the Settings page already deployed keeps
-- working until the new one ships: "JKS-INV-" or "JKS-" now sets code JKS.
create or replace function public.set_doc_prefix(p_type text, p_prefix text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if public.current_role() <> 'admin' then
    raise exception 'Only an admin can change document numbering.' using errcode = 'insufficient_privilege';
  end if;
  perform public.set_doc_code(
    regexp_replace(upper(trim(coalesce(p_prefix, ''))), '[-/_]*(INV|CN|QT|PF|PO|GRN|DN|SR|Z)?[-/_]*$', ''));
end $$;

-- Issues the next number: CODE-TYPE-000123. Same gap-free counter as 0021
-- (a row UPDATE, so a rolled-back sale gives its number back); only the
-- front of the number changes.
create or replace function public.next_doc_no(p_tenant uuid, p_type text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  v_no   bigint;
  v_code text := public.doc_code_for(p_tenant);
begin
  insert into doc_sequences (tenant_id, doc_type, prefix, next_no)
  values (p_tenant, p_type, p_type || '-', 1)
  on conflict (tenant_id, doc_type) do nothing;

  update doc_sequences
     set next_no = next_no + 1
   where tenant_id = p_tenant and doc_type = p_type
  returning next_no - 1 into v_no;

  return v_code || '-' || p_type || '-' || case when v_no >= 1000000 then v_no::text else lpad(v_no::text, 6, '0') end;
end $$;

-- ------------------------------------------------------------
-- Give every existing business its code, oldest first. One that had
-- branded its invoices (XYZ-INV- or XYZ-) keeps XYZ, so its numbering
-- carries straight on.
-- ------------------------------------------------------------
do $$
declare
  r      record;
  v_pref text;
begin
  for r in select id, name from tenants order by created_at, id loop
    if exists (select 1 from doc_codes where tenant_id = r.id and is_current) then continue; end if;
    select upper(prefix) into v_pref from doc_sequences where tenant_id = r.id and doc_type = 'INV';
    v_pref := substring(coalesce(v_pref, '') from '^([A-Z0-9]{2,6})-(?:INV-)?$');
    if v_pref is not null and not public.doc_code_reserved(v_pref)
       and not exists (select 1 from doc_codes where code = v_pref) then
      insert into doc_codes (code, tenant_id, is_current) values (v_pref, r.id, true);
    else
      perform public.claim_doc_code(r.id, public.doc_code_base(r.name));
    end if;
  end loop;
end $$;

-- Belt and braces: the database itself refuses two invoices or credit
-- notes with the same new-style number anywhere on ProfixBook. (Old
-- INV-000123 numbers were only unique per business and are left alone.)
do $$
begin
  if not exists (select doc_no from sales_orders where doc_no ~ '^[A-Z0-9]{2,6}-INV-[0-9]+$' group by 1 having count(*) > 1) then
    create unique index if not exists uq_sales_orders_doc_no_global on sales_orders (doc_no)
      where doc_no ~ '^[A-Z0-9]{2,6}-INV-[0-9]+$';
  else
    raise notice 'Two businesses already share a branded invoice number; global invoice index skipped.';
  end if;
  if not exists (select doc_no from sale_returns where doc_no ~ '^[A-Z0-9]{2,6}-CN-[0-9]+$' group by 1 having count(*) > 1) then
    create unique index if not exists uq_sale_returns_doc_no_global on sale_returns (doc_no)
      where doc_no ~ '^[A-Z0-9]{2,6}-CN-[0-9]+$';
  else
    raise notice 'Two businesses already share a branded credit note number; global credit note index skipped.';
  end if;
end $$;

revoke execute on function public.claim_doc_code(uuid, text) from public, anon, authenticated;
revoke execute on function public.doc_code_for(uuid)         from public, anon, authenticated;
revoke execute on function public.next_doc_no(uuid, text)    from public, anon, authenticated;
grant  execute on function public.my_doc_code()              to authenticated;
grant  execute on function public.set_doc_code(text)         to authenticated;
grant  execute on function public.set_doc_prefix(text, text) to authenticated;
