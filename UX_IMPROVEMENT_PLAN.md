# StockFlow — UX Audit & Improvement Plan
**Date:** 30 June 2026 · Scope: the live multi-tenant app (11 pages)

> ## ✅ STATUS UPDATE — 6 July 2026
> **Phase 1 DONE:** DataTable (search, sort, pagination, Excel/CSV/PDF export) live on all 8 list pages.
> **Phase 2 DONE:** Edit + Delete with confirm on all master data (customers, suppliers, materials, finished goods, expenses); stock-qty locked on edit (ledger integrity); **Void engine** (`0005_void.sql` — void_sale / void_purchase / void_production, FIFO-safe reversals) with Void actions + Voided badges; View detail on Sales, Purchases (items+payments), Production (FIFO consumption trace).
> **Phase 3 PARTIAL:** Reports now live-data with **P&L, Debtors, date-range filter, per-report Excel/PDF export**; voided sales excluded. Dashboard + Stock Alerts on live data. Remaining: PDF invoice/receipt documents.
> **⚠️ ACTION REQUIRED:** run `supabase/migrations/0005_void.sql` in the Supabase SQL Editor before using Void.
> **Remaining for full production:** Phase 3 invoices/receipts · Phase 4 admin (settings, BOM editor, user mgmt, branches) · Phase 5 server-side pagination, mobile sidebar, modal a11y.

---

## PART 1 — UX Audit (what's there vs what's missing)

### ✅ Already good
- Consistent sidebar + topbar shell, role-aware nav
- Loading / error / empty states on every page
- Success/error **toasts** on all writes
- **NumberInput** with commas + leading-zero strip
- Modals for create, with validation + disabled-while-saving
- Sales & Purchases: view detail + record part-payment
- Production: BOM auto-fill
- Stock alerts with reorder points

### ❌ Gaps found (by theme)

**A. Data actions (CRUD) — biggest gap**
| Table | View | Edit | Delete |
|-------|------|------|--------|
| Customers | ❌ | ❌ | ❌ |
| Suppliers | ❌ | ❌ | ❌ |
| Raw Materials | ❌ | ❌ | ❌ |
| Finished Goods | ❌ | ❌ | ❌ |
| Expenses | ❌ | ❌ | ❌ |
| Sales | ✅ | ❌ | ❌ |
| Purchases | ❌ (detail API exists, not wired) | ❌ | ❌ |
| Production | ❌ (detail API exists, not wired) | ❌ | ❌ |

> ⚠️ Transactions (sales/purchases/production) must **not** be hard-deleted — they moved stock. They need a **"Void/Reverse"** that undoes the stock movements & FIFO. Master data needs edit + delete (with a guard: block/soft-delete if referenced).

**B. Export & print — missing entirely**
- No Excel / CSV / PDF export on any table or report
- No printable **invoice** (sale) or **receipt** / **purchase order** PDF
- Reports can't be exported

**C. Tables don't scale**
- No **pagination** — every row renders (breaks past a few hundred; bad for a SaaS)
- No **column sorting**
- **Search** only on Sales & Raw Materials; missing on Customers, Suppliers, Purchases, Production, Expenses
- No date-range filter on Sales / Reports / Dashboard

**D. Forms & safety**
- No **confirm dialog** for destructive actions
- No inline per-field error text (only toast)
- Modals: no **ESC-to-close**, no focus trap (a11y)

**E. Admin / settings — missing**
- No UI to manage lookups (payment types, expense types, customer types)
- No **BOM editor** (recipes can only be seeded, not edited in-app)
- No **user management** (invite staff, assign the 4 roles)
- No **branch management** for multi-branch tenants
- No tenant settings (name, logo, currency)

**F. Responsiveness / polish**
- Sidebar is fixed 240px — no mobile collapse/hamburger
- Tables overflow on mobile but layout isn't tuned
- No global search / quick-add

---

## PART 2 — Implementation Plan

### 🔑 Keystone: a reusable `DataTable` component
Instead of hand-coding each table, build **one** `<DataTable>` that gives every page the same powers. This is the highest-leverage item — do it first.

```
<DataTable
  columns={[{ key, header, render?, sortable?, align? }]}
  rows={data}
  searchKeys={['name','company']}
  rowActions={[{ icon, label, onClick, show? }]}   // view / edit / delete / pay
  exportName="customers"                            // enables Excel/CSV/PDF menu
  pageSize={20}                                     // pagination
/>
```
Gives **search + sort + pagination + row actions + export** to every page at once.

---

### Phase 1 — DataTable + Export (the foundation)
- [ ] Build `components/DataTable.tsx` (search, sort, client pagination, row-action menu)
- [ ] Build `lib/exporters.ts`:
  - Excel via **`xlsx`** (SheetJS)
  - CSV (native blob)
  - PDF via **`jspdf` + `jspdf-autotable`**
- [ ] Add an **Export ▾** button (Excel / CSV / PDF) to the DataTable toolbar
- [ ] Roll DataTable into all 8 list pages

### Phase 2 — CRUD everywhere
- [ ] **Master data** (customers, suppliers, materials, finished goods, expenses):
  - View drawer, Edit modal (reuse create modal), Delete with **confirm dialog**
  - API: add `update`/`remove` where missing; soft-delete (`is_active=false`) when the record is referenced by transactions
- [ ] **Transactions** (sales, purchases, production):
  - Wire **View detail** on Purchases & Production (API already exists)
  - Backend **`void_sale` / `void_purchase` / `void_production`** RPCs that reverse stock + FIFO (migration `0005_void.sql`)
  - "Void" action with confirm, instead of delete
- [ ] Reusable `ConfirmDialog` component

### Phase 3 — Invoices, receipts & report export
- [ ] **PDF invoice** for a sale (company header, line items, totals, balance) — print/download
- [ ] **PDF receipt** on payment; **PDF purchase order** for purchases
- [ ] Reports: **date-range picker** + per-report Excel/PDF export
- [ ] New reports: **Profit & Loss**, **Debtors** (customers owing), **Creditors** (suppliers owed), **Product profitability**

### Phase 4 — Admin & Settings
- [ ] **Settings** page: manage payment/expense/customer types (CRUD lookups)
- [ ] **BOM editor**: view/edit recipe per finished good
- [ ] **User management**: invite users, assign role (admin/sales/inventory/accounts), deactivate
- [ ] **Branches** management (multi-branch tenants) + branch switcher
- [ ] Tenant settings: business name, logo upload (Supabase Storage), currency

### Phase 5 — Scale & polish
- [ ] Move search/sort/pagination **server-side** (Supabase `range()` + `ilike` + `order`) for large tenants
- [ ] Debounced search
- [ ] Mobile: collapsible sidebar + hamburger; sticky table headers
- [ ] Modal a11y: ESC-to-close, focus trap, return focus
- [ ] Date-range filter on Dashboard
- [ ] Global quick-add (＋) menu

---

## Suggested order (value ÷ effort)
1. **Phase 1** — DataTable + Export → instantly upgrades all 8 tables (search, sort, paginate, Excel/CSV/PDF)
2. **Phase 2** — CRUD + Void → real day-to-day usability
3. **Phase 3** — Invoices + report export → the things a business prints/sends
4. **Phase 4** — Admin/Settings → needed before onboarding other tenants
5. **Phase 5** — Scale + mobile polish → before going wide

New dependencies: `xlsx`, `jspdf`, `jspdf-autotable` (all client-side, no backend cost).
New migration: `0005_void.sql` (reversal RPCs) + soft-delete columns.
