-- ============================================================
-- StockFlow — Two smaller launch blockers
--
--  1. The Business plan charges the customer and then fails.
--     src/lib/api.ts sells plan id 'business' at ₦45,000, but plan_tier is
--     ('trial','starter','growth','enterprise'). Paystack takes the money,
--     paystack-verify calls activate_subscription('business'), Postgres
--     rejects the enum cast, and the customer ends up charged with no plan.
--     Confirmed live against the project:
--       invalid input value for enum plan_tier: "business"
--
--  2. Any signed-in user can overwrite any company's logo. The storage
--     policy is `with check (bucket_id = 'logos')` with no path check,
--     while the convention is <tenant_id>/logo.png.
--
-- Run AFTER 0001–0018.
-- ============================================================


-- ------------------------------------------------------------
-- 1. Plan enum
-- ------------------------------------------------------------
-- Adding the value the app actually sells is the smaller change: renaming
-- the plan in the UI would orphan any tenant already on it, and 'enterprise'
-- is not a name that appears anywhere a customer can see.
--
-- NOTE: older Postgres refuses ALTER TYPE ... ADD VALUE inside a
-- transaction block. If the SQL Editor complains, run this one line on its
-- own before the rest of the file.
alter type plan_tier add value if not exists 'business';


-- ------------------------------------------------------------
-- 2. Logo uploads confined to the caller's own tenant folder
-- ------------------------------------------------------------
-- Path convention is '<tenant_id>/logo.<ext>', so the first path segment
-- must equal the caller's tenant. Reads stay public: logos are printed on
-- invoices and need to load without a session.
drop policy if exists "logos write"  on storage.objects;
drop policy if exists "logos update" on storage.objects;
drop policy if exists "logos delete" on storage.objects;

create policy "logos write" on storage.objects for insert to authenticated
  with check (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

create policy "logos update" on storage.objects for update to authenticated
  using (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  )
  with check (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );

create policy "logos delete" on storage.objects for delete to authenticated
  using (
    bucket_id = 'logos'
    and (storage.foldername(name))[1] = public.current_tenant_id()::text
  );
