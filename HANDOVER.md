# StockFlow — Handover Doc

Paste this file's path (or contents) into a new Claude Code chat to resume work with full context. Last updated: 2026-07-14.

## What this is

**StockFlow** — a multi-tenant inventory/sales/manufacturing ERP SaaS for African SMEs. Rebuilt from a real MS Access database (`Jokesan_sales_app.accdb`, a Nigerian soap/cosmetics manufacturer) into a full web app, then generalized into a sellable product. Investor/client PDF exists at `C:\Users\user1\Documents\StockFlow-Overview.pdf`.

**Location:** `C:\Users\user1\Documents\My Project\jokesan-sales-app`
**Live:** https://jokesan-sales-app.vercel.app
**Deploy:** Vercel, auto-deploys from this folder (no separate CI file — check `vercel.json` for the SPA rewrite).

## Hard constraints — do not violate

1. **SCSS only, never Tailwind.** User explicitly rejected Tailwind. Design system lives in `src/styles/` (`_variables.scss`, `_mixins.scss`, `global.scss`, `layout.scss`) and cascades to all ~30 pages.
2. **No demo-data UI anywhere in the app.** Demo/seed data is loaded only via SQL (`0006_demo_data.sql`'s `seed_demo_data_for(email)` RPC) run manually in the Supabase SQL editor, and only ever targeted at `oguntunde123@gmail.com` (the pitch/demo account) — **never** the main account `oguntunde722@gmail.com`.
3. **Paystack secret key never touches the frontend or repo.** Public key only in `.env` (`REACT_APP_PAYSTACK_PUBLIC_KEY`). Secret key lives solely as a Supabase Edge Function secret (`PAYSTACK_SECRET_KEY`), used by `supabase/functions/paystack-verify/index.ts`.
4. **Stays on Create React App**, not Next.js — user explicitly chose this despite the SaaS direction. All server-side logic goes through Supabase Edge Functions / Postgres RPCs, not API routes.
5. **When told "proceed" / "complete the app now,"** build continuously — don't stop to run Playwright verification or ask clarifying questions unless truly blocked. The user has corrected this before ("what are you doing are we not supposed to be improving the app???").

## Architecture

- **Frontend:** React 19 + TypeScript, CRA (`react-scripts` 5.0.1), react-router. No separate backend server.
- **Backend:** Supabase (Postgres + Row Level Security + Auth + Storage + Edge Functions) — "Supabase IS the backend."
- **Multi-tenancy:** one `tenants` row per company, `type` = `single` or `multi_branch`. RLS via `current_tenant_id()` / `current_role()` / `current_branch_id()` SQL functions + auto-tenant-stamping `BEFORE INSERT` triggers.
- **Roles (4 per tenant):** Admin (all), Sales, Inventory, Accounts — gated via `src/lib/permissions.ts` (`canAccess`, `ROLE_ROUTES`). Plus a platform Super Admin (`platform_admins` table, separate from tenant roles) at `/platform`.
- **Business engine — the core IP:** FIFO costing ported faithfully from the Access app, as Postgres RPC functions (`SECURITY DEFINER`, tenant-scoped): `create_purchase`, `record_production`, `create_sale`, `record_sale_payment`, `record_purchase_payment`, `void_sale`, `void_purchase`, `void_production`. Never bypass these with direct table writes for money-moving actions.
- **Payments:** Paystack Popup (inline.js) for subscription billing; `activate_subscription` RPC called server-side after Edge Function verification.
- **Offline-first POS:** hand-written `public/service-worker.js` (cache-first, same-origin GET only) + `src/lib/offlineCache.ts` (read fallback) + `src/lib/offlineQueue.ts` (write queue for offline sales, replayed through the real `create_sale` RPC on reconnect — server is authoritative, so a real stock conflict fails loudly per item rather than corrupting inventory).
- **Design system:** navy (`$sidebar-bg #0b1220`) + locked blue accent `#2563eb` (never change without asking), Plus Jakarta Sans typography, centralized SCSS tokens in `src/styles/_variables.scss` / `_mixins.scss`.

## Supabase project

URL: `https://ovrcebvtcyeypzbkltet.supabase.co`. Keys in `.env` (gitignored, `REACT_APP_` prefix).

**Migrations** live in `supabase/migrations/`, run manually by the user in the Supabase SQL editor (there is no CLI/CI migration runner wired up) — sequential 0001 → 0013, all currently written:

| File | Purpose |
|---|---|
| 0001_init.sql | 27 tables, RLS, `current_tenant_id()`/`current_role()`/`current_branch_id()`, signup trigger |
| 0002_engine.sql | Core FIFO RPC engine |
| 0003_seed.sql | (superseded by 0006) |
| 0004_tenant_defaults.sql | Auto-tenant-stamp trigger for direct-insert tables |
| 0005_void.sql | FIFO-safe void/reversal RPCs |
| 0006_demo_data.sql | Admin-only demo seeding, targets `oguntunde123@gmail.com` only |
| 0007_team_settings.sql | Staff invites, team roles, `profiles.email` |
| 0008_vat.sql | VAT/TIN support on sales |
| 0009_logo_superadmin.sql | Logo storage bucket, `platform_admins`, platform RPCs |
| 0010_billing.sql | `activate_subscription` RPC, plan_expires_at |
| 0011_reminders.sql | `customers.last_reminded_at` for WhatsApp debtor reminders |
| 0012_barcodes.sql | Barcode columns on materials/finished_goods |
| 0013_branches.sql | Fixed missing auto-tenant-stamp trigger on `branches` |

If picking this up fresh, **ask the user which migrations have actually been run** — several were flagged "USER MUST RUN" and confirmation wasn't always captured.

To become platform (Super Admin) owner: run the commented `INSERT INTO platform_admins ...` at the bottom of `0009_logo_superadmin.sql` with the owner's email.

## Key files

- `src/lib/api.ts` — central typed data-access layer (all Supabase calls + RPC wrappers)
- `src/lib/hooks.ts` — `useQuery`/`useMutation` (supports offline `cacheKey` fallback)
- `src/lib/AuthContext.tsx`, `src/lib/permissions.ts` — auth + role gating
- `src/lib/invoice.ts` — PDF invoice generation + WhatsApp deep links
- `src/lib/bankAlert.ts` — bank-SMS-paste payment matcher (Mono alternative)
- `src/lib/barcodeLabels.ts`, `src/lib/importer.ts`, `src/lib/exporters.ts` — barcode PDF labels, CSV import wizard, table export
- `src/components/Layout.tsx` — sidebar/topbar shell, notification bell, settings gear, mobile drawer
- `src/styles/` — the entire design system (edit here to change the look app-wide)
- `supabase/functions/paystack-verify/index.ts` — Deno Edge Function, must be deployed manually via Supabase dashboard
- `COMPETE_ROADMAP.md`, `IMPLEMENTATION_PLAN.md`, `UX_IMPROVEMENT_PLAN.md` — original planning docs at repo root (mostly executed already; check before assuming something is unbuilt)

## Build

`npm run build` uses `cross-env NODE_OPTIONS=--max-old-space-size=8192 GENERATE_SOURCEMAP=false react-scripts build` — this was needed to fix OOM crashes as the app grew. Don't strip these flags.

## Deliberately not built (don't start without the user asking again)

- **Mono bank reconciliation** — needs a registered business the user doesn't have yet. Replaced with the bank-alert-paste matcher (`/match-payment`).
- **WhatsApp Business API auto-send** — needs Meta Business verification (weeks-long approval). Replaced with `wa.me` deep links + a reminder queue.
- **True branch-switcher** — a single admin cannot operate across multiple branches in one session; each branch currently needs its own login. Documented limitation, not attempted (would need new RPC params threaded through `create_sale`/`create_purchase`/`record_production`).
- Multi-currency purchases, i18n, public API.

## Recent work (most recent first)

1. **Investor/client PDF** generated at `C:\Users\user1\Documents\StockFlow-Overview.pdf` (6 pages: what it is, the problem, FIFO engine explainer, full feature breakdown, differentiation vs Katana/Zoho/QuickBooks, pricing/unit economics, 8-step how-to-use guide, roles reference). Structurally validated via `pypdf`; not yet visually proofed (no `pdftoppm`/poppler-utils on this machine) — if visual QA is needed, install poppler or open the PDF directly.
2. **UI overhaul** (ui-ux-pro-max + design-taste-frontend skills) — Inter → Plus Jakarta Sans, full shadow/radius/z-index token scale, gradient sidebar, blurred sticky topbar, notification bell (live low/out-of-stock badge, dropdown → `/stock-alerts`) + settings gear + mobile hamburger drawer added to `Layout.tsx`/`layout.scss`. Accent color locked at `#2563eb`, unchanged. Verified via `tsc` clean + prod build exit 0 + login-page screenshot; interior pages not screenshotted (no test login password available in-session).
3. Barcode scanning, branches UI, offline PWA (3 stages), Paystack billing, VAT/FIRS, Super Admin, CSV import wizard, POS quick-sell, Smart Insights — all shipped earlier this session, see full memory file for detail.

## Full technical memory

A denser, more complete running log (every migration, every bug fix, every architecture decision with dates) is kept at:
`C:\Users\user1\.claude\projects\C--Users-user1-claude\memory\project_jokesan_stockflow.md`

A new Claude session with access to the user's memory system will load this automatically. If working from a different account/machine, read that file directly first.

## How the user likes to work

- Prefers autonomous, uninterrupted building over incremental check-ins — "proceed" means keep shipping, don't pause to verify or ask.
- Asks pointed "why do we need X?" questions when skeptical of a dependency (Mono, WhatsApp Business API) — treat those as real objections, propose alternatives, don't just justify the original choice.
- Wants the app both technically solid (real FIFO accounting, not toy CRUD) and commercially real (pricing, positioning vs incumbents, investor-ready materials).
