# StockFlow — Build Audit

Source-verified status of `jokesan-sales-app`. Every claim below came from reading the code, not from a
checklist. **Audited 22 Aug 2026** on macOS (Node 24.19), after the project moved over from the Windows box.

Read this before trusting `UX_IMPROVEMENT_PLAN.md`, `IMPLEMENTATION_PLAN.md`, or `git log` — all three are
out of date (see [Document drift](#document-drift)).

## Health

| Check | Result | Detail |
|---|---|---|
| TypeScript | **Clean** | `npx tsc --noEmit` → 0 errors |
| Production build | **Passes** | `npm run build` → exit 0, "Compiled successfully", 0 warnings |
| Test suite | **Passing** | 30 tests, 5 suites, all green |
| Run locally | **Blocked** | `.env` now correct, but the Supabase host is dead (see [outage](#production-outage--supabase-project-unreachable)) |

`npm install` completed clean. Scale: 20 pages · 18 routes · 27 tables · 16 migrations · 21 SQL functions ·
~9,200 lines. Initial JS payload **148 kB gzipped** (was 594 kB).

## What's actually built

Confirmed present and wired:

**Costing engine** — all 8 FIFO RPCs (`create_sale`, `create_purchase`, `record_production`,
`record_sale_payment`, `record_purchase_payment`, `void_sale`, `void_purchase`, `void_production`), all
tenant-scoped `SECURITY DEFINER`. Money-moving writes go through RPCs, never direct table writes. COGS and
gross profit stamped on every sale. BOM editor under Settings → Recipes.

**Access control** — route gating via `ProtectedRoute` + `canAccess` for all four tenant roles; deactivated
accounts blocked at the shell; Super Admin gated twice (client redirect + `is_platform_admin()` raising in
SQL); auto tenant-stamping triggers on direct-insert tables.

**Day-to-day screens** — full CRUD with edit/delete row actions on all nine list pages; detail views wired
for sales, purchases, production; shared `DataTable` with search, sort, pagination and Excel/CSV/PDF export;
friendly foreign-key delete errors.

**Counter and field use** — POS with barcode scan, tendered-cash flow, printed receipt; offline sale queue
replaying through the real engine (server stays authoritative); service worker + offline read cache +
pending-sync panel; barcode label PDFs.

**Money and compliance** — Paystack plans, Popup checkout, server-side verify Edge Function; VAT threaded
through sales, POS and invoice PDFs; Reports (P&L, Sales, Expenses, Stock value, Debtors) with date range and
export; bank-alert paste matcher at `/match-payment`.

**Growth surface** — Smart Insights with 7 rule types; team invites via Edge Function email with WhatsApp
fallback; branch management, logo upload, tenant settings; CSV import wizard; WhatsApp debtor reminders.

## Findings

Ranked by consequence, not effort.

### 1. ~~"Load Sample Data" seeds the original client's real contacts into any tenant~~ — FIXED 22 Aug

`src/pages/Inventory.tsx:118-124` — a new tenant with an empty materials list sees a "Start with sample data"
card calling `seed_sample_data()`. That function (`supabase/migrations/0003_seed.sql`) writes into **the
caller's own tenant**, including a supplier named Shakirat Oguntunde at Easycomp Tech and a customer named
Bola Adesanya. The only guard is "no materials exist yet" — no role check, no email gate.

**Why it matters:** this is exactly what `HANDOVER.md` constraint #2 forbids (no demo-data UI anywhere). A
paying customer who clicks it gets a stranger's name and phone number in their live customer list, with no
way to distinguish seeded rows from their own.

**Fixed:** the empty-state card now just prompts "Add Material" and points at Import Data. The `demo.seed`
wrapper is gone from `src/lib/api.ts`, and migration `0015_lock_sample_data.sql` revokes execute on
`seed_sample_data()` from `anon`/`authenticated`/`public` so the RPC can't be hit through PostgREST either.
Demo data is now reachable only via `seed_demo_data_for('oguntunde123@gmail.com')` from the SQL Editor.
**0015 still needs to be run in Supabase.**

### 2. ~~Reports go quietly wrong past 1,000 sales~~ — FIXED 22 Aug

`src/lib/api.ts:250-252` — `salesSummary()`, `expenseSummary()` and `purchaseSummary()` select every row with
no `.range()` and no `.limit()`. PostgREST caps a request at 1,000 rows by default and returns success. Every
`list()` in the data layer has the same shape.

**Why it matters:** P&L, Debtors and Smart Insights all read from these. Past 1,000 records they silently
under-report — no error, no warning, just a smaller number. For a product whose pitch is real FIFO accounting
rather than toy CRUD, a P&L that quietly drops rows is the worst possible bug.

**Fixed:** added a `runAll()` helper in `api.ts` that walks `.range()` windows until a page comes back
empty, advancing by however many rows actually arrived — so it stays correct whatever the server's cap is
set to, with a 100k-row runaway guard. Applied to all 12 unbounded reads (every `list()`, all three report
summaries, and the team roster). Covered by `src/lib/__tests__/pagination.test.ts`, which fakes a 1000-row
server cap and asserts a 2,500-row table comes back whole.

### 3. ~~594 kB of JavaScript before the login form draws~~ — FIXED 22 Aug

Zero code splitting — no `React.lazy` anywhere in `src/`. Tesseract OCR, `xlsx`, jsPDF, Recharts and
html5-qrcode all sit in the initial bundle, so a cashier who only opens the POS still downloads the OCR
engine and the spreadsheet writer.

**Why it matters:** the target user is a shop floor on a cheap Android over patchy network — the exact case
the offline work was built for. Route-level lazy loading plus deferring Tesseract to its own page would cut
first load hard, and it's mostly mechanical.

**Fixed: 594 kB → 148 kB gzipped, a 75% cut.** All 18 authenticated routes are now `React.lazy` behind a
`Suspense` inside the layout shell, so the sidebar stays put while a page's chunk loads; Login stays eager.
The heavy libraries moved to dynamic `import()` at their point of use — Tesseract in `ocr.ts`, xlsx and
jsPDF in `exporters.ts`, jsPDF in `invoice.ts`, jsbarcode + jsPDF in `barcodeLabels.ts`. `whatsappLink` was
split out into `src/lib/whatsapp.ts` because Dashboard and Reports were importing `invoice.ts` — and
dragging in the whole PDF engine — purely for a string builder. Export and PDF calls are now awaited with
error handling rather than left as floating promises.

### 4. ~~The test suite doesn't run at all~~ — FIXED 22 Aug

`src/App.test.tsx` is still untouched CRA boilerplate looking for a "learn react" link. It never reaches the
assertion — Jest can't resolve `react-router-dom` v7 (ESM) under CRA's config, so the suite fails at import.
**Zero tests execute.**

**Why it matters:** the FIFO engine is the core IP and has no automated coverage. Cheapest fix is deleting
the boilerplate test; the valuable one is pgTAP or SQL fixtures over `create_sale` / `record_production` /
`void_sale`, where a regression costs real money.

**Fixed: 30 tests across 5 suites, all passing.** Three separate breakages had to be cleared: the CRA
boilerplate test (deleted), react-router-dom v7's `main` field pointing at a non-existent `dist/main.js`
(mapped in `package.json` → `jest.moduleNameMapper`, along with its `react-router/dom` subpath), and
`TextEncoder` being absent from the jsdom that ships with Jest 27, which react-router touches at import
time (polyfilled in `setupTests.ts`). New coverage: the pagination walk, the bank-alert parser and matcher,
WhatsApp number normalisation, and modal keyboard behaviour.

**A test caught a real bug while being written.** `rankMatches` in `bankAlert.ts` added a recency nudge to
every candidate unconditionally, which lifted every open invoice above its own `score > 0` filter — so
pasting a bank alert that matched nothing still offered unrelated invoices as candidates. That is how a
payment gets applied to the wrong customer. The nudge is now gated on something having actually matched.

### 5. ~~No modal is keyboard-operable~~ — FIXED 22 Aug

Across ~15 dialogs: no `role="dialog"`, no `aria-modal`, no Escape-to-close, no focus trap, no focus return.
Only one inline rename field in Settings handles Escape.

**Why it matters:** a keyboard or screen-reader user can open a form they can't close. It's also the last
unticked item from the UX plan, and it's contained to one shared component.

**Fixed:** new `useModalA11y` hook plus a `<Modal>` shell, and all **20** dialogs across 14 files converted
to it. Each now gets `role="dialog"`, `aria-modal`, a label adopted from its own heading, focus moved to
the first control on open, Tab trapped and wrapped at both ends, Escape to close, focus returned to
whatever opened it, and background scroll locked while open. The markup and styling are unchanged, so
nothing looks different. Covered by `src/components/__tests__/Modal.test.tsx`.

### 6. ~~Creditors and product profitability were planned but never built~~ — FIXED 22 Aug

`src/pages/Reports.tsx:15-20` ships five tabs: P&L, Sales, Expenses, Stock, Debtors. The plan also called for
**Creditors** (what you owe suppliers) and **product profitability**. Neither exists, though the data for
both already sits in `purchase_orders` and `sale_items`.

**Why it matters:** Debtors without Creditors tells an owner half their cash position. Product profitability
is the screen that shows a buyer what the FIFO engine is *for*.

**Fixed:** two new Reports tabs. **Creditors** mirrors Debtors from the other side — outstanding supplier
balances grouped by supplier, aggregated client-side from the now-paged purchases and suppliers lists.
**Product Profit** is backed by a new `report_product_profitability(p_from, p_to)` RPC
(`0016_product_profitability.sql`) that costs each line from the FIFO layers the engine actually consumed
in `sales_consumption` — not an average — excludes voided sales, and aggregates in SQL so it can't hit the
row cap. Both tabs export to Excel and PDF like the rest. **0016 still needs running in Supabase.**

### 7. ~~Offline reload only works on pages already visited online~~ — FIXED 22 Aug

`public/service-worker.js` is cache-first on exact URLs with no navigation fallback to `index.html` and no
precache list. Reloading a route the device never opened while online drops to the browser error page.
Cache-first also means a deploy takes an extra reload to appear, and `CACHE_NAME` is hardcoded `v1` rather
than tied to the build hash.

**Why it matters:** small day to day, but it undercuts the offline promise at the moment it's most needed —
the cashier who reloads mid-shift with no signal.

**Fixed:** the worker now splits its strategy by request type. Navigations go network-first with the
precached shell as the offline fallback, so any route opens offline whether or not it was visited before —
and a fresh deploy shows up on the first reload instead of the second. Hashed `/static/**` assets stay
cache-first, which is safe because their filenames already carry a content hash. Cache bumped to
`stockflow-shell-v2` so the old one is dropped on activate.

### 8. ~~The credentials error points at a file that doesn't exist~~ — FIXED 22 Aug

`src/lib/supabase.ts:11` logs "Copy .env.example to .env and fill in your project values." There is no
`.env.example` in the repo and no `.env` on this machine. Required vars: `REACT_APP_SUPABASE_URL`,
`REACT_APP_SUPABASE_ANON_KEY`, `REACT_APP_PAYSTACK_PUBLIC_KEY`.

**Fixed:** `.env.example` added. The local credentials file existed but was named `env` with no leading dot,
which CRA ignores — renamed to `.env`, and `env` added to `.gitignore` so the undotted form can't be
committed by accident. Both values now compile into the bundle.

### 9. Still no branch switcher

`branch_id` is read onto the profile and branches are manageable in Settings, but one admin cannot operate
across branches in a single session — each branch needs its own login. Matches what `HANDOVER.md` already
documents as a deliberate non-goal; noted so it isn't rediscovered as a bug.

## Production outage — Supabase project unreachable

`https://jokesan-sales-app.vercel.app` cannot sign in. The browser console shows:

```
POST https://ovrcebvtcyeypzbkltet.supabase.co/auth/v1/token?grant_type=password
net::ERR_NAME_NOT_RESOLVED
```

`ERR_NAME_NOT_RESOLVED` is DNS, not auth. Confirmed from this machine:

| Check | Result |
|---|---|
| `host ovrcebvtcyeypzbkltet.supabase.co` | NXDOMAIN |
| `dig @1.1.1.1` / `dig @8.8.8.8` | no record |
| `host supabase.co` (control) | resolves fine |
| anon key `ref` claim | `ovrcebvtcyeypzbkltet` — matches the URL, so not a typo |
| anon key `exp` | year 2036 — not expired |

**The Supabase project no longer exists.** A *paused* free-tier project still resolves and returns an error
response; a project that has been removed stops resolving entirely, which is what's happening. Free projects
pause after about a week idle and are deleted after roughly 90 days paused.

Nothing in the frontend can fix this. Check the Supabase dashboard:

- **Listed as paused** → restore it, DNS returns, prod recovers with no code change.
- **Not listed** → it's gone, and a new project is needed. That means: run migrations 0001–0015 in order,
  recreate the `logos` storage bucket, re-insert the `platform_admins` row, redeploy both Edge Functions,
  re-set the `PAYSTACK_SECRET_KEY` secret, then update `REACT_APP_SUPABASE_URL` and
  `REACT_APP_SUPABASE_ANON_KEY` in **both** `.env` and Vercel's environment variables, and redeploy.
  All tenant data in that project is unrecoverable.

Note the local `.env` fix does nothing for production — Vercel holds its own copy of these variables.

## Document drift

- **`UX_IMPROVEMENT_PLAN.md` and `IMPLEMENTATION_PLAN.md` show nearly every box unchecked** — including
  DataTable, exporters, ConfirmDialog, PDF invoices, the Settings lookups editor, BOM editor, user management
  and branches. All built and working. Only modal a11y, server-side pagination, the branch switcher, and two
  reports genuinely remain.
- **`HANDOVER.md` paths are stale** — still `C:\Users\user1\Documents\My Project\jokesan-sales-app` and a
  Windows memory path. Project now lives at `/Users/mubby/Documents/jokesan-sales-app`.
- **Git history is five squashed commits** and doesn't reflect the described build history. Don't use
  `git log` to reconstruct what happened.

## Still open

1. **Restore or replace the Supabase project** — everything else is blocked behind this. See the outage
   section above.
2. **Run migrations 0015 and 0016** once there's a reachable database.
3. **Verify the fixes against a running app.** All of the above is verified by typecheck, a clean
   production build and 30 passing tests, but nothing has been exercised behind a login.
4. **Branch switcher** (finding 9) — unchanged, still a deliberate non-goal.
5. **Reconcile the plan docs** against what's shipped, so the roadmap is trustworthy again.
6. Optional: server-side pagination for the big list *screens*. `runAll()` makes the numbers correct, but a
   tenant with 20,000 sales still ships all of them to the browser to render one table page.

## Method and limits

Read every file under `src/` and `supabase/migrations/`, extracted the SQL function and table inventory,
traced each `HANDOVER.md` claim to its implementation, then ran `tsc --noEmit`, the Jest suite and a full
production build on this machine.

**Nothing here was verified against a running app.** There are no Supabase credentials on this Mac yet, so no
screen was loaded and no query was executed against live data. Findings 1, 2 and 7 are read from code and
would each be worth confirming once the app boots.
