-- ============================================================
-- StockFlow — Branches support
--  • branches was missed by the 0004 auto-tenant-stamp trigger —
--    add it so the client never has to send tenant_id explicitly.
-- Run AFTER 0001–0012.
-- ============================================================

drop trigger if exists trg_set_tenant on branches;
create trigger trg_set_tenant before insert on branches
  for each row execute function public.set_tenant_id();
