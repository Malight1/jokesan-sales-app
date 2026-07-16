-- ============================================================
-- StockFlow — prevent duplicate pending invites for the same
-- email within a tenant (defense in depth behind the client-side
-- check in Settings > Team; also catches double-click/multi-tab
-- races the client check can't).
-- Run AFTER 0001–0013.
-- ============================================================

create unique index if not exists idx_invites_unique_pending
  on staff_invites (tenant_id, lower(email)) where status = 'pending';
