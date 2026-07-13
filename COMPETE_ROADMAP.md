# StockFlow — Master Roadmap: Beat the International Competition
**Goal:** the best manufacturing/inventory SaaS for African SMEs — Katana's power, Nigerian DNA, 5% of the price.
**Competitors:** Katana MRP ($199+/mo), Zoho Inventory, Odoo, QuickBooks Commerce, inFlow · Local: Bumpa, OZE, Sabi
**Strategy in one line:** don't out-feature them — **out-Nigeria them.**
**Date:** July 2026 · Owner: Mubarak O.

---

## ✅ ALREADY SHIPPED (the foundation)

| Area | Status |
|---|---|
| Multi-tenant Supabase backend (RLS, 27+ tables, 7 migrations) | ✅ |
| FIFO costing engine (purchases → production → sales → COGS → profit) | ✅ |
| Auth + 4 roles (admin/sales/inventory/accounts) + route guards | ✅ |
| All 11 pages live data, DataTable (search/sort/paginate/export Excel-CSV-PDF) | ✅ |
| Edit/Delete + ConfirmDialog everywhere; Void engine (FIFO-safe reversals) | ✅ |
| Reports: P&L, Sales, Expenses, Stock, Debtors + date range + export | ✅ |
| PDF invoices, WhatsApp receipts, WhatsApp debt reminders | ✅ |
| Settings: business, team invites/roles/deactivate, types CRUD, BOM editor | ✅ |
| Stock alerts + reorder points + oversell blocking | ✅ |
| Demo account with 4 months of engine-real history | ✅ |

---

# PHASE 0 — SHIP IT (before any new features)
> You cannot sell localhost. Everything below assumes a live URL.

### 0.1 Deploy to Vercel — **Size: S (half a day)**
- Push repo to GitHub (private) → import in Vercel
- Env vars: `REACT_APP_SUPABASE_URL`, `REACT_APP_SUPABASE_ANON_KEY`
- `vercel.json` SPA rewrite: all routes → `/index.html` (CRA + react-router requirement)
- Supabase Auth: add the Vercel URL to **Auth → URL Configuration** (site URL + redirect list)
- Custom domain later: `app.stockflow.africa`

### 0.2 Landing page — **Size: M (1–2 days)**
- Single-page marketing site (separate `landing/` static or Framer/Carrd to start)
- Hero: "Know your real profit. Chase your debtors on WhatsApp."
- 3 feature blocks (FIFO profit · WhatsApp reminders · staff roles), pricing table, WhatsApp contact button, signup CTA → app URL
- Testimonial slot for Jokesan case study

### 0.3 Production hardening — **Size: S**
- [ ] Turn ON leaked-password protection + rate limits in Supabase Auth
- [ ] Supabase daily backups verified (Settings → Database)
- [ ] Error boundary component (app never white-screens)
- [ ] Sentry (free tier) for frontend error reporting
- [ ] Favicon, app title, OG tags, `manifest.json` branding (StockFlow, not CRA defaults)

---

# PHASE 1 — REMOVE THE SALES BLOCKERS (Tier 1)

### 1.1 Excel/CSV Import Wizard — **Size: M (2–3 days)** ⭐ highest conversion impact
*The #1 objection: "my records are in Excel/notebook — I can't retype everything."*
- New page `/settings` tab or `/import`: 4-step wizard
  1. Pick entity (Customers / Suppliers / Materials / Products / Opening Stock)
  2. Upload `.xlsx`/`.csv` (SheetJS already installed — parse client-side)
  3. **Column mapping UI**: their headers → our fields, with auto-guess (fuzzy match "Phone Number" → phone), preview first 5 rows, per-row validation errors
  4. Import with progress bar → summary (85 imported, 3 skipped + reasons + downloadable error file)
- Opening stock: import via a generated "Opening Balance" purchase (materials) / adjustment batch (finished goods) so **FIFO stays true** — never raw-update balances
- Downloadable blank templates per entity
- Tech: client-side only + existing APIs; batch inserts in chunks of 100

### 1.2 POS Quick-Sell Mode — **Size: M (2–3 days)**
*For the shop counter: 3 taps to a sale, not a form.*
- Route `/pos` (Sales + Admin roles): big product tiles with stock badge & price, tap to add, qty stepper, running total
- Customer optional (default Walk-in), big PAID / PART / CREDIT buttons, amount-tendered + change calculator
- Calls existing `create_sale` RPC — zero new backend
- Print/WhatsApp receipt right from the success screen
- Works great on a cheap Android tablet → sell it as "your shop POS"

