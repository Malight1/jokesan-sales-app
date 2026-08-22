-- ============================================================
-- StockFlow — Lock down the sample-data seeder
--
-- 0003 ended with:
--     grant execute on function public.seed_sample_data() to authenticated;
--
-- which meant ANY signed-in user of ANY tenant could seed the Jokesan
-- starter set — including its real contact rows (Shakirat Oguntunde /
-- Easycomp Tech, Bola Adesanya) — straight into their own live customer
-- and supplier lists. The "Load Sample Data" button on the Raw Materials
-- page called exactly that. Both that button and its client wrapper in
-- src/lib/api.ts have been removed.
--
-- This migration closes the RPC itself, so the endpoint can't be reached
-- directly through PostgREST either.
--
-- Sample/demo data now lives in ONE place: the pitch account
-- oguntunde123@gmail.com, seeded by hand from the Supabase SQL Editor via
-- 0006's seed_demo_data_for(email) — which takes the target email as an
-- explicit argument and is already revoked from every browser role.
--
-- Run AFTER 0001–0014.
-- ============================================================

-- Same lockdown pattern 0006 uses for seed_demo_data_for(text).
-- After this, only the postgres role (i.e. the SQL Editor) can execute it.
revoke execute on function public.seed_sample_data() from public;
revoke execute on function public.seed_sample_data() from anon;
revoke execute on function public.seed_sample_data() from authenticated;

-- Note: seed_sample_data() seeds whatever tenant the CALLER belongs to,
-- via current_tenant_id(), which reads the JWT. The SQL Editor has no JWT,
-- so running it there raises 'No tenant context' — by design. To load the
-- pitch account, use 0006 instead:
--
--     select public.seed_demo_data_for('oguntunde123@gmail.com');
--
-- If you decide you never want this function back, drop it outright:
--
--     drop function if exists public.seed_sample_data();
