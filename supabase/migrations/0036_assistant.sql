-- ============================================================
-- StockFlow — Ask StockFlow, an AI assistant over the app's own data
-- (Phase 7b, closing out the original seven-phase plan)
--
-- The model never touches the database directly and is never trusted
-- with a figure of its own — it only calls the same read-only RPCs the
-- rest of the app already uses (dashboard_summary, stock_levels,
-- reorder_suggestions, batch_trace, report_product_profitability,
-- report_returns, report_discounts), through a Supabase client built
-- from the ASKING USER'S OWN JWT (see the assistant Edge Function). That
-- means a cashier asking "how much should I reorder?" gets the RPC's own
-- "your role isn't allowed to view reorder suggestions" error relayed
-- back honestly, exactly as if they'd tried it from the UI — no branch or
-- role restriction is bypassed just because a model is asking on their
-- behalf.
--
-- Unlike custom fields/audit logging/reorder (Phases 6e/6f/7a — not
-- DB-plan-gated, since none of them cost StockFlow anything to run), a
-- question here has a real per-call cost against the Anthropic API. That
-- marginal cost is why this is the one Phase 6+ feature that DOES call
-- require_feature() again, matching Phases 0–3's original enforcement
-- pattern rather than the newer UI-only-gating one.
-- ============================================================


-- ------------------------------------------------------------
-- 1. A monthly question budget per business
-- ------------------------------------------------------------

alter table tenants add column if not exists assistant_monthly_limit int not null default 100;

create table if not exists assistant_usage (
  tenant_id      uuid not null references tenants(id) on delete cascade,
  month          date not null,   -- always the 1st of the month
  question_count int  not null default 0,
  primary key (tenant_id, month)
);

alter table assistant_usage enable row level security;
drop policy if exists assistant_usage_read on assistant_usage;
create policy assistant_usage_read on assistant_usage for select
  using (tenant_id = public.current_tenant_id() and public.has_role('admin', 'accounts'));
-- No write policy — only check_and_record_assistant_question() (below)
-- ever changes it.


-- ------------------------------------------------------------
-- 2. Quota check + read
-- ------------------------------------------------------------

-- Read-only: lets the frontend show "N questions left this month" (and
-- whether the plan even includes the assistant) without spending a
-- question just to find out.
create or replace function public.assistant_quota()
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_limit  int;
  v_month  date := date_trunc('month', current_date)::date;
  v_used   int;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  select assistant_monthly_limit into v_limit from tenants where id = v_tenant;
  select question_count into v_used from assistant_usage where tenant_id = v_tenant and month = v_month;
  return jsonb_build_object(
    'enabled', public.tenant_has_feature('assistant'),
    'used', coalesce(v_used, 0), 'limit', v_limit, 'remaining', greatest(0, v_limit - coalesce(v_used, 0))
  );
end $$;

-- Called once per question, BEFORE the Edge Function spends anything on
-- Claude — a rejected question never reaches the API.
create or replace function public.check_and_record_assistant_question()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid := public.current_tenant_id();
  v_limit  int;
  v_month  date := date_trunc('month', current_date)::date;
  v_used   int;
begin
  if v_tenant is null then raise exception 'No tenant context'; end if;
  perform public.require_feature('assistant', 'The AI assistant');

  select assistant_monthly_limit into v_limit from tenants where id = v_tenant;

  insert into assistant_usage (tenant_id, month, question_count)
  values (v_tenant, v_month, 1)
  on conflict (tenant_id, month) do update set question_count = assistant_usage.question_count + 1
  returning question_count into v_used;

  if v_used > v_limit then
    -- Raising here rolls back the increment above too (same statement's
    -- transaction), so a rejected question never actually counts against
    -- next month's budget either — the stored count never exceeds the limit.
    raise exception 'This business has used all % assistant questions for this month — it resets on the 1st.', v_limit
      using errcode = 'check_violation';
  end if;

  return jsonb_build_object('used', v_used, 'limit', v_limit, 'remaining', greatest(0, v_limit - v_used));
end $$;
