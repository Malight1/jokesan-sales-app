-- ============================================================
-- StockFlow — remove three test accounts and everything under them.
-- NOT a migration: run this ONCE, by hand, in the Supabase SQL editor.
--
-- Looked each one up in Platform Admin > Tenants before writing this,
-- so there's no ambiguity about what's being deleted:
--
--   oguntunde722@gmail.com  -> "Olooba Store"   (39d968e0-32fb-4133-8a4a-9aadc267b6db), Trial, joined 30/06/2026
--   mubby722@gmail.com      -> "Joke"           (3c937548-064c-4831-8f6d-fe4edb71e0b6), Trial, joined 16/07/2026
--   oguntunde098@gmail.com  -> "Caring Strore"  (e7a8a6aa-f67f-4bdb-bee3-0b0317a641be), Trial, joined 20/09/2026
--
-- All three are single-admin trial shells with zero sales and zero
-- payments recorded, so there's no real business data at stake — but
-- this is still irreversible, so double check the emails/names above
-- against your own Platform Admin > Tenants list before running.
--
-- Two deletes per account, in this order:
--   1. delete from tenants  -- cascades: profiles, branches, products,
--      sales, purchases, everything else scoped to that tenant (this is
--      the same cascade migration 0044 fixed so it no longer fails on
--      its own audit log entry).
--   2. delete from auth.users -- the tenant delete does NOT remove the
--      login itself (profiles.id -> auth.users cascades the OTHER way).
--      Without this the email stays "already registered" and can't be
--      used to sign up again.
--
-- Left alone: "StockFlow Demo Store" and "Easycomp" (real transaction
-- history) and the OTHER "Olooba Store" (admin oloobamubby@gmail.com —
-- a different account you didn't name).
-- ============================================================

begin;

delete from tenants where id in (
  '39d968e0-32fb-4133-8a4a-9aadc267b6db', -- Olooba Store / oguntunde722@gmail.com
  '3c937548-064c-4831-8f6d-fe4edb71e0b6', -- Joke / mubby722@gmail.com
  'e7a8a6aa-f67f-4bdb-bee3-0b0317a641be'  -- Caring Strore / oguntunde098@gmail.com
);

delete from auth.users where email in (
  'oguntunde722@gmail.com',
  'mubby722@gmail.com',
  'oguntunde098@gmail.com'
);

commit;
