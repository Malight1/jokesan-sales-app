# StockFlow — Handover Doc

Paste this file's path (or contents) into a new Claude Code chat to resume work with full context. Last updated: 13 September 2026 (Phase 4 added).

## What this is

**StockFlow** — a multi-tenant inventory/manufacturing/sales SaaS for Nigerian SMEs, built from a real MS Access database (a Lagos soap/cosmetics manufacturer, "Jokesan") and generalized into a sellable product. The core IP is a faithful FIFO costing engine (raw materials → production → finished goods → sales → true COGS and gross profit), not a toy CRUD app.

**Location:** `/Users/mubby/Documents/jokesan-sales-app`
**Repo:** https://github.com/Malight1/jokesan-sales-app
**Deploy:** Vercel, auto-deploys `main` (check `vercel.json` for the SPA rewrite). **Production is currently behind** — see "Where things actually stand" below.
**Owner:** oguntunde722@gmail.com. A separate account, oguntunde123@gmail.com, is the pitch/demo account — sample data must only ever go there.

## Hard constraints — do not violate

1. **SCSS only, never Tailwind.** Design system lives in `src/styles/` (`_variables.scss`, `_mixins.scss`, `global.scss`, `layout.scss`).
2. **No demo-data UI anywhere in the app.** Demo/seed data loads only via SQL run manually in the Supabase SQL editor, targeted only at `oguntunde123@gmail.com`. `seed_sample_data()`/`seed_demo_data_for()` are revoked from `authenticated`/`anon` (migration `0015_lock_sample_data.sql`) — there is deliberately no client wrapper for them in `src/lib/api.ts`.
3. **The Paystack secret key never touches the frontend or repo.** Public key only in `.env` (`REACT_APP_PAYSTACK_PUBLIC_KEY`). Secret key lives solely as a Supabase Edge Function secret (`PAYSTACK_SECRET_KEY`), used by `supabase/functions/paystack-verify/index.ts`.
4. **Stays on Create React App**, not Next.js. All server logic goes through Supabase Edge Functions or Postgres RPCs.
5. **The blue accent `#2563eb` is locked.** Never change it without asking. Font is Plus Jakarta Sans.
6. **Every change to stock or money goes through a `SECURITY DEFINER` RPC**, never a direct table write from the app. New money tables get a `guard_money_write` trigger and branch-scoped read policies (see "Engine conventions" below) — this is the single most important pattern to keep following.
7. **The user prefers autonomous, uninterrupted building.** "Proceed" means keep shipping through a whole phase — verify with the test suite, not by asking. Pause only when genuinely blocked on a decision only the user can make.
8. **Commit messages end with** `Co-Authored-By: Claude <model> <noreply@anthropic.com>` (model name matches whichever Claude model is doing the commit).

## Where things actually stand (13 September 2026)

Nothing described below the multi-branch stock migration has reached production yet. Everything is built, tested, and committed to a branch — pushed to GitHub, but **not merged, not deployed.**

