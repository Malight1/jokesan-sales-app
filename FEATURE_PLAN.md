# StockFlow Feature Plan: closing the competitor gaps

**Date:** 12 September 2026. **Status updated:** 17 September 2026 — see `HANDOVER.md` for the fuller picture.
**Scope:** the seven items from the competitor review (see `COMPETE_ROADMAP.md` for the why).
**Starts from:** migrations 0001–0035, live in production — **all of Phase 6 (6a–6f), and 7a and 7c, are now live**. `0036` (this session's work) is on `main` but **not yet run live**, and its Edge Function isn't deployed yet either — see `HANDOVER.md`'s "Where things actually stand" and "Setting up the assistant." Work commits directly to `main` (no feature branches — see `HANDOVER.md`'s hard constraints).

| Phase | Feature | Migration(s) planned | Migration(s) actually used | Status |
|---|---|---|---|---|
| 0 | Foundations: document numbers, audit helper, plan gating | 0021 | 0021 | ✅ done |
| 1 | Batch numbers, manufacture and expiry dates (NAFDAC) | 0022 | 0022 | ✅ done |
| 2 | Returns and credit notes (customer and supplier) | 0023 | 0023, **0024** (void a return + configurable cashier policy, added after review) | ✅ done |
| 3 | Discounts and price tiers | 0024 | **0025** | ✅ done |
| 4 | Shifts and cash-up (X/Z reports) | 0025 | **0026** | ✅ done |
| 5 | Automatic payment confirmation | 0026 + Edge Functions | **0027** + 3 Edge Functions | 🟡 5a done, 5b/5c not started |
| 6 | Quotes, real purchase orders, units of measure, delivery notes, custom fields, audit viewer | 0027–0031 | **0028** (6a), **0029** (6b), **0030** (6c), **0031** (6d), **0032** (6e), **0033** (6f) | ✅ done |
| 7 | Smart reorder (materials), assistant, e-invoicing readiness | 0032–0033 | **0034** (7a, materials only), **0035** (7c), **0036** (7b) + assistant Edge Function | ✅ done |

**Migration numbers below this line are as originally planned and no longer match what shipped** — Phase 2 grew a second migration (returns needed a follow-up for voiding a return and a configurable policy, both closed gaps flagged after the first pass), which pushed every phase after it up by one. Trust `HANDOVER.md`'s migration table and the `supabase/migrations/` directory for the real numbering; treat every `0024`/`0025`/`0026`/etc. reference in the rest of this document as "whatever the next free number is," not literal.

**Every phase in this document has now been attempted** — Phases 0–7a and 7c are live in production; Phase 7b's code is on `main` but its migration hasn't run yet, and its Edge Function needs deploying and an `ANTHROPIC_API_KEY` secret before it actually answers anything (see `HANDOVER.md`). What's genuinely left, across the whole plan, is narrower than a phase: 5b/5c (dedicated virtual accounts, a bank feed), 7a's own finished-goods "produce" suggestion, 7c's provider adapter, and the assistant's own two small deferred items — see `HANDOVER.md`'s "Known gaps deferred so far" for the complete, current list. Cross-check specifics (column names, function signatures) against what actually exists before assuming anything below this line is still accurate — it's the plan as originally written, not a live status report.

