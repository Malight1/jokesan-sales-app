# Jokesan ERP → "StockFlow" SaaS — Master Implementation Plan

> From a single-business Access app to a multi-tenant, money-making SaaS for African manufacturing & trading SMEs.

**Author:** Engineering plan for Mubarak O.
**Stack:** React + TypeScript + SCSS · Supabase (Postgres, Auth, Edge Functions, Storage, Realtime) · Paystack/Flutterwave
**Last updated:** 30 June 2026

---

## PART A — What the Access App Actually Does (Reverse-Engineered)

This is **not** a basic CRUD app. The Access database implements a **manufacturing ERP with FIFO inventory costing**. Any rebuild MUST preserve these 7 calculations or the numbers will be wrong and the client will lose trust.

### A1. Entity Relationship Map

```
SUPPLIERS ──< PurchaseMainTable ──< Purchase_table (batches w/ qty_remaining)
                     │                      │
                     └──< PurchasePaymentTable     │ (FIFO source of raw material cost)
                                                    ▼
MATERIALS ◄──────────────────────────── Production_consumption ──> PRODUCTION
   │  (qty_Balance)                              │                      │
   │                                             │                      ▼
   └──< BOM_production_table (recipe)            │                  fg_batches (qty_remaining, unit_cost, selling_price)
                                                 │                      │ (FIFO source of finished-goods cost)
                                                 │                      ▼
CUSTOMERS ──< Sales_table ──< Sales_subform_table              sales_consumption
                  │                                                     │
                  └──< SalesPaymentTable                                ▼
                                                              Stock_Movement (audit log)
```

### A2. The 7 Core Calculations

| # | Calculation | Formula (from real data) | Where in Access |
|---|-------------|--------------------------|-----------------|
| 1 | **FIFO raw-material consumption** | When production uses a material, draw from the oldest `Purchase_table` batch first; decrement that batch's `qty_remaining`. | `Production_consumption.Purchase_No` links the exact batch |
| 2 | **Raw-material unit cost** | Use the `Cost_Price` of the specific purchase batch consumed (not an average). E.g. Palm Kernel Oil batch #1 = ₦5,000, batch #2 = ₦3,500. | `Purchase_table.Cost_Price` |
| 3 | **Production unit cost** | `unit_cost = (Σ material costs from Production_consumption + Production.Expenses) ÷ qty_produced`. E.g. batch 1 → ₦23,675/unit. | `Production.unit_cost`, `fg_batches.unit_cost` |
| 4 | **Auto selling price** | `selling_price = unit_cost × markup`. Observed markup ≈ **1.5× (50% margin)** consistently. E.g. 15,950→23,925; 3,000→5,000; 320→480. | `fg_batches.Selling_price` |
| 5 | **FIFO finished-goods sale (COGS)** | When a sale is processed, draw from the oldest `fg_batches` first; decrement `qty_remaining`; record cost per batch. This gives true **COGS** & gross profit per sale. | `sales_consumption.Batch_id` |
| 6 | **Running payment balance** | `Balance = TotalAmount − Σ payments`. Status auto-flips: Part Payment → Full Payment when Balance = 0. Supports **multiple part-payments**. | `SalesPaymentTable`, `PurchasePaymentTable` |
| 7 | **Stock movement ledger** | Every SALE / PRODUCTION / PURCHASE writes an immutable row (productID, qty, type, date, user). The audit trail + source of truth for stock. | `Stock_Movement` |

### A3. Stock Balance Identity (must always hold)

```
finished_good.qty_Balance  = Σ(production in) − Σ(sales out)
material.qty_Balance        = Σ(purchases in) − Σ(production consumption)
purchase_batch.qty_remaining = original qty − Σ(consumed by production, FIFO)
fg_batch.qty_remaining       = produced qty − Σ(sold from this batch, FIFO)
```

> ⚠️ The current React prototype does **none** of this yet — it shows static numbers. Part D rebuilds the engine properly, server-side.

---