- **Git:** branch `feature/batch-expiry-foundations`, pushed to `origin`. `main` itself is only current up to the multi-branch stock work — do not merge until the migrations below have run live, since the frontend on this branch already calls RPCs/columns that only exist from `0017` onward.
- **Database:** the *live* Supabase project has **not** run migrations `0017` onward. Everything from `0017_role_enforcement.sql` through `0026_shifts.sql` exists only as files in this branch, verified against a local PGlite (Postgres-in-WASM) test harness — never against the real project.
- **Before ANY of this goes live**, in order: run `0017` → `0018` → `0019` → `0020` → `0021` → `0022` → `0023` → `0024` → `0025` → `0026` in the Supabase SQL editor, one file at a time so a failure is easy to isolate (each file's header comment states which migrations it must run after — double-check as you go, a couple were written and verified before later ones existed). Then merge to `main` — Vercel auto-deploys the frontend from there.
- Also still pending from before this work started: move the Supabase project to a paid plan, and make one real Paystack Business-plan test payment end-to-end.
- After `0025` runs, at least one admin should set an approval PIN under **Settings → Pricing** — without one, no cashier discount over their limit can ever be approved (the "manager PIN" dialog will show "no admin has set up an approval PIN yet"). The same PIN also gates an over-limit pay-out once Phase 4's till requirement is turned on.
- `0026` ships with shifts **opt-in** (`shift_rules.required_for` defaults to empty) — turning on "Require an open till before selling" under Settings → Business is a separate, deliberate step for whoever wants it, not automatic on deploy.

**What to do with a fresh session:** read this file, then run `git log --oneline main..feature/batch-expiry-foundations` to see the commits, then decide whether to keep building on this branch (Phase 5 onward, see below) or stop and get the user to merge/deploy what's here first. Don't assume either — ask if genuinely unclear, but if the user says "proceed" or "continue," the default is to keep building forward on the same branch.

## Architecture

- **Frontend:** React 19 + TypeScript, CRA (`react-scripts` 5.0.1), `react-router-dom`. Every page is a lazy-loaded route (`App.tsx`) except `Login`.
- **Backend:** Supabase — Postgres + Row Level Security + Auth + Storage + Edge Functions. There is no separate application server.
- **Multi-tenancy:** one `tenants` row per company, `type` = `single` or `multi_branch`. RLS via `current_tenant_id()` / `current_role()` / `current_branch_id()` SQL helper functions.
- **Multi-branch model:** "separate stores, own stock" (the user's explicit choice over a shared-pool model). Every FIFO layer (`purchase_items`, `fg_batches`) belongs to a branch; `stock_levels(p_branch)` is the one function every screen reads current quantities from. Stock moves between branches only via `transfer_stock()`, which preserves original FIFO cost. See migration `0020_branch_stock.sql` for the full design rationale in its header comment — read it before touching branch logic.
- **Roles (4 per tenant):** admin (everything), sales (till/customers), inventory (stock/production/purchasing), accounts (finance/reports). Gated client-side via `src/lib/permissions.ts` (`canAccess`, `ROLE_ROUTES`) and, authoritatively, server-side via RLS policies and `guard_money_write`/`guard_void` triggers (migration `0017_role_enforcement.sql`). Never trust the client-side gate alone — the database is the real boundary. Plus a platform Super Admin (`platform_admins` table, unrelated to tenant roles) at `/platform`.
- **The FIFO engine** (the core IP): `create_purchase`, `record_production`, `create_sale`, `record_sale_payment`, `record_purchase_payment`, `void_sale`, `void_purchase`, `void_production`, plus everything added since (batches, returns, pricing — see below). All `SECURITY DEFINER`, tenant- and branch-scoped, with role checks enforced by triggers so they can't be bypassed even via direct REST calls.
- **Offline-first POS:** `src/lib/offlineCache.ts` (read fallback for cached queries) + `src/lib/offlineQueue.ts` (write queue, generalized beyond sales to also cover debt payments — `QueuedOp` is a discriminated union, easy to extend). Replayed through the real engine RPCs on reconnect (`useOnlineSync.ts`) — the server is always authoritative, so a real conflict fails loudly for the cashier to resolve rather than silently corrupting stock.
- **Document numbering:** every invoice, credit note, and supplier return gets a real sequential number issued by `next_doc_no()` (migration `0021`), never a client-generated string. Prefixes are brandable per tenant (`set_doc_prefix`).
- **Plan gating:** `tenant_has_feature(text)` / `require_feature(text, text)` (migration `0021`) decide which plan unlocks which feature, mirrored client-side in `src/lib/features.ts` (`hasFeature`, `planFor`) purely for UI messaging — the database is what actually enforces it.

## Engine conventions (read before writing a new RPC)

These are the patterns every migration since `0017` follows. Breaking them is how you reintroduce the bugs they were written to fix.

1. **A new money-moving table needs:** a `guard_money_write(roles, action)` trigger (blocks direct writes to the wrong role or a suspended/expired tenant) and a role- and branch-scoped `for select` read policy. Child/detail tables (line items, consumption traces) get a read policy but **no** write policy at all — they're only ever written from inside the parent's `SECURITY DEFINER` function.
2. **Every stock/money RPC takes a trailing `p_branch uuid default null`** and calls `resolve_branch(p_branch)` — staff can only act at their own branch, an admin may name any branch.
3. **Changing an RPC's parameter list means dropping the old signature first** (`drop function if exists ...`), then `create or replace` with the new one — leaving both creates an ambiguous overload PostgREST can't resolve. `create_sale` has been rewritten this way three times (batches → returns → pricing); check its current signature before assuming what it accepts.
4. **FIFO draws lock their rows with `for update`** so two tills can't sell the last unit twice.
5. **A new enum value goes in its own line at the top of the migration**, `add value if not exists`, and nothing in that same script may use the new value outside a function body (Postgres won't let a new enum value be used in the same transaction that adds it).
6. **Voids reverse a computed effect, never raw history.** `void_X` functions restock/refund based on what the original action actually did (its own consumption trace), and are refused outright — not partially applied — if reversing would be untrustworthy (e.g. the stock has since moved on, or issued store credit has already been spent). See `void_sale_return` in `0024_return_voids_and_policy.sql` for the fullest example.
7. **A test scenario in `supabase/tests/tests.sql` for everything.** Run via the PGlite harness (below) before considering any SQL change done. When a new migration changes an existing RPC's behavior, re-run the *whole* suite, not just new tests — regressions in old sections are real and have happened.

## Testing (run all three before considering anything done)

```bash
# 1. Database — PGlite (Postgres-in-WASM) harness, runs every migration then the test script
NODE_PATH=<scratchpad>/pgtest/node_modules node supabase/tests/harness.js \
  --pre supabase/tests/pre.sql --before 0020 --test supabase/tests/tests.sql
```
The `@electric-sql/pglite` package isn't in `package.json` (it's a dev-only test dependency installed once into the session's scratchpad, not the repo) — if `NODE_PATH` doesn't resolve, `npm install @electric-sql/pglite` somewhere and point `NODE_PATH` at its `node_modules`. See `supabase/tests/README.md`.

```bash
# 2. TypeScript
npx tsc --noEmit

# 3. Jest (unit tests for pure TS helpers + a few component tests)
CI=true npx react-scripts test --watchAll=false

# 4. Production build (also runs ESLint with warnings-as-errors under CI=true)
CI=true npm run build   # uses --max-old-space-size=8192; don't strip that flag, OOM crashes otherwise
rm -rf build            # clean up — build/ isn't committed
```

Current state on this branch: DB harness 206/206, tsc clean, jest 103/103, build succeeds at ~152 kB gzip (main bundle).

## Migration reference (`supabase/migrations/`)

| File | Purpose | Live in prod? |
|---|---|---|
| 0001–0016 | Core schema, FIFO engine, VAT, billing, barcodes, branches (early cut), product profitability | ✅ yes |
| 0017_role_enforcement.sql | Per-table role-based RLS, `guard_money_write`/`guard_void` triggers, tenant suspension → read-only | ❌ **run this next** |
| 0018_dashboard_summary.sql | Role-shaped `dashboard_summary()` jsonb RPC | ❌ pending |
| 0019_billing_and_storage_fixes.sql | `plan_tier` gets `'business'`; logo upload confined to the caller's tenant folder | ✅ **already run** |
| 0020_branch_stock.sql | The big one — real multi-branch stock, `stock_levels()`, `transfer_stock()`, `adjust_stock()`, engine rewritten branch-aware | ❌ pending |
| 0021_foundations.sql | Sequential doc numbers (`next_doc_no`), `log_audit()`, plan-gating (`tenant_has_feature`) | ❌ pending |
| 0022_batch_expiry.sql | Batch numbers, manufacture/expiry dates, FEFO picking, expired/recalled stock blocked from sale, `batch_trace()` | ❌ pending |
| 0023_returns.sql | Partial customer/supplier returns, store credit, `create_sale_return`/`create_purchase_return` | ❌ pending |
| 0024_return_voids_and_policy.sql | `void_sale_return`/`void_purchase_return`, configurable `tenants.cashier_returns` policy | ❌ pending |
| 0025_pricing.sql | Price lists, quantity breaks, per-role discount limits with manager-PIN approval, below-cost warning | ❌ pending |
| 0026_shifts.sql | Registers, shifts, cash-up (`open_shift`/`close_shift`/`add_cash_movement`/`x_report`/`z_report`), `payment_types.method_group` | ❌ pending |

**0017 → 0026 must run in that exact order**, in one sitting if possible — several depend on functions or columns the previous one added. Each file's own header comment states what it must run after; trust the file over this table if they ever disagree.

## Key files

- `src/lib/api.ts` — the one place every Supabase call goes through (typed data-access layer + RPC wrappers). If you're about to call `supabase.from(...)` or `supabase.rpc(...)` directly from a page component, stop — add it here instead.
- `src/lib/hooks.ts` — `useQuery`/`useMutation`, with offline `cacheKey` fallback support.
- `src/lib/AuthContext.tsx`, `src/lib/permissions.ts` — auth state and client-side role gating.
- `src/lib/useBranches.ts`, `src/lib/branchStock.ts` — branch context and pure stock-quantity helpers (unit-tested).
- `src/lib/batches.ts` — date/expiry helpers mirroring the batch-expiry SQL logic, for display and CSV import parsing.
- `src/lib/pricing.ts` — client-side price-list resolution, mirroring `resolve_price()` by hand for instant POS/Sales previews. The server (`create_sale`) is still the only actual authority; this exists purely so the UI doesn't need a round trip per keystroke.
- `src/lib/features.ts` — mirrors the server's `plan_level()`/`feature_level()` mapping, for "upgrade to X plan" UI messaging only.
- `src/lib/invoice.ts` — invoice **and credit note** PDF generation.
- `src/lib/offlineQueue.ts` — the offline write queue (`QueuedOp` union: `sale` | `sale_payment`, easy to extend).
- `src/lib/useTillGate.ts` — whether this tenant requires an open till for selling and whether the signed-in person has one; POS reads this to decide what to render. `src/components/OpenTillScreen.tsx`, `TillHeader.tsx`, `CashMovementModal.tsx`, `CloseTillModal.tsx` are the till UI it drives (migration 0026).
- `src/components/Modal.tsx` (+ `useModalA11y` hook) — the shared modal shell; every dialog in the app should use this, not a bespoke overlay.
- `src/components/ApprovalModal.tsx`, `src/components/LinePriceModal.tsx` — manager-PIN approval and per-line price/discount editing, shared between POS and Sales.
- `src/pages/Sales.tsx` — exports `ReturnModal`, reused by `POS.tsx` for the "Returns" counter flow. If you need the return UI somewhere else, import it from here rather than duplicating it.
- `src/pages/Dashboard.tsx` — exports `CashierDashboard`/`InventoryDashboard`/`OwnerDashboard`/`DashboardView`, one genuinely different layout per role, all driven by the single `dashboard_summary()` payload.
- `src/dev/DashboardPreview.tsx` (route `/__dev/dashboards`) — renders all three dashboards from fixture data with no sign-in needed. Registered in `App.tsx` only when `NODE_ENV === 'development'`; confirmed stripped from the production bundle by grepping the built JS for the chunk name.
- `supabase/tests/` — `harness.js` (the PGlite runner), `pre.sql` (a legacy pre-0020 tenant, for backfill/migration testing), `tests.sql` (the whole scenario suite — 190-ish assertions and counting), `README.md`.
- `supabase/functions/paystack-verify/index.ts`, `supabase/functions/invite-teammate/index.ts` — Deno Edge Functions, deployed manually via the Supabase dashboard, not part of the frontend build.
- `.claude/launch.json` — the `stockflow` dev-server config used by the Browser-pane preview tooling (`cd repo && BROWSER=none PORT=3000 npm start`).

## The competitor-gap plan (why all this exists)

`FEATURE_PLAN.md` at the repo root is the full 7-phase plan this work is executing, written after an international/local competitor review (Katana, Zoho, inFlow, Cin7, Bumpa, Moniepoint Moniebook) plus NAFDAC and NRS e-invoicing regulation. `COMPETE_ROADMAP.md` is the older, higher-level version of the same reasoning. Read `FEATURE_PLAN.md`'s "Ground rules for every phase" section (the source the "Engine conventions" section above was distilled from) before starting Phase 4.

**Status:**

| Phase | What it is | Done? |
|---|---|---|
| 0 | Foundations — doc numbers, audit log, plan gating | ✅ done (0021) |
| 1 | Batch numbers, manufacture/expiry dates, NAFDAC labels, recall trace | ✅ done (0022) |
| 2 | Partial returns, credit notes, store credit, supplier returns, **void a return**, POS-integrated returns, configurable cashier-return policy | ✅ done (0023, 0024) |
| 3 | Price lists, quantity breaks, per-role discount limits with manager PIN, below-cost warning | ✅ done (0025) |
| 4 | Shifts and cash-up (X/Z reports) | ✅ done (0026) |
| 5 | Automatic payment confirmation (Paystack dedicated accounts / pay links) | **not started — next up** |
| 6 | Quotes, real purchase orders (ordered before received), units of measure, delivery notes, custom fields, audit-log viewer | not started |
| 7 | Smart reorder suggestions, an AI assistant over the app's own data, e-invoicing (NRS) readiness | not started |

Next migration number is **`0027`** (the plan document's original numbering assumed Phase 2 would be one migration; it became two — `0023` + `0024` — so everything from Phase 5 onward is shifted by one versus what `FEATURE_PLAN.md` literally says. Trust the migrations directory, not the plan doc's file names, for what number to use next).

### Phase 4, as shipped (0026)

Registers/tills, per-branch: open with a float, ring sales against the open shift, close with a blind cash count, X report (read-only any time) and Z report (final, numbered like every other document via `next_doc_no`). Ties into `payment_types.method_group` (cash vs. transfer vs. card vs. store_credit vs. other) so "expected cash" is computable — `handle_new_user` seeds new tenants' Cash/Bank Transfer types with the right group directly, since the migration-time backfill only reaches rows that already existed.

- **Engine:** `open_shift`, `add_cash_movement` (pay-in/pay-out/drop, a pay-out over `shift_rules.pay_out_limit` needs the same manager-PIN mechanism as Phase 3's discounts), `close_shift` (returns the Z report), `x_report`/`z_report`, plus `current_open_shift()`/`shift_required()` helpers. `create_sale`, `record_sale_payment`, `create_sale_return`'s cash refund, and `spend_store_credit` all tag the caller's open shift **on their own** — no client-side plumbing needed to link a sale to a till.
- **Opt-in by design:** `shift_rules.required_for` defaults to `[]`, not `["sales"]` — the alternative would lock every existing tenant out of selling the instant `0026` runs, before any till exists. An admin turns it on under **Settings → Business** once registers are set up under **Settings → Branches**.
- **Frontend:** `src/lib/useTillGate.ts` decides whether POS should show `OpenTillScreen` (till required, none open) or `TillHeader` (a till chip with Pay in/out, X report, Close till) above the normal POS layout — see `src/pages/POS.tsx`. A network failure while checking fails **open** (lets the cashier keep selling), matching the offline-first philosophy elsewhere in the app.
- See `FEATURE_PLAN.md`'s Phase 4 section for the original schema sketch — it was written before Phases 1–3 existed, so a few specifics there don't match what shipped (see `FEATURE_PLAN.md`'s own note on this).

### Known gaps deferred so far (ask before building unless told to just do it)

- Quantity breaks beyond the first aren't editable in the Settings → Pricing UI (the database fully supports them — `price_list_items.min_qty`).
- The Reports → Discounts tab only aggregates line-level discounts, not order-level flat discounts.
- An over-the-limit discount attempted while offline fails when the queued sale syncs, rather than prompting for a PIN at that point — the cashier needs to redo it from the Sales page once back online.
- Returns aren't queueable offline at all (by design — a return checks live FIFO batches and balances, same reasoning as why stock-receiving isn't offline-capable either).
- POS's "Returns" counter finds a sale by typed invoice number only, no barcode/receipt scan yet.
- Phase 4 shipped engine-complete but UI-partial: no owner-dashboard "shift short" attention card, no Reports → Shifts tab (Z report history, variance per cashier over time), no denomination-breakdown counting UI (Close Till just takes one total), and no printable/thermal Z report layout. `x_report()`/`z_report()` already return every figure those screens would need — it's pure frontend work whenever it's prioritized.
- An offline-queued sale made while a till was required but not open (or was open and then closed before sync) fails when it reaches the server — same pattern as an over-the-limit offline discount, surfaced in the Pending Sync panel for the cashier to redo online.
- Registers can only be added at a branch that already has one (multi-branch tenants, via Settings → Branches); a single-branch tenant that wants a second physical till has to be given one directly in the database for now.

## How the user works

- Prefers autonomous, uninterrupted building — "proceed" means keep going through a whole phase, verifying via the test suite rather than pausing to ask.
- Chooses between architectural options when asked directly (e.g. picked "separate stores, own stock" over a shared-pool multi-branch model), but doesn't want to be asked about things with an obvious default.
- Wants both technical soundness (real FIFO accounting, server-enforced roles, a real test suite) and commercial realism (regulatory compliance, competitor positioning, pricing that matches Nigerian SME willingness to pay).
- Runs everything from the Claude Code desktop app; there is no separate terminal session to hand off to — work happens directly in this environment via the tool calls in the session transcript.