**Phase 4, as actually shipped, differs from the plan below in a few deliberate ways** (see `HANDOVER.md`'s "Known gaps deferred so far" for the full list):
- `shift_rules.required_for` **defaults to empty**, not `["sales"]` — the plan's default would have locked every existing tenant out of selling the moment `0026` runs, before any till was ever opened. An admin turns it on under Settings → Business once registers are set up.
- The owner dashboard's "shift short" attention card, a Reports → Shifts tab, a denomination-breakdown counting UI, and a printable Z report layout were **not built** — `x_report()`/`z_report()` already return everything those screens would need, so it's UI-only work whenever it's prioritized.

**Phase 5, as actually shipped so far, is 5a only** (see HANDOVER.md's Phase 5a section and "Known gaps deferred so far" for the full list):
- Built: connecting a tenant's own Paystack account (secret stored in Supabase Vault, never a plain column), "Get payment link" on an unpaid sale, and webhook-driven auto-confirmation (`apply_incoming_payment()`).
- Not built: 5b (a dedicated virtual account per customer — needs Paystack's approval on the merchant's account first, per this plan's own note below) and 5c (a bank-feed provider). Also not built: per-tenant webhook auto-registration (each business currently pastes the webhook URL into their own Paystack dashboard by hand), a "Confirmed by Paystack" badge on Sales, and unifying `MatchPayment.tsx` with the new `incoming_payments` data into one "Incoming Payments" view — it still exists unchanged, side by side with pay links.

**Phase 6, as actually shipped so far, is 6a (quotes) only** (see HANDOVER.md's Phase 6a section and "Known gaps deferred so far" for the full list):
- Built: `create_quote`/`update_quote_status`/`convert_quote`, a `/quotes` page with a create modal, status actions, convert-to-sale, PDF, and WhatsApp send.
- A quote's discount isn't checked against the creator's limit at creation the way this plan's schema sketch implies — only conversion (via the underlying `create_sale`) checks it, so "no second PIN" doesn't fully hold; `convert_quote` does accept an approval so the PIN can still be supplied without an admin taking over.
- Not built: 6b (real purchase orders), 6c (units of measure), 6d (delivery notes), 6e (custom fields), 6f (audit log viewer), and the owner dashboard's "open quote value" card.

**Phase 6b (real purchase orders), as actually shipped, differs from the plan below**:
- What's owed to the supplier is **not stored as the ordered value** the way this plan's schema sketch implies — `purchase_orders.total_amount`/`balance` start at 0 when an order is placed and grow only as each `receive_purchase_order()` call records what actually arrived. The "value ordered" (for display) is computed on demand from `purchase_order_lines`, not stored as the accounting total.
- The advance-payment cap removal in `record_purchase_payment()` applies to **every** purchase, not just the new ordered path (including the pre-existing "Quick purchase" flow) — a deliberate, low-risk relaxation rather than a status-gated special case.
- `suppliers.lead_time_days` is the **most recently observed** lead time (days from `ordered_at` to the final receipt), not a rolling average — the plan doesn't specify how "learned" should work, and this is the simplest reading.
- Not built: the "Orders"/"Receipts" tab split this plan's screens section describes (everything is one Purchases list with a status column), a PO PDF/WhatsApp send to the supplier, and the inventory dashboard's "open purchases" card.

**Phase 6c (units of measure), as actually shipped, is scoped down from the plan below**:
- Built: `product_units`, and `create_sale`/`create_purchase`/`receive_purchase_order` each converting `{uom_id, uom_qty}` to a base-unit quantity in one place — everything below that point (FIFO, COGS, discounts) is completely unchanged, exactly as this plan's "no costing code changes" note intends. Unit management in the Finished Goods/Materials product modals, and POS barcode scanning matching a unit's barcode.
- **Not built:** any per-line unit *selector* in POS, Sales, or Purchases — POS's cart stays one line per product, always in base units, so scanning a unit barcode is a quantity shortcut only and doesn't tag the resulting `sale_items` row with `uom_id`/`uom_qty` (only a direct RPC call with those fields does, which the engine fully supports). Also not built: `price_list_items` per-UOM pricing, and the stock-screen "12 ctn + 5 pcs" display toggle this plan's screens section describes.

**Phase 6d (delivery notes), as actually shipped, matches the plan below closely** — the simplest Phase 6 sub-phase, by the plan's own design ("the engine stays simple"):
- Built: `deliveries`/`delivery_items`, `create_delivery_note`/`dispatch_delivery`/`mark_delivery_delivered`/`mark_delivery_failed`, a `/deliveries` list with status actions, "Create delivery note" on Sales, a waybill PDF, and a private `delivery-proofs` Storage bucket confined to the caller's own tenant folder from its first migration (unlike `logos`, which needed a follow-up fix for this).
- Not built: the `/deliveries` "board" a kanban-style view might imply — it's a plain status-badged list, same scope call as Purchases in 6b.

**Phase 6e (custom fields), as actually shipped, is scoped down from the plan below**:
- Built: `custom_field_defs` and a `custom_fields` jsonb column on customers, suppliers, finished goods, materials and sales orders, exactly as this plan's schema sketch describes. Fields render in the create/edit form for each of the four master-data entities, and in a "Custom fields" section on the Sale detail screen. A field flagged `show_on_invoice` prints on the invoice PDF.
- A sale's fields are set only **after** the sale exists, via a dedicated `set_custom_fields` RPC, never at the point of sale — `create_sale` has no parameter for them. `required` is enforced for the four master-data entities but deliberately **not** for a sale, since there'd be no way to enforce it at creation time anyway.
- Not built: DataTable optional columns for a custom field, and CSV/Excel export inclusion — both are generic table/export features the app doesn't have anywhere yet, not something specific to custom fields.

**Phase 6f (audit log viewer), as actually shipped, closes out Phase 6** — built largely as the plan below describes, with one addition beyond it:
- Built: a generic `audit_row_change()` trigger on the tables this plan names (roles, settings, branches, payment types) plus `expense_types`/`customer_types`/`price_lists`/`price_list_items` — the plan's "price changes" bullet, made concrete. Everything else sensitive (voids, returns, discount overrides, shift variance, batch write-offs/recalls) was already logging inline via `log_audit()` since Phase 0, so this phase's only new engine work was the tables with no RPC of their own to log from. A new `/audit` page (admin), with a before/after summary per row, a date-range filter, and "export per year" satisfied by picking a year and using the existing per-page Export button rather than a bespoke export path.
- Not built: a dedicated diff-viewer modal (an inline one-line summary stands in for it) and distinct-value dropdown filters for action/entity (the search box covers the same ground).

**Phase 7a (smart reorder), as actually shipped, is scoped to materials only** — this plan's own two halves (a material "order" suggestion, and a finished-goods "produce" suggestion checked against the BOM's feasibility) were split, and only the first was built:
- Built: `reorder_suggestions()` with the exact formula this plan describes — a real 90-day daily usage series (not an approximation), weighted 60/40 towards the last 30 days, a genuine population standard deviation for safety stock, the learned supplier lead time from 6b, and a plain-language reason sentence built in SQL. `create_reorder_purchase_orders()` turns checked suggestions into real purchase orders grouped by supplier, matching this plan's "Create orders" button description. Landed on Insights, as this plan says, with the inventory role newly given access to that page (it had none before).
- Not built: the finished-goods "produce" suggestion checked against BOM feasibility ("can make 140 of the 200 needed; short 20kg SLS"), a seasonal factor (this plan's own "later" note), and a reorder-list widget on a dedicated inventory dashboard (Insights is the only place it lives for now).

**Phase 7c (e-invoicing readiness) was built before 7b (the assistant)** — a deliberate reordering, not the plan's own sequence. 7b needs an Anthropic API key configured as an Edge Function secret before it produces anything; 7c needs nothing external and is immediately useful the moment its migration runs, well ahead of the 2027/2028 enforcement dates this plan describes. As actually shipped:
- Built: the master data this plan names (business TIN/RC number/address, a customer's TIN and B2B-vs-B2C, a product's tax category and classification code), a real database trigger enforcing that an issued invoice's commercial value can't change once created (corrections are a return or credit note only), and a readiness score in Settings exactly as this plan's own words describe ("Completeness checks appear in Settings as an 'E-invoice readiness' score").
- Not built — this plan's own explicit reservation, not a scope cut: the actual submission adapter and provider integration ("Action for you: start talks with one or two accredited providers... get the current field specification from them"). `einvoice_submissions` (the table a future adapter will write to) and the IRN/QR fields on the invoice PDF both wait on that provider choice.

**Phase 7b (Ask StockFlow), as actually shipped, closes out this document in full** — built right after 7c, matching this plan's own description closely:
- Built: the `assistant` Edge Function, calling Claude with the exact tool set this plan names (`dashboard_summary`, `stock_levels`, `reorder_suggestions`, `batch_trace`, and all three `report_*` functions), each one called "with the user's own login" exactly as this plan specifies — a Supabase client built from the asking user's own JWT, so a role's normal restrictions apply automatically, with no special-casing needed in the assistant itself. Business plan only, with a monthly question limit per business (`assistant_usage`), matching this plan's "Limits and rollout" section.
- Not built: the Haiku-for-everyday / Sonnet-for-analysis model split (one model, Haiku 4.5, is used throughout — routing well between the two needs a real classifier this session didn't build) and the "later" MCP server for asking from outside the app.

---

## Ground rules for every phase

These are the same patterns 0017 and 0020 already use.

1. **Every change to stock or money goes through a SECURITY DEFINER RPC.** No direct table writes from the app. Each new money table gets a `guard_money_write` trigger (0017) and branch-scoped read policies (0020).
2. **Branch handling:**
   - Every RPC takes a trailing `p_branch uuid default null` and calls `resolve_branch()`.
   - FIFO draws lock their rows with `for update`.
   - `lock_stock_balance` stays in place, so `qty_balance` only ever changes inside the engine.
3. **Changing a function's parameters means dropping it first.** `create or replace` with an extra parameter creates a second overload, and PostgREST calls then become ambiguous. The drop has to name the exact old signature. 0020 already does this, so copy that.
4. **Enum additions go at the top of the migration**, as `add value if not exists`, and nothing in that same script may insert the new value outside a function body.
5. **Tests before UI.** Each migration adds scenarios to `supabase/tests/tests.sql`, run with the PGlite harness (`--before 00NN`), and every existing test must still pass. Money invariants are asserted after each scenario:
   - `qty_balance = Σ qty_remaining` per product
   - `balance = total − paid − returned`
   - every movement ties to a document
6. **Frontend order for each feature:**
   1. `api.ts` types and calls
   2. page UI
   3. Reports
   4. `dashboard_summary`
   5. Jest tests
   6. check at 375px
7. **Standing constraints:**
   - SCSS only.
   - Accent colour `#2563eb`.
   - Plus Jakarta Sans.
   - No demo-data UI.
   - No secret keys in the frontend.
   - Stay on Create React App.
8. **Definition of done for a phase:**
   - `tsc` is clean
   - Jest passes
   - the harness passes
   - `npm run build` succeeds
   - walked through as each role (admin, sales, inventory, accounts), on one branch and on two
   - `AUDIT.md` run order updated

---

## Phase 0: Foundations (0021_foundations.sql)

Several later phases depend on these. Doing them once avoids re-work.

### 0.1 Sequential document numbers
**Current problem:** the POS receipt prints `INV-<timestamp>` (`POS.tsx:208`), while the Sales page shows `INV-<first 8 of uuid>` (`Sales.tsx:132`), so one sale carries two different numbers. Neither is sequential. The tax authority, credit notes and quotes all need proper numbering.

```sql
create table doc_sequences (
  tenant_id uuid references tenants(id) on delete cascade,
  doc_type  text,            -- INV, CN, QT, PO, GRN, DN, SR (supplier return), Z
  prefix    text not null,   -- editable in Settings, e.g. 'JKS-INV-'
  next_no   bigint not null default 1,
  primary key (tenant_id, doc_type)
);
-- update ... set next_no = next_no + 1 returning next_no - 1  → gap-free under concurrency
create function next_doc_no(p_type text) returns text ...
alter table sales_orders add column doc_no text;   -- unique (tenant_id, doc_no)
```

- **Backfill:** number existing sales in `created_at` order per tenant. Voided sales keep their numbers; gaps must be explainable.
- **`create_sale` sets `doc_no`.** The frontend reads it back and stops making numbers up. `invoice.ts`, the WhatsApp text and the POS receipt all use `doc_no`.
- **Offline POS:** the receipt shows "Receipt pending sync" plus a local reference. The real number arrives on sync, and the Pending Sync panel shows it.

### 0.2 Audit helper
- Add `log_audit(p_action, p_entity, p_entity_id, p_meta jsonb)`. It writes to the existing `audit_logs` table and is SECURITY DEFINER.
- Every new RPC in this plan calls it for sensitive actions: discount overrides, returns, voids, shift variance, price-list edits, recalls, and stock write-offs.
- The screen for browsing it comes in Phase 6.

### 0.3 Plan gating
- Add `tenant_has_feature(p_feature text) returns boolean`. It checks `tenants.plan` and trial state against a feature map in SQL, so the server enforces it.
- The frontend reads the same map to show "Upgrade to Growth" instead of a broken screen.
- Recommended mapping (change it if you like):

| Feature | Starter ₦7,500 | Growth ₦20,000 | Business ₦45,000 |
|---|---|---|---|
| Returns, discounts, shifts | ✓ | ✓ | ✓ |
| Batch and expiry, recall trace | | ✓ | ✓ |
| Price tiers, quotes, units of measure, delivery notes | | ✓ | ✓ |
| Purchase orders with receiving, smart reorder | | ✓ | ✓ |
| Automatic payment confirmation, e-invoicing, assistant, custom fields | | | ✓ |

### 0.4 Generalise the offline queue
- `offlineQueue.ts` only knows `type: 'sale'`. Change it to a union: `sale | sale_payment | shift_cash_movement`, and dispatch each type to its RPC.
- Stays online-only, deliberately: returns, shift open and close, recalls and receiving. Stock or cash integrity matters more there than availability.

**Tests:**
- Numbering stays gap-free when two concurrent sales are made.
- The backfill order is correct.
- Each tenant has its own sequence.

---

## Phase 1: Batch numbers, manufacture and expiry dates (0022_batch_expiry.sql)

**Why first:** NAFDAC requires a batch number, manufacture date and expiry date on soaps and cosmetics. Jokesan itself needs this to stay legal, and it's the strongest reason a manufacturer would pick StockFlow over Bumpa or Moniebook.

### Schema
```sql
alter table finished_goods
  add column track_batches   boolean not null default false,
  add column shelf_life_days int,                       -- expiry = mfg + this
  add column pick_rule       text not null default 'fifo' check (pick_rule in ('fifo','fefo')),
  add column batch_prefix    text,                      -- e.g. 'LS1L'
  add column nafdac_no       text;                      -- printed on labels

alter table materials
  add column track_batches boolean not null default false;

alter table fg_batches
  add column batch_no    text,
  add column mfg_date    date,
  add column expiry_date date,
  add column status      text not null default 'available'
    check (status in ('available','quarantine','recalled'));
-- one batch_no per product per branch (transfer_stock creates a row at the destination with the same batch_no)
create unique index on fg_batches (tenant_id, branch_id, finished_good_id, batch_no) where batch_no is not null;
create index on fg_batches (tenant_id, branch_id, expiry_date) where qty_remaining > 0;

alter table purchase_items
  add column supplier_batch_no text,
  add column expiry_date       date;

alter table tenants
  add column expiry_warning_days int not null default 60,
  add column allow_expired_sale  boolean not null default false;
```

Tracing from a batch back to its materials already works: `production_consumption.purchase_item_id` points to the supplier batch. Tracing forward to customers also works: `sales_consumption.fg_batch_id`. So most of the recall capability is already in place.

### Engine changes

**`record_production`** (drop the old signature, then add `p_batch_no text default null, p_mfg_date date default null, p_expiry_date date default null`):
- The batch number is auto-generated if blank: `prefix || to_char(mfg,'YYMMDD') || '-' || n`.
- The manufacture date defaults to the production date.
- The expiry date defaults to manufacture date + `shelf_life_days`.
- If the product has `track_batches`, a missing expiry date and a missing shelf life together are an error.

**`create_sale`** batch selection:
```sql
where ... and qty_remaining > 0
  and status = 'available'
  and (allow_expired_sale or expiry_date is null or expiry_date >= v_sale_date)
order by case when pick_rule = 'fefo' then expiry_date end asc nulls last,
         produced_at asc, id asc
for update
```
- The availability check before the loop must use the same filter.
- Message when blocked: "12 of Liquid Soap 1L at Lagos are expired and can't be sold."
- Optional `fg_batch_id` on an item lets a cashier sell one specific batch after scanning it. It fails if that batch is short.

**`transfer_stock`:** copy `batch_no`, `mfg_date`, `expiry_date` and `status` onto the destination row. It already keeps cost and `created_at`.

**`stock_levels`:** the return type changes, so drop and recreate it.
- Adds `sellable_qty`, `expired_qty` and `quarantine_qty` next to `qty`.
- `qty` still equals `qty_balance`, so nothing else breaks.
- POS and the offline cache switch to `sellable_qty`.

**`adjust_stock`:** add `p_batch uuid default null`, so a negative adjustment can hit one exact batch. This is needed for expired write-offs.

**New RPCs:**
- `write_off_expired(p_batch_id, p_note)` — admin or inventory. It creates a `stock_adjustments` row with reason `Expired`, moves the batch cost into a "Stock written off" figure on the P&L, and logs to the audit trail.
- `set_batch_status(p_fg, p_batch_no, p_status, p_reason)` — admin only. It covers every branch at once. Recall and quarantine stop sales immediately.
- `batch_trace(p_fg, p_batch_no)` returns jsonb:
  - **Where it came from:** materials used, supplier, the supplier's batch number, purchase date.
  - **Where it went:** each sale, with date, customer name, phone, quantity and branch.
  - **What's left:** stock remaining at each branch.

### Dashboard and alerts
- **`dashboard_summary`:**
  - Inventory and owner dashboards get `expiring_soon` (count, value and the first 5 items) and `expired_count`.
  - The owner's "Needs your attention" list gets "₦84,000 of stock expires within 60 days".
- **Bell:** add expiring and expired alerts next to low stock.
- **`StockAlerts.tsx`:** a new tab, "Expiring", with one-click "Write off" and "Move to another branch".

### Screens
- **FinishedGoods product modal:** a "Batch tracking" section with track batches on/off, shelf life in days, the pick rule shown as "Sell earliest expiry first", the batch prefix and the NAFDAC number.
- **Production form:**
  - Batch number is pre-filled and editable.
  - Manufacture date and expiry date are auto-filled and editable.
  - The success screen gets **Print labels for this batch**, with quantity defaulting to the quantity produced.
- **`barcodeLabels.ts`:** labels add `Batch`, `MFD MM/YYYY`, `EXP MM/YYYY` and `NAFDAC Reg. No.` (the format NAFDAC requires). There's also a larger label size for cartons.
- **New `/batches` page** (admin and inventory):
  - A DataTable with product, batch, branch, remaining quantity, manufacture date, expiry date, days left and status.
  - Filters for expiring, expired and recalled.
  - A row drawer with the trace. A "Recall" button asks for confirmation and a reason, then offers "Message affected customers on WhatsApp", pre-filled per customer through `whatsapp.ts`.
- **Purchases form:** supplier batch number and expiry date fields when the material tracks batches.
- **Invoice PDF:** a setting that prints batch numbers per line. Distributors and pharmacies ask for this.
- **Import:** optional columns on the opening stock import for batch number, manufacture date and expiry date.

### Backfill
Existing `fg_batches` keep `batch_no` null. `track_batches` defaults to off, so nothing changes until a product is switched on.

### Tests
- Earliest-expiry-first skips an older FIFO batch that expires later.
- Expired stock is blocked; `allow_expired_sale` lets it through.
- A recalled batch is blocked at every branch.
- A transfer keeps the batch number and expiry.
- The trace returns the correct customers after split and transferred sales.
- Voiding a sale restores stock to the exact batch.
- A write-off hits only the named batch.
- The unique batch number holds within a branch.
- Every harness invariant still holds.

---

## Phase 2: Returns and credit notes (0023_returns.sql)

**Current problem:** only a full void exists, with no document and no refund record. A return in October of a September sale has to reduce October's figures, not rewrite September's. So returns are dated documents of their own, and sales rows are never edited after the fact.

### Schema
```sql
alter type movement_type add value if not exists 'RETURN';
alter type movement_type add value if not exists 'SUPPLIER_RETURN';

create table sale_returns (
  id uuid pk, tenant_id, branch_id, sales_order_id uuid not null references sales_orders,
  doc_no text,                      -- CN-000123 from next_doc_no('CN')
  return_date date not null default current_date,
  reason text not null,
  subtotal numeric(14,2), vat_amount numeric(14,2), total numeric(14,2),
  cogs_reversed numeric(14,2),      -- only restocked lines
  applied_to_balance numeric(14,2), -- reduced what the customer owed
  refunded numeric(14,2),           -- cash or transfer paid back
  to_store_credit numeric(14,2),
  refund_payment_type_id uuid, shift_id uuid,       -- shift_id filled from Phase 4
  created_by uuid, created_at timestamptz
);
create table sale_return_items (
  id, tenant_id, sale_return_id, sale_item_id, finished_good_id,
  qty numeric(14,3), unit_price numeric(14,2), amount numeric(14,2),
  condition text check (condition in ('resellable','damaged','expired'))
);
create table sale_return_consumption (   -- which batch each returned unit went back to
  id, tenant_id, sale_return_item_id, fg_batch_id, qty, unit_cost
);
alter table sales_orders add column returned_total numeric(14,2) not null default 0;
alter table sale_items   add column qty_returned  numeric(14,3) not null default 0;

alter table customers add column credit_balance numeric(14,2) not null default 0;
create table customer_credit_ledger (id, tenant_id, customer_id, amount, source_type, source_id, created_at);
```

### `create_sale_return(p_sale, p_items jsonb, p_refund_method, p_payment_type, p_reason, p_date, p_branch)`

**Checks:**
- Lock the sale.
- The sale must not be voided.
- For each line, `qty ≤ quantity − qty_returned`.

**Price:** the refund uses the price the customer actually paid, which after Phase 3 is the net line price. VAT is refunded pro rata at the sale's `vat_rate`.

**Resellable lines:**
- Walk back through that line's `sales_consumption`, newest batch first, so the cost comes back at the cost it left at.
- Add the quantity back to `fg_batches.qty_remaining` and `finished_goods.qty_balance`.
- Record a `RETURN +qty` movement at the return's branch, and reverse the cost.
- If the original batch has since been recalled or has expired, the stock goes back to that batch anyway, so it stays unsellable. That's correct.

**Damaged or expired lines:** no stock comes back and no cost is reversed, so the full cost stays as a loss.

**Money is applied in this order:**
1. Reduce the outstanding balance, capped at the balance.
2. The rest goes out as a cash or transfer refund (a negative `sale_payments` row tagged `refund`, so cash-up sees it), or into store credit if the customer is named.

**Afterwards:** update `returned_total`, `payment_status` and `balance`, then write an audit entry.

**Other RPCs:**
- `void_sale` refuses a sale that has returns ("Use a return instead").
- `void_sale_return` is admin-only and allowed the same day only.
- Store credit becomes a payment option in `create_sale`: an item in `p_payments` with `method = 'store_credit'`, checked against `credit_balance`.

**Permissions:** a setting, `cashier_returns`, takes `none`, `same_day_own` or `any`. The default is `same_day_own`. Admin and accounts can always do returns.

### Supplier returns
```sql
create table purchase_returns (id, tenant_id, branch_id, purchase_order_id, doc_no /*SR-*/, return_date, reason, total, created_by, created_at);
create table purchase_return_items (id, tenant_id, purchase_return_id, purchase_item_id, qty, cost_price, amount);
```
- `create_purchase_return(p_purchase, p_items, p_reason)` draws only from the named purchase layer's `qty_remaining`. Stock already used in production can't go back.
- It lowers `materials.qty_balance`, records a `SUPPLIER_RETURN −qty` movement, and reduces the purchase balance (what you owe the supplier). If the purchase was already paid, the supplier owes you, and that credit is recorded.

### Reports and dashboard
Every report that adds up sales now subtracts returns dated in the same period:
- Sales, P&L (net sales and net gross profit), VAT (output VAT less credit-note VAT), product profitability, Debtors, `dashboard_summary` (owner month to date, cashier today, branch table), and Insights.
- One SQL view, `sales_net_daily(tenant, branch, day, gross, returns, net, cogs, profit)`, feeds them all, so nothing is missed.

### Screens
- **Sales row menu → "Return items"** opens a modal with:
  - each line's returnable quantity, a quantity stepper and condition
  - the reason and refund method
  - a live summary, e.g. "Reduces balance ₦18,500, refund ₦4,000 cash"
- **Credit note PDF:** an `invoice.ts` variant titled "CREDIT NOTE" that references the original invoice number. It can be shared on WhatsApp.
- **POS "Returns" button:** find the receipt by scanning or typing its number, then use the same modal. Receipts gain a Code128 barcode of `doc_no` for this.
- **Sales list:** a "Returned ₦x" chip. The sale detail page lists its credit notes.
- **Customer page:** shows store credit.
- **Purchases row menu → "Return to supplier"**.
- **Reports:** a new "Returns" tab, by reason and by product. This shows quality problems.

### Tests
- A partial return, then a second partial, then trying to return more than was sold (blocked).
- Stock returns to the right batches across two FIFO layers.
- A damaged return keeps the cost as a loss.
- Refund split between balance and cash.
- Store credit earned, then spent.
- Void blocked once a sale has returns.
- A return in October leaves September's profit and loss unchanged.
- A supplier return is blocked once the materials were used in production.
- Branch scoping holds.

---

## Phase 3: Discounts and price tiers (0024_pricing.sql)

**Current problem:** `create_sale` accepts any `unit_price ≥ 0` the app sends, so a cashier can sell at ₦1 through the API. This phase makes the server decide the expected price and only allows changes within the rules.

### Schema
```sql
create table price_lists (
  id, tenant_id, name text,                -- Retail, Wholesale, Distributor
  is_default boolean default false,
  rule text check (rule in ('fixed','percent_off_retail')), percent numeric(5,2),
  is_active boolean default true
);
create table price_list_items (
  id, tenant_id, price_list_id, finished_good_id,
  uom_id uuid null,                        -- filled from Phase 6c
  min_qty numeric(14,3) not null default 1,-- quantity breaks: 12+ at ₦X
  price numeric(14,2) not null
);
alter table customer_types add column price_list_id uuid references price_lists;
alter table customers      add column price_list_id uuid references price_lists;  -- override

alter table sale_items
  add column list_price      numeric(14,2),   -- what the tier said
  add column discount_amount numeric(14,2) not null default 0,
  add column discount_reason text;
alter table sales_orders
  add column price_list_id   uuid,
  add column discount_total  numeric(14,2) not null default 0,  -- line + order discounts
  add column approved_by     uuid;                              -- manager override

alter table tenants add column pricing_rules jsonb not null default
  '{"max_discount_pct":{"sales":5,"accounts":10,"inventory":0,"admin":100},
    "below_cost":"warn","round_cash_to":0}';
alter table profiles add column approval_pin_hash text;         -- pgcrypto crypt()
```

### Engine
**`resolve_price(p_fg, p_customer, p_qty, p_uom)`** checks, in order:
1. the customer's own price list
2. their customer type's price list
3. the default price list
4. `finished_goods.selling_price`

Within a list it picks the row with the largest `min_qty ≤ qty`.

**`create_sale`** (drop the old signature and add `p_order_discount numeric default 0, p_approval jsonb default null`):
- For each line, the server computes `list_price`. The app sends `unit_price` and, optionally, a `discount` and a reason.
- `discount % = (list − charged) / list`. The line discounts plus the order discount are spread across lines by value.
- If the discount goes over the role's limit, the sale needs `p_approval {user_id, pin}`. The PIN is checked against an admin's `approval_pin_hash`, and the approver is written to `approved_by` and the audit log.
- Below cost: under `warn`, save and flag in the audit log; under `block`, raise an error.
- **VAT is charged on the price after discount.** Profit is calculated on the net price.
- A charged price higher than the list price is allowed; it's a price-up, not a discount.

**Settings:** a "Pricing" tab to manage price lists and per-role discount limits, and to set each admin's approval PIN. The PIN is set through a SECURITY DEFINER RPC and stored only as a hash.

### Screens
- **POS:**
  - Picking a customer shows their tier ("Wholesale") and reprices the cart immediately.
  - Tapping a line opens a discount editor (% or ₦, with a reason).
  - An "Order discount" button.
  - Going over the limit opens a manager PIN pad.
  - The receipt shows "You saved ₦x".
- **Sales form:** the same rules apply.
- **FinishedGoods:**
  - A price column per active list, editable inline.
  - A bulk action, "Set Wholesale = Retail − 10%".
  - Quantity-break rows.
- **Customers and customer types:** a price list selector.
- **Import:** a CSV for price lists (product, list, price, minimum quantity).
- **Reports:** a "Discounts" tab (by cashier, by reason, and overrides with approver) and gross margin by price list.

### Offline
- POS caches price lists, customer tiers and role limits.
- The limits are checked on the device and re-checked on the server when syncing. A queued sale the server rejects goes to the Pending Sync panel with the reason, as happens today.
- Manager overrides need a connection, because the PIN is checked on the server.

### Later (3b)
- Scheduled promotions: `promotions(start_at, end_at, percent, scope)`. This matches Bumpa.
- Bundles, "buy 2 get 1".
- Birthday offers through customer date of birth.

### Tests
- Tier resolution order.
- Quantity breaks.
- A discount over the limit is rejected without approval and accepted with a valid PIN.
- A wrong PIN is rejected.
- VAT is charged on the discounted amount.
- Below cost behaves correctly in both warn and block.
- A price sent from the app outside the rules is rejected.
- Offline sync with an out-of-limit discount fails cleanly.

---

## Phase 4: Shifts and cash-up (0025_shifts.sql)

### Schema
```sql
alter table payment_types add column method_group text not null default 'other'
  check (method_group in ('cash','transfer','card','store_credit','other'));
-- backfill: name ilike '%cash%' → cash, '%transfer%' → transfer, '%pos%'|'%card%' → card

create table registers (id, tenant_id, branch_id, name, is_active);   -- "Main till" auto-created per branch
create table shifts (
  id uuid pk, tenant_id, branch_id, register_id, doc_no /* Z-000045 */,
  opened_by uuid, opened_at timestamptz, opening_float numeric(14,2),
  closed_by uuid, closed_at timestamptz,
  expected jsonb,          -- {cash, transfer, card, ...} snapshot at close
  counted_cash numeric(14,2), counted_breakdown jsonb,  -- {"1000":42,"500":10,...}
  variance numeric(14,2), notes text,
  status text check (status in ('open','closed'))
);
create unique index one_open_shift_per_register on shifts (register_id) where status = 'open';
create table cash_movements (id, tenant_id, shift_id, kind text check (kind in ('pay_in','pay_out','drop')),
                             amount numeric(14,2), reason text, created_by, created_at);
alter table sales_orders  add column shift_id uuid references shifts;
alter table sale_payments add column shift_id uuid references shifts;
alter table tenants add column shift_rules jsonb not null default
  '{"required_for":["sales"],"blind_count":true,"variance_alert":1000}';
```

### Engine
- **`open_shift(p_register, p_float)`:** one open shift per register and one per user.
- **`add_cash_movement(p_kind, p_amount, p_reason)`:** writes to the user's open shift. Pay-outs over the limit need a manager PIN (same mechanism as Phase 3).
- **`create_sale`, `record_sale_payment` and refunds** set `shift_id` to the caller's open shift. If `shift_rules.required_for` includes the caller's role and no shift is open, they raise "Open your till before selling".
- **`shift_expected(p_shift)`:** per payment group, the payments in the shift minus refunds, plus the opening float and pay-ins for cash, minus pay-outs and drops.
- **`close_shift(p_counted_cash, p_breakdown, p_notes)`:**
  - Snapshots the expected figures, stores the variance and assigns a Z number.
  - With blind count on, the cashier enters the count before seeing the expected figure.
  - A variance over `variance_alert` goes into the owner's dashboard attention list and the audit log.
- **`x_report(p_shift)`** (read-only, any time) and **`z_report(p_shift)`** return jsonb:
  - sales by payment method and top products
  - discounts, returns and voids
  - debt collected
  - pay-ins and pay-outs
  - expected versus counted cash

**Offline sales:** queued offline sales carry the shift that was open on the device. If that shift has closed by the time they sync, they still attach to it, the expected figures are recalculated, and the shift is marked "late sync". Opening and closing a shift need a connection.

### Screens
- **POS:**
  - With no shift open, it shows an "Open till" card (register and float) instead of the product grid.
  - The header shows a "Till open 08:02" chip with a menu: X report, Pay in/out, Close till.
- **Close till:** a denomination counter (₦1000, 500, 200, 100, 50 and coins) with a live total, then the result (expected, counted, over or short) and a Z report for thermal print (80mm) or PDF.
- **Cashier dashboard:** a till card showing the float and cash expected so far.
- **Owner dashboard:** "Shift short ₦2,500 · Abuja · Amaka" under Needs your attention.
- **Reports:** a "Shifts" tab (all Z reports, variance per cashier over time) and a reprint of any Z report.
- **Settings:** registers per branch, shift rules and payment method groups.

### Tests
- Expected cash includes the float, cash sales, debt collected, pay-ins, pay-outs and refunds.
- Transfers are never counted as cash.
- A second open shift is refused.
- A sale with no shift is refused when the rules require one.
- A late offline sync recalculates the shift.
- Blind count is respected: the expected figure is hidden until the count is in.
- Branch scoping holds.

---

## Phase 5: Automatic payment confirmation (0026_payments.sql + Edge Functions)

**Goal:** a transfer shows as paid without anyone reading a bank alert. This is the answer to Moniebook, and to fake alerts.

**Recommended route.** Each business connects its *own* Paystack account, so money never passes through StockFlow and StockFlow carries no licensing risk.
- **5a Pay links:** a "Pay now" link on every invoice and on the WhatsApp message. Card, transfer and USSD are all confirmed by webhook.
- **5b Dedicated account per customer:** repeat B2B customers get their own account number, so any transfer to it matches that customer automatically.
- **5c Bank feed** (later, for businesses that won't use Paystack): read incoming credits from their existing bank account through an account-data provider, then feed them into the existing `rankMatches` matcher. It auto-confirms only when exactly one invoice matches the amount and reference.

> Before starting, check with Paystack: Dedicated Virtual Accounts need approval on the merchant's account, and 5c's provider terms and pricing need confirming. Build 5a first, because it needs no special approval.

### Schema
```sql
create table payment_integrations (
  tenant_id uuid pk, provider text default 'paystack', status text,  -- pending|live|error
  public_key text, secret_vault_id uuid,   -- Supabase Vault; never selectable by the app
  last_verified_at timestamptz, settings jsonb
);
create table payment_links (id, tenant_id, sales_order_id, provider_ref text unique, url text,
                            amount numeric(14,2), status text, created_at);
create table incoming_payments (
  id, tenant_id, provider text, provider_ref text, amount numeric(14,2),
  payer_name text, payer_account text, channel text, received_at timestamptz, raw jsonb,
  sales_order_id uuid, customer_id uuid,
  match_status text check (match_status in ('auto','suggested','manual','unmatched','ignored')),
  unique (provider, provider_ref)                          -- idempotent webhooks
);
alter table customers add column virtual_account jsonb;   -- {bank, number, name}
alter table sale_payments add column incoming_payment_id uuid;
```
RLS: `payment_integrations` can't be read by the app at all. It has an `integration_status()` RPC that returns only the status and public key.

### Edge Functions
All of them follow the `paystack-verify` pattern.
- **`payments-connect`** (admin JWT):
  - Takes the business's secret key once and checks it against Paystack.
  - Stores it in Vault and registers the webhook URL.
  - The key is never echoed back.
- **`payment-link-create`:** initialises a transaction for a sale's balance with `metadata {tenant_id, sales_order_id}` and returns the URL.
- **`payments-webhook`** (public, no JWT):
  - Verifies `x-paystack-signature`, an HMAC-SHA512 of the raw body, using the business's secret. The business is found from the metadata or the account number.
  - Inserts into `incoming_payments`, ignoring duplicates.
  - Calls `apply_incoming_payment(id)`. That function runs with the service role only and is granted to nobody else. It records the sale payment, fills in `shift_id` if a shift is open, and logs to the audit trail.
- **`customer-account-create`** (5b): creates a dedicated account for a customer on the business's Paystack.

### Screens
- **Settings → Payments:** connect Paystack (test or live), status, and "Send a test ₦100".
- **Invoices and WhatsApp:** a "Pay now: <link>" line on the invoice and in the message.
- **POS "Transfer" option:**
  - Shows the customer's dedicated account (or the business's).
  - Waits live on `incoming_payments` for that amount.
  - Big green **"₦18,500 received from ADEBAYO T."** when it lands.
  - The cashier can fall back to "Mark as paid manually", which is logged in the audit trail.
- **`/match-payment` becomes "Incoming payments":**
  - Tabs: Confirmed automatically, Needs review, Unmatched.
  - Pasting a bank alert still works for businesses without an integration.
- **Sales list:** a "Confirmed by Paystack" badge on those payments.

### Tests
- A bad signature is rejected.
- A replayed webhook is counted once.
- An overpayment is capped, with the excess going to store credit.
- A payment to a voided sale lands as `unmatched`.
- The app can't read another business's integration.
- A payment matching two invoices lands as `suggested`, not `auto`.

---

## Phase 6: Trade workflow

### 6a Quotes and proforma invoices (0027_quotes.sql)
```sql
create table quotes (id, tenant_id, branch_id, doc_no /*QT-*/, customer_id, issue_date, valid_until,
  status text check (status in ('draft','sent','accepted','declined','converted','cancelled')),
  kind text check (kind in ('quote','proforma')), subtotal, discount_total, vat_amount, total,
  notes, terms, converted_sale_id uuid, created_by, created_at);
create table quote_items (id, tenant_id, quote_id, finished_good_id, uom_id, qty, list_price, unit_price, discount_amount);
alter table tenants add column bank_details jsonb;   -- printed on proforma
```
- Quotes don't touch stock.
- An expired quote is worked out from `valid_until`; there's no scheduled job.
- **`convert_quote(p_quote, p_amount_paid, p_payment_type, p_branch)`:**
  - Calls `create_sale` with the quoted prices.
  - Discounts that were approved on the quote carry through, so there's no second PIN.
  - If stock is short at conversion, the error names the missing items.
- **Screens:**
  - A new `/quotes` page: list, builder (it reuses the sale line editor), a PDF titled "QUOTATION" or "PROFORMA INVOICE" with bank details, send on WhatsApp, and "Convert to sale".
  - The owner dashboard shows open quote value.

### 6b Purchase orders that are ordered before they're received (0028_purchase_orders.sql)
**Today:** `create_purchase` receives stock immediately. That stays as "Quick purchase", so the purchase form and the import don't break.
```sql
alter table purchase_orders
  add column doc_no text,                -- PO-
  add column status text not null default 'received'
    check (status in ('draft','ordered','partial','received','cancelled')),
  add column expected_date date, add column ordered_at timestamptz;
create table purchase_order_lines (id, tenant_id, purchase_order_id, material_id, uom_id,
  qty_ordered numeric(14,3), qty_received numeric(14,3) default 0, unit_cost numeric(14,2));
create table goods_receipts (id, tenant_id, branch_id, purchase_order_id, doc_no /*GRN-*/, received_at, received_by, note);
alter table purchase_items add column goods_receipt_id uuid, add column po_line_id uuid;
alter table suppliers add column lead_time_days int;   -- learned from ordered_at → received_at
```
- **`create_purchase_order(p_supplier, p_lines, p_expected, p_branch)`** creates the order with status `ordered` and no stock.
- **`receive_purchase_order(p_po, p_lines [{line_id, qty, unit_cost, supplier_batch_no, expiry_date}], p_date)`:**
  - Creates `purchase_items` FIFO layers at the receiving branch, records `PURCHASE` movements and a GRN number, and updates the status.
  - What's owed to the supplier grows by the value actually received.
- **Advance payments:** a payment made before receipt is allowed. A negative balance shows as "Supplier owes you goods".
- **Screens:**
  - The Purchases page gets Orders and Receipts tabs.
  - The order has a PDF, a WhatsApp send to the supplier, and a "Receive" screen with a received quantity per line and batch and expiry fields from Phase 1.
  - The inventory dashboard's `open_purchases` shows real orders on the way.

### 6c Units of measure (0029_uom.sql)
```sql
create table product_units (id, tenant_id, product_kind text, product_id uuid,
  name text,                 -- Carton, Bag, Dozen
  factor numeric(14,6) not null check (factor > 0),   -- base units per this unit
  barcode text, default_for_purchase boolean, default_for_sale boolean);
alter table sale_items     add column uom_id uuid, add column uom_qty numeric(14,3), add column uom_factor numeric(14,6);
alter table purchase_items add column uom_id uuid, add column uom_qty numeric(14,3), add column uom_factor numeric(14,6);
```
- **The engine keeps working in base units.** RPCs accept `{uom_id, uom_qty}` and convert to `quantity = uom_qty × factor` before any FIFO logic, so no costing code changes.
- The price per unit comes from `price_list_items.uom_id`, falling back to base price × factor.
- **Screens:**
  - Product modal: a units grid.
  - POS and Sales: a unit selector per line; scanning a carton barcode adds a carton.
  - Receipts read "2 Carton (48 pcs)".
  - Stock screens get a toggle to show "12 ctn + 5 pcs".
- **Tests:** conversion accuracy, a carton scan, FIFO cost staying the same whichever unit is used, and returns in a unit other than the one sold in.

### 6d Delivery notes and waybills (0030_deliveries.sql)
```sql
create table deliveries (id, tenant_id, branch_id, sales_order_id, doc_no /*DN-*/, driver_name, vehicle_no,
  destination text, status text check (status in ('pending','dispatched','delivered','failed')),
  dispatched_at, delivered_at, received_by_name text, proof_url text, note);
create table delivery_items (id, tenant_id, delivery_id, sale_item_id, qty);
```
- **Stock still leaves at the point of sale, so the engine stays simple.** Deliveries only track paperwork and status. Partial deliveries are tracked by quantity per line.
- **Screens:**
  - "Create delivery note" from a sale.
  - A waybill PDF with no prices and space for a signature.
  - Proof of delivery uploaded as a photo to Storage, under the business's own folder, like logos.
  - A `/deliveries` board with pending, dispatched and delivered.

### 6e Custom fields (0031_custom_fields.sql)
- A `custom_field_defs(tenant_id, entity, key, label, type text|number|date|select, options jsonb, required, show_on_invoice)` table, plus a `custom_fields jsonb` column on customers, suppliers, finished goods, materials and sales orders.
- The fields render in forms and as optional DataTable columns, appear in exports, and print on invoices when flagged.

### 6f Audit log viewer
- Triggers on the sensitive tables (price changes, roles, settings, branches, payment types) write to `audit_logs` through `log_audit`.
- **New `/audit` page** (admin):
  - A DataTable by date, user, action and document, plus a before/after diff for edits.
  - Export per year.
  - Records are never deleted. That satisfies the six-year record-keeping rule, and the page should say so.

---

## Phase 7: Looking ahead

### 7a Smart reorder (0032_reorder.sql)
`reorder_suggestions(p_branch)` is plain SQL, so the numbers can be checked. It returns one row per material or product:

**How much you use:** average daily usage over 90 days, weighted towards the last 30, taken from `stock_movements`.

**Lead time:** the supplier's lead time, learned from 6b or entered by hand.

**What to order:**
- Safety stock: `z × σ(daily) × √lead_time`, with z set by a "service level" setting.
- `reorder_point = daily × lead_time + safety`.
- `suggested_qty = daily × (lead_time + cover_days) + safety − on_hand − on_order`, rounded up to the purchase unit (bags or cartons).

**Plain-language reason**, built in SQL: "You use about 12 kg a day. 18 kg left ≈ 1.5 days. Supplier takes 5 days. Order 180 kg (6 bags) to cover 14 days."

**Finished goods:** a "produce" suggestion, checked against the recipe (BOM) and branch stock. For example: "Can make 140 of the 200 needed; short 20 kg SLS → added to the order."

**Screens:**
- **Insights:** "Reorder" cards, and a "Create orders" button that makes draft purchase orders grouped by each material's last supplier.
- **Inventory dashboard:** the reorder list uses these suggestions.

**Later:** a seasonal factor, from the same month last year (December and Ramadan spikes).

### 7b Ask StockFlow (assistant)
**Edge Function `assistant`:**
- Calls the Claude API (`claude-haiku-4-5` for everyday questions, `claude-sonnet-5` for analysis).
- Its tools are read-only RPCs (`dashboard_summary`, `stock_levels`, `report_*`, `reorder_suggestions`, `batch_trace`), called **with the user's own login**. That keeps each role's view and branch restrictions in force automatically.
- **Numbers always come from the tools. The model only explains them.**

**Limits and rollout:**
- Business plan only, with a monthly question limit per business, stored in `assistant_usage`.
- Later, an MCP server so owners can ask from Claude or ChatGPT (as Katana does).

### 7c E-invoicing readiness (0033_einvoice.sql)
**Rollout, as published:**
- Businesses turning over ₦1–5bn: enforced from January 2027.
- Under ₦1bn, which is most StockFlow customers: go live July 2027, enforced from January 2028.
- Invoices go through an accredited access-point provider, which returns a reference number (IRN) and a QR code.

What we build now, so connecting a provider later is just an adapter:
- ✓ Sequential, unique invoice numbers (Phase 0). ✓ Credit notes as linked documents (Phase 2).
- **Issued invoices can't be edited.** Once an invoice exists, corrections are credit notes only, enforced by a trigger.
- **Master data the tax authority wants:**
  - business: TIN (already on `tenants`), RC number, business address
  - customer: TIN, B2B or B2C, full address
  - product: tax category and product/service classification code
  - Completeness checks appear in Settings as an "E-invoice readiness" score.
- **Submission tracking:** `einvoice_submissions(doc_type, doc_id, provider, irn, qr_payload, status, request, response, submitted_at)`.
- **Adapter:** an Edge Function `einvoice-submit` behind a `submitInvoice(doc) → {irn, qr}` interface. The first adapter goes to whichever provider we partner with.
- **Invoice PDF:** prints the IRN and QR code once issued.
- **Action for you:** start talks with one or two accredited providers in Q4 2026, and get the current field specification from them. It has changed before.

---

## Cross-cutting checklist (every phase)

- [ ] Guard triggers from 0017 added to each new money or stock table. Read policies are scoped by role and branch.
- [ ] `stock_levels`, `dashboard_summary` and the `api.ts` `DashboardSummary` type updated, along with `src/dev/dashboardFixtures.ts` and the dashboard tests.
- [ ] `permissions.ts` routes updated for the new pages: `/batches`, `/quotes`, `/deliveries`, `/audit`.
- [ ] The Reports page and CSV, Excel and PDF exports include the new documents.
- [ ] The offline cache includes whatever POS needs: `sellable_qty`, price lists, tiers, the open shift.
- [ ] `ImportData` templates updated: batch and expiry, unit cost, price lists, units.
- [ ] `AUDIT.md` run order updated, and `HANDOVER.md` updated if any rule changes.
- [ ] Checked at 375px and at 1280px, and in dark mode where it applies.

## Decisions for you (the plan uses these defaults until you say otherwise)

1. **Plan tiers:** the feature table in 0.3.
2. **Cashier returns:** the default is same day, own sales only; admin and accounts can do any.
3. **Discount limits:** cashier 5%, accounts 10%, admin unlimited, with a manager PIN above that.
4. **Expired stock:** blocked from sale by default.
5. **Blind cash count:** on by default. A variance alert fires above ₦1,000.
6. **Payments:** each business uses its own Paystack account. StockFlow never holds customer money.
7. **E-invoicing provider:** yours to choose. I can draft the questions to ask them.

## Suggested next step
Commit the current work (dashboards and branch stock), confirm 0017, 0018 and 0020 are live, then start Phase 0 and Phase 1 together.