### 1.3 VAT + FIRS readiness — **Size: S–M (1–2 days)**
- `tenants.vat_enabled boolean`, `tenants.vat_rate numeric default 7.5`, `tenants.tin text` (migration 0008)
- Sale modal + POS: VAT line auto-added (toggleable per sale); totals = subtotal + VAT
- Invoice PDF: VAT line, TIN displayed, sequential invoice numbers per tenant (`invoice_seq` counter — FIRS wants sequential numbering)
- Reports: VAT collected report (for filing) with export
- Later: FIRS e-invoicing API integration when mandate reaches SMEs (watch this — being first = marketing gold)

### 1.4 Offline-tolerant PWA — **Size: L (4–6 days)** ⭐ the moat
*NEPA + data costs kill cloud tools. Internationals will never build this for Nigeria.*
- Stage 1 (quick): installable PWA — `manifest.json`, icons, service worker caching the app shell → opens instantly, works as "app" on Android home screen
- Stage 2: read cache — cache last-fetched lists (IndexedDB via `localforage`); when offline show cached data with an "offline — showing last synced" banner
- Stage 3: write queue — queue `create_sale`/`create_purchase` RPCs in IndexedDB when offline; sync + toast when back online; conflict rule: server engine revalidates stock (a queued oversell fails loudly, never silently corrupts)
- Sell it as: **"Works even when network does not."**

### 1.5 Mono bank reconciliation — **Size: L (4–5 days, needs Mono account)**
*QuickBooks' killer feature, localized.*
- Tenant connects bank via Mono widget (read-only)
- Edge Function pulls transactions → auto-match inflows to unpaid/part-paid sales (amount + reference heuristics) → suggest matches, admin confirms → `record_sale_payment` fires
- "Unmatched inflows" screen for manual matching
- **Growth/Business plan feature** (Mono charges per account — priced in)

---

# PHASE 2 — MONETIZATION RAILS

### 2.1 Paystack subscription billing — **Size: L (4–5 days)** ⭐ turns app into business
- Plans: Starter ₦7,500 (1 user) · Growth ₦20,000 (5 users, POS, insights) · Business ₦45,000 (branches, Mono, WhatsApp API) · 14-day trial (already in schema: `tenants.plan`, `trial_ends_at`, `subscriptions` table)
- Paystack Plan codes ↔ our tiers; subscribe via Paystack Popup (inline JS) from a new **Billing** tab in Settings
- **Edge Function `paystack-webhook`**: verify signature → on `charge.success`/`subscription.create` update `subscriptions` + `tenants.plan`; on failure/expiry → downgrade to read-only grace mode
- Gating: `useAuth` exposes `plan`; `PlanGate` component wraps premium features ("Upgrade to Growth to unlock POS"); trial banner with days left; expired → read-only + billing page
- Seat limit enforced in invite flow (Starter = 1 user, etc.)

### 2.2 Business logo on invoices — **Size: S (half day)**
- Supabase Storage bucket `logos` (tenant-scoped policy), upload in Settings → Business
- `tenants.logo_url`; invoice PDF renders logo top-left (jsPDF `addImage`), WhatsApp header unchanged

### 2.3 Super Admin panel — **Size: M–L (3–4 days)**
- Separate route `/platform` gated to your user id(s) (platform_admins table, service-role Edge Function for cross-tenant reads)
- Tenants list: plan, users, sales volume, last active; activate/deactivate; MRR dashboard
- This is YOUR cockpit for running the SaaS

---

# PHASE 3 — THE "WOW" LAYER (Tier 2)

### 3.1 Smart Insights (AI-lite) — **Size: M–L (3–4 days)** ⭐ demo showstopper
*You already have the data; internationals charge enterprise money for this.*
- New Dashboard panel + `/insights` page. All computable in SQL views — no ML needed:
  - **Margin erosion:** "Palm Kernel Oil batch cost ↑12% in 3 months; Liquid Soap margin fell 41%→28%. Raise price to ₦520 to restore 1.5× markup."
  - **Reorder forecast:** consumption rate vs stock → "SLS finishes in ~9 days; usual order takes 3 days — reorder by Friday."
  - **Debtor risk score:** average days-to-pay per customer; flag chronic late payers at sale time ("Bola Stores averages 24 days late").
  - **Dead stock:** products with no sales in 60 days + tied-up capital value
  - **Best sellers / best customers** by *profit*, not revenue (FIFO makes this honest)