## PART B — Target SaaS Architecture

### B1. Tenancy Model (handles both cases you described)

```
SUPER ADMIN (platform owner — you)
   │   manages all tenants, billing, plans, impersonation
   │
   ├── TENANT  (= one company/account, the unit of billing)
   │     ├── type: 'single'        → 1 implicit branch
   │     └── type: 'multi_branch'  → N branches
   │
   └── Inside each tenant: 4 roles
         • Admin      — everything + users/settings
         • Sales      — sales, customers, payments (view stock + price)
         • Inventory  — materials, finished goods, production, purchases, suppliers, stock, reorder points
         • Accounts   — expenses, reports, all payments, debtors/creditors
```

**Single vs multi-branch is one flag, not two codebases.** A `single` tenant gets one auto-created "Main" branch and the branch selector is hidden. A `multi_branch` tenant can create branches and gets a branch switcher; Admin/Accounts see all branches, Sales/Inventory are scoped to their assigned branch.

### B2. Why Supabase (keeps it cheap & scalable)
- **Postgres + Row Level Security** → tenant isolation enforced at the DB, not just the UI.
- **Auth** with custom JWT claims (`tenant_id`, `branch_id`, `role`).
- **Edge Functions** → run the FIFO/costing engine server-side (clients can't tamper with numbers).
- **Realtime** → live stock + dashboards across devices.
- **Storage** → invoices, logos, product images.
- Generous free tier; scales to paid as tenants grow. One project, schema-per-isolation via RLS.

---

## PART C — Database Schema (Supabase / Postgres)

### C1. Platform tables
```sql
tenants(
  id uuid pk, name, slug unique, type ('single'|'multi_branch'),
  plan ('trial'|'starter'|'growth'|'enterprise'), trial_ends_at,
  is_active bool, currency default 'NGN', country default 'NG',
  created_at
)
branches(id uuid pk, tenant_id fk, name, address, is_active)
profiles(  -- 1:1 with auth.users
  id uuid pk references auth.users, tenant_id fk, branch_id fk null,
  role ('admin'|'sales'|'inventory'|'accounts'), full_name, phone, is_active
)
subscriptions(
  id, tenant_id fk, plan, status, provider ('paystack'),
  amount, interval ('monthly'|'yearly'), current_period_end, paystack_sub_code
)
audit_logs(id, tenant_id, user_id, action, entity, entity_id, meta jsonb, created_at)
```

### C2. Business tables (every one carries `tenant_id` + `branch_id`)
`customers, customer_types, suppliers, materials, material_purchases (batches),
purchase_orders, purchase_payments, finished_goods, boms, bom_items,
production_runs, production_consumption, fg_batches, sales_orders, sale_items,
sale_payments, sales_consumption, stock_movements, expenses, expense_types,
payment_types, reorder_settings`

### C3. Row Level Security (the core of multi-tenancy)
```sql
-- every business table:
create policy tenant_isolation on <table>
  using (tenant_id = (auth.jwt() ->> 'tenant_id')::uuid);

-- branch scoping for Sales/Inventory roles:
create policy branch_scope on sale_items
  using (
    tenant_id = (auth.jwt() ->> 'tenant_id')::uuid
    and (
      (auth.jwt() ->> 'role') in ('admin','accounts')
      or branch_id = (auth.jwt() ->> 'branch_id')::uuid
    )
  );

-- super admin bypass via service role / separate claim.
```

---

## PART D — Business Logic Layer (Edge Functions)

Each of these runs in a **Postgres transaction** so stock never drifts. Build as Supabase Edge Functions (or Postgres RPC functions):

1. **`create_purchase`** → insert PO + batches, `material.qty_Balance += qty`, write `stock_movement(PURCHASE)`.
2. **`record_production`** → explode BOM × qty, FIFO-consume material batches (calc #1,2), compute `unit_cost` (calc #3), set `selling_price = unit_cost × markup` (calc #4), create `fg_batch`, decrement materials, write `stock_movement(PRODUCTION)`.
3. **`create_sale`** → validate stock, FIFO-consume `fg_batches` (calc #5), compute COGS + gross profit, decrement finished goods, write `stock_movement(SALE)`. **Block if insufficient stock.**
4. **`add_payment`** (sale or purchase) → insert payment, recompute balance + status (calc #6).
5. **`recalc_stock`** → admin tool to rebuild `qty_Balance` from `stock_movements` (the ledger is the source of truth).
6. **`low_stock_scan`** (scheduled) → find items ≤ reorder point → notify (email/WhatsApp).

> Keeping these server-side is also a **moat**: the costing engine is the product, not the forms.

---

## PART E — Phased Roadmap

### ✅ Phase 0 — Frontend Prototype (DONE)
All 11 pages, SCSS design system, stock-alerts page, sale-blocking on zero stock. Mock data.

### 🔴 Phase 1 — Multi-Tenant Foundation (2–3 wks)
- [ ] Supabase project, schema (Part C), RLS policies
- [ ] Auth: signup (creates tenant + admin), login, JWT custom claims
- [ ] Onboarding wizard: company name → single/multi-branch → first products → done
- [ ] Role-based routing + nav (hide what a role can't see)
- [ ] Branch switcher (multi-branch tenants only)
- [ ] Replace ALL mock data with Supabase queries

### 🔴 Phase 2 — The Costing Engine (2–3 wks) ← the real value
- [ ] BOM management UI (define recipe per product)
- [ ] Edge functions D1–D5 with transactions
- [ ] Wire production/sales/purchase forms to the engine
- [ ] COGS + gross-profit shown on every sale
- [ ] Stock ledger view + `recalc_stock` admin tool

### 🟡 Phase 3 — Money Features (2 wks)
- [ ] **Invoices & receipts** (PDF, branded with tenant logo)
- [ ] **Share invoice via WhatsApp / email** (one tap — huge in NG)
- [ ] **Debtors & creditors aging reports** (who owes you, who you owe)
- [ ] **Payment reminders** (auto WhatsApp/SMS to overdue customers)
- [ ] Profit & Loss, best-sellers, margin-by-product dashboards

### 🟡 Phase 4 — Subscriptions & Billing (1–2 wks)
- [ ] Paystack subscription integration (NGN plans, cards + transfer)
- [ ] Plan gates (limits enforced in RLS + UI)
- [ ] 14-day free trial, trial-expiry flow, dunning on failed payment
- [ ] Super-Admin console: tenants list, MRR, activate/suspend, impersonate

### 🟢 Phase 5 — Growth & Stickiness (ongoing)
- [ ] PWA / offline-first (shop-floor on cheap Android, patchy network)
- [ ] Barcode / QR stock scanning (phone camera)
- [ ] VAT / FIRS e-invoicing compliance (NG tax)
- [ ] B2B customer ordering portal (your customers self-order)
- [ ] WhatsApp order bot
- [ ] Bank reconciliation, multi-currency, data export & backups

### 🚀 Phase 6 — Deploy & Scale
- [ ] Frontend → Vercel; DB/functions → Supabase prod (backups, pooling)
- [ ] Subdomain per tenant (`acme.stockflow.africa`)
- [ ] CI/CD (GitHub Actions), error monitoring (Sentry), analytics (PostHog)

---

## PART F — Monetization Strategy (make it a money-maker)

**Market:** African (Nigeria-first) manufacturing & trading SMEs — soap makers, food processors, cosmetics, beverages, FMCG distributors. They currently run on paper, Excel, or fragile Access files. They feel the pain of stock theft, unknown profit, and chasing debtors.

### F1. Pricing tiers (NGN, monthly — anchor in local reality)

| Plan | Price/mo | Users | Branches | Products | Key gates |
|------|---------:|:-----:|:--------:|:--------:|-----------|
| **Trial** | Free 14d | 2 | 1 | 20 | Full features, time-limited |
| **Starter** | ₦15,000 | 3 | 1 | 100 | Core ERP, invoices, 1 branch |
| **Growth** | ₦45,000 | 10 | 3 | unlimited | + WhatsApp reminders, P&L, multi-branch, API |
| **Enterprise** | ₦150,000+ | unlimited | unlimited | unlimited | + e-invoicing, priority support, custom |

> Annual = 2 months free (drives cash + retention). Price is intentionally a fraction of one prevented stock-loss incident — easy ROI story.

### F2. Revenue lines beyond subscriptions
- **Transaction fee** on payments collected through the B2B portal (0.5–1%).
- **Paid add-ons:** payroll module, advanced BI, extra branches, SMS/WhatsApp credit bundles.
- **Setup/onboarding fee** for Enterprise (data migration from their Access/Excel — you already have the migration script!).
- **White-label** for accountants/consultants who resell to their clients.

### F3. Why they'll pay (and stay)
- The **FIFO costing engine** tells them their *real* profit per product — nobody's spreadsheet does this correctly.
- **Stock control** stops theft/leakage (the #1 SME pain).
- **WhatsApp invoicing + reminders** gets them paid faster — directly tied to cash.
- Once their live stock + history is in, **switching cost is high** → low churn.

---

## PART G — Standout Features to Add (differentiation)

1. **"Profit X-ray"** — per-product, per-batch true margin using the FIFO COGS. Marketing centerpiece.
2. **WhatsApp-first** — invoices, receipts, payment reminders, daily sales summary to the owner's phone at 8pm.
3. **Offline PWA** — works on the factory floor without data; syncs later.
4. **Smart reorder** — predict run-out date from sales velocity, auto-draft purchase orders.
5. **Owner's daily digest** — "Today: ₦X sales, ₦Y profit, 3 items low, ₦Z owed to you."
6. **Theft/shrinkage flag** — when physical count ≠ ledger, surface the gap by product & handler.
7. **Multi-business** — one owner, several companies under one login (you're already multi-tenant).

---

## PART H — Tech Stack & Scalability Summary

| Concern | Choice |
|--------|--------|
| Frontend | React 19 + TS + SCSS (no Tailwind), Vite later for speed |
| State/Data | TanStack Query + Supabase JS client |
| DB | Supabase Postgres, RLS for isolation, indexes on `tenant_id`, `branch_id`, dates |
| Logic | Edge Functions / Postgres RPC in transactions |
| Auth | Supabase Auth, JWT claims, role + tenant + branch |
| Payments | Paystack (subscriptions + B2B collections) |
| Files | Supabase Storage (invoices, logos) |
| Realtime | Supabase Realtime (live stock/dashboards) |
| Notifications | WhatsApp Cloud API / Termii (SMS) / Resend (email) |
| Hosting | Vercel (web) + Supabase (backend) |
| Scale levers | Pagination, DB indexes, materialized views for reports, caching, read replicas (later), per-tenant subdomain |
| Observability | Sentry (errors) + PostHog (product analytics) |

---

## Current Status

| Phase | Status | % |
|-------|--------|--:|
| 0 — Frontend prototype | ✅ Done | 100% |
| 1 — Multi-tenant foundation | 🔴 Next | 0% |
| 2 — Costing engine | 🔴 Planned | 0% |
| 3 — Money features | 🟡 Planned | 0% |
| 4 — Billing/subscriptions | 🟡 Planned | 0% |
| 5 — Growth | 🟢 Backlog | 0% |
| 6 — Deploy/scale | 🟢 Backlog | 0% |

**Overall: ~15% of the SaaS vision (the prototype shell).** The valuable, defensible work — the costing engine + multi-tenant billing — is Phases 1–4.

---

## Recommended Next Step
Start **Phase 1**: stand up Supabase, create the schema with RLS, and wire auth + onboarding. I can generate the full SQL migration and the auth flow next. You'll need a free account at **supabase.com** (I'll walk you through getting the URL + keys).
