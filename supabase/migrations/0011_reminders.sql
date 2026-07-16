-- ============================================================
-- StockFlow — Debtor reminder tracking
--  • customers.last_reminded_at lets the app build a "who's due
--    for a reminder today" queue without nagging the same debtor
--    every day. No RPC needed — customers already has a generic
--    tenant-isolation "for all" policy from 0001, so a direct
--    client update works under RLS.
-- Run AFTER 0001–0010.
-- ============================================================

alter table customers add column if not exists last_reminded_at timestamptz;