- Later premium: monthly AI summary via Claude API ("Your July in plain English") — Growth+ feature

### 3.2 Barcode scanning — **Size: M (2 days)**
- `barcode` column on materials + finished_goods (0009); scan with phone camera (`html5-qrcode` lib) in POS + purchase + production modals; generate printable barcode labels (jsPDF) for unlabelled local products

### 3.3 WhatsApp Business API (auto-send) — **Size: L (4–5 days, needs Meta approval)**
- Today: wa.me links (manual tap). Upgrade: Cloud API via Edge Function — auto-send receipt on sale, auto-remind debtors on a schedule (pg_cron), low-stock alert to owner's WhatsApp
- Template messages pre-approved by Meta; per-conversation cost → **Business plan feature**
- Interim cheap win: "Remind All" button that opens each debtor chat one after another

### 3.4 Multi-currency purchases — **Size: M (2–3 days)**
- `purchase_orders.currency`, `fx_rate`, engine stores cost in NGN at entry rate — FIFO stays single-currency internally (0010)
- Rate auto-suggest from free FX API, editable (parallel-market reality)
- Report: "FX impact on COGS"

---

# PHASE 4 — SCALE & ENTERPRISE (Tier 3)

| Feature | Size | Notes |
|---|---|---|
| **Branches UI** (multi-branch tenants) | L | Branch switcher, per-branch stock & reports; schema already supports it |
| **Approval workflows** | M | Discounts > X% or voids need admin approval (approvals table + pending state) |
| **2FA** | S | Supabase Auth TOTP — enable + settings UI |
| **Accounting export** | S–M | QuickBooks/Sage-format CSV of journals (sales, COGS, expenses) — accountants ask for this |
| **Audit log UI** | S | audit_logs table exists; add triggers on sensitive actions + viewer page for admins |
| **Public API + keys** | L | For enterprise/integrators; Supabase Edge Functions + API key table |
| **Bumpa/Shopify sync** | L | Pull online orders in as sales — partnership play |
| **Server-side pagination** | M | Swap DataTable to Supabase `range()` when tenants pass ~2k rows |
| **i18n groundwork** | M | Pidgin/Hausa/Yoruba UI strings — differentiation nobody has |

---

# MIGRATION QUEUE (continuing 0001–0007)
- **0008** — VAT fields + invoice sequence counter + tenants.logo_url
- **0009** — barcodes + platform_admins
- **0010** — multi-currency purchase fields
- **0011** — approvals + audit triggers
- *(Paystack/Mono/WhatsApp are Edge Functions + small tables as they land)*

# PRICING ←→ FEATURE MATRIX (what makes people upgrade)
| Feature | Starter ₦7.5k | Growth ₦20k | Business ₦45k |
|---|---|---|---|
| Core ERP + invoices + WhatsApp links | ✅ | ✅ | ✅ |
| Users | 1 | 5 | 15 |
| CSV import, VAT, PWA/offline | ✅ | ✅ | ✅ |
| POS mode | — | ✅ | ✅ |
| Smart Insights | — | ✅ | ✅ |
| Barcode scanning | — | ✅ | ✅ |
| Branches | — | — | ✅ |
| Mono bank reconciliation | — | — | ✅ |
| WhatsApp auto-send | — | — | ✅ |
| API + accounting export | — | — | ✅ |

# EXECUTION ORDER (the honest sequence)
```
0.1 Deploy ─► 1.1 CSV Import ─► 2.1 Paystack ─► 1.2 POS ─► 1.3 VAT ─► 2.2 Logo
                                    │
0.2 Landing page (parallel)         └─► first paying customers possible here
Then: 3.1 Insights ─► 1.4 PWA/Offline ─► 2.3 Super Admin ─► 3.2 Barcode
Then: 1.5 Mono ─► 3.3 WhatsApp API ─► 3.4 Multi-currency ─► Phase 4 as demand pulls
```
**Rule:** after Paystack ships, every feature is built *because a prospect asked for it* — not from this list's order. The list is the map; customers are the compass.
