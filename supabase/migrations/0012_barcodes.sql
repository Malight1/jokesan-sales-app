-- ============================================================
-- StockFlow — Barcode scanning support
--  • barcode column on materials + finished_goods
--  • unique per tenant (two products in the same business can't
--    share a barcode; different tenants can, since barcodes on
--    generic/no-name packaging are often reused across suppliers)
-- Run AFTER 0001–0011.
-- ============================================================

alter table materials       add column if not exists barcode text;
alter table finished_goods  add column if not exists barcode text;

create unique index if not exists idx_materials_barcode_tenant
  on materials (tenant_id, barcode) where barcode is not null;

create unique index if not exists idx_finished_goods_barcode_tenant
  on finished_goods (tenant_id, barcode) where barcode is not null;
