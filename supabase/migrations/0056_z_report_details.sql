-- ============================================================
-- ProfixBook — a Z report that can be printed and sent to the owner.
-- Run AFTER 0001–0055.
--
-- z_report() (and close_shift(), which returns it) now also gives:
--   • names to print: business, branch, till, who opened and who closed;
--   • credit_given: what this till's sales left owing at the time, i.e.
--     the sales total minus what was paid for those sales on this till;
--   • the cash movements (pay-ins, pay-outs, drops) with their reasons.
-- A cashier can only open the Z report of a till they ran themselves.
-- ============================================================

create or replace function public.z_report(p_shift uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant  uuid := public.current_tenant_id();
  v_shift   record;
  v_sales   record;
  v_refunds numeric;
  v_paid    numeric;
  v_moves   jsonb;
begin
  if not public.has_role('sales','accounts') then
    raise exception 'Your role is not allowed to see till reports.' using errcode = 'insufficient_privilege';
  end if;
  select * into v_shift from shifts where id = p_shift and tenant_id = v_tenant;
  if not found then raise exception 'Shift not found.'; end if;
  if not public.can_see_branch(v_shift.branch_id) then
    raise exception 'You can''t see this branch''s tills.';
  end if;
  if public.real_role() = 'cashier' and v_shift.opened_by is distinct from auth.uid() then
    raise exception 'You can only see the till reports for tills you ran.' using errcode = 'insufficient_privilege';
  end if;
  if v_shift.status <> 'closed' then
    raise exception 'This till hasn''t been closed yet — use the X report while it''s open.';
  end if;

  select count(*) as n, coalesce(sum(total_amount), 0) as total, coalesce(sum(discount_total), 0) as discounts
    into v_sales
    from sales_orders where shift_id = p_shift and tenant_id = v_tenant and not voided;

  select coalesce(sum(-amount_paid), 0) into v_refunds
    from sale_payments where shift_id = p_shift and tenant_id = v_tenant and sale_return_id is not null;

  -- Paid on this till for this till's own sales (refunds excluded).
  select coalesce(sum(sp.amount_paid), 0) into v_paid
    from sale_payments sp
    join sales_orders so on so.id = sp.sales_order_id
   where sp.shift_id = p_shift and sp.tenant_id = v_tenant and sp.sale_return_id is null
     and so.shift_id = p_shift and not so.voided;

  select coalesce(jsonb_agg(jsonb_build_object('kind', kind, 'amount', amount, 'reason', reason) order by created_at), '[]'::jsonb)
    into v_moves
    from cash_movements where shift_id = p_shift and tenant_id = v_tenant;

  return jsonb_build_object(
    'shift_id', v_shift.id, 'doc_no', v_shift.doc_no, 'register_id', v_shift.register_id,
    'branch_id', v_shift.branch_id, 'opened_by', v_shift.opened_by, 'opened_at', v_shift.opened_at,
    'closed_by', v_shift.closed_by, 'closed_at', v_shift.closed_at, 'opening_float', v_shift.opening_float,
    'sales_count', v_sales.n, 'sales_total', v_sales.total, 'discount_total', v_sales.discounts,
    'refunds_total', v_refunds,
    'credit_given', greatest(v_sales.total - v_paid, 0),
    'cash_movements', v_moves,
    'expected', v_shift.expected, 'counted_cash', v_shift.counted_cash,
    'counted_breakdown', v_shift.counted_breakdown, 'variance', v_shift.variance, 'notes', v_shift.notes,
    'business_name', (select name from tenants where id = v_tenant),
    'branch_name', public.branch_name(v_shift.branch_id),
    'register_name', (select name from registers where id = v_shift.register_id),
    'opened_by_name', (select full_name from profiles where id = v_shift.opened_by),
    'closed_by_name', (select full_name from profiles where id = v_shift.closed_by)
  );
end $$;

grant execute on function public.z_report(uuid) to authenticated;
