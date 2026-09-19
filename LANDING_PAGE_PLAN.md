# StockFlow — Landing Page Implementation Plan

Status: **draft, not started.** v2 — rewritten 2026-09-18 after re-checking `HANDOVER.md`, which confirmed the whole 7-phase `FEATURE_PLAN.md` has now shipped (0001–0036, all live). v1 of this plan was a single-page site pitched at a much smaller product than what actually exists today; this version is a real multi-page site and a full, honest feature tour.

## 0. What this corrects from v1

Three notes from the last review, all folded in below:
1. **Multi-page, not a single scrolling page.** A product this deep (17 shipped phases) deserves a real site map, not one long page with anchors.
2. **Lead with the problem and how StockFlow solves it**, not a feature list first.
3. **Show everything that's actually groundbreaking** — the original draft picked 6–8 features; the real count, honestly organized, is closer to 25, and several of them (real FIFO costing, statistically-grounded reorder suggestions, an AI assistant scoped to the asking user's own role) are genuinely hard for a competitor to copy.
4. **Real screenshots from the real, logged-in app** — not the `/__dev/dashboards` fixture preview described in v1. See §4.

---

## 1. Routing architecture

`/` is still claimed twice — the public marketing root, and the protected `Dashboard` (`src/App.tsx`, nested inside `ProtectedRoute`). With four public marketing pages instead of one, the cleanest fix is React Router's layout-route pattern (already idiomatic for `react-router-dom` 7, already the version this app runs) — one gate component wraps all four marketing routes, mirroring how `ProtectedRoute` already wraps the entire authenticated app:

```tsx
<Route element={<PublicGate />}>
  <Route path="/"        element={<Home />} />
  <Route path="/product" element={<Product />} />
  <Route path="/pricing" element={<Pricing />} />
  <Route path="/faq"     element={<Faq />} />
</Route>
<Route path="/login" element={<Login />} />
<Route path="/accept-invite" element={<AcceptInvite />} />
<Route path="/*" element={<ProtectedRoute>...</ProtectedRoute>} />
```

`PublicGate` (new, `src/components/PublicGate.tsx`): reads `useAuth()`. Logged in → `<Navigate to="/dashboard" replace />` (no reason a signed-in owner should land on the pricing page instead of their dashboard). Logged out → renders `<MarketingLayout><Outlet /></MarketingLayout>` (nav + footer shell, then whichever of the four pages matched).

The dashboard itself moves from `path="/"` to `path="/dashboard"` inside the existing protected `<Routes>`. Confirmed blast radius from grepping the whole `src/` tree for every link/redirect that targets root — six spots, unchanged from the v1 finding:

| File | Change |
|---|---|
| `src/App.tsx` | Route restructure above; dashboard moves to `/dashboard`. |
| `src/components/PublicGate.tsx` *(new)* | The gate described above. |
| `src/components/ProtectedRoute.tsx:35` | Role-mismatch fallback `Navigate to="/"` → `/dashboard`. |
| `src/pages/SuperAdmin.tsx:20` | Non-admin fallback `Navigate to="/"` → `/dashboard`. |
| `src/pages/Login.tsx:15` | Post-login redirect `navigate('/')` → `/dashboard`. |
| `src/components/Layout.tsx:24` | Sidebar "Dashboard" nav item `to: '/'` → `/dashboard`. |

Same risk note as before: small blast radius, but the one step that silently breaks "go home" links if skipped. Build, then click through all six before writing marketing copy.

---

## 2. Audience and the problem/solution frame

Primary visitor: the owner of a Nigerian manufacturing/trading SME (soap, cosmetics, food, FMCG) currently running the business on a notebook, Excel, or a general-purpose selling app that doesn't know what anything actually *cost* to make.

Every major section pairs a **named problem** with the **specific, already-built thing** that answers it — this is the structure §3.1's Home page runs on, not just a feature list:

| The problem, in the owner's own words | What StockFlow actually does about it |
|---|---|
| "I sell for what feels right — I don't actually know my margin." | Real FIFO costing on every sale, all the way from raw material through production to finished-goods COGS. Not an estimate. |
| "Someone sent a fake bank alert and I only found out at closing." | Paystack pay links confirm themselves the moment a customer actually pays — no bank alert to read or trust. |
| "My storekeeper's WhatsApp is my inventory system." | Real-time stock levels, barcode scanning, and WhatsApp invoices/reminders sent *from* the system, not typed by hand into a chat. |
| "One branch runs out of stock while another has too much, and I never see it until it's a fire." | Branches with their own separate stock, transfers between them, and a per-branch dashboard for every role. |
| "A customer wants 2 of the 10 cartons back and I have no clean way to handle that." | Partial returns, credit notes, and store credit — not an all-or-nothing void. |
| "I have no idea what to reorder or when." | Reorder suggestions computed from real 90-day usage statistics and lead times, not a gut feeling. |
| "I don't know if I'm ready for the new e-invoicing rules." | A live readiness score against the actual NRS requirements, with a checklist of exactly what's missing. |

This table (or a close visual equivalent — problem card stacked directly above its answer) **is** the Home page's core section, more important than the feature grid that follows it.

---

## 3. Site map

### 3.1 Home (`/`)
Nav → Hero → Problem/solution pairing (§2's table, as content) → three signature capabilities with real screenshots (FIFO profit, branches + offline POS, WhatsApp + returns) → role-based dashboard showcase → pricing teaser (3 cards, "See full pricing" → `/pricing`) → FAQ teaser (3 questions, "See all FAQs" → `/faq`) → final CTA → footer. Home's job is the pitch in under two minutes; the exhaustive tour lives on Product.

### 3.2 Product (`/product`) — the full tour
This is the page that answers "show all the important and groundbreaking functions." Six real categories, each its own section with a screenshot, using only what's actually shipped (checked against `HANDOVER.md`'s migration table — nothing here is aspirational):

**Sell & get paid**
- Point-of-sale that works with no signal — queues offline, syncs for real when back online (not a toy cache).
- WhatsApp invoices and debtor reminders, sent as real deep links, no app for the customer to install.
- Quotes and proforma invoices that convert straight into a real sale with one click.
- Price lists, quantity breaks, and per-role discount limits — a steep discount needs a manager's PIN before it's charged.
- Paystack pay links: a customer's transfer confirms itself the moment it lands, no bank-alert guessing.
- Partial returns, credit notes, and store credit — not an all-or-nothing void.
- Shifts and cash-up: open a till with a float, close it with a blind count, get an X or Z report.
- Delivery notes and waybills, generated straight from a sale.

**Know your real profit**
- FIFO costing, genuinely tracked layer by layer from raw material to finished good to sale.
- Product profitability and discount reports, costed from the actual batches a sale drew from — not an average.
- A dashboard shaped differently for a cashier, a storekeeper, and an owner — everyone sees what their job needs, nothing they don't.

**Run inventory & production**
- Branches with their own separate stock, and transfers between them that preserve original cost.
- Batch numbers and expiry dates, NAFDAC-shaped labels, first-expiry-first-out picking, and a full recall trace ("which batch went where").
- Units of measure — buy by the carton, sell by the piece, scan a carton's barcode and get 12 in the cart in one tap.
- Barcode labels, printed in one click.
- Reorder suggestions computed from real 90-day usage statistics, variability, and lead time — not a guess, and every number in it is a plain, checkable calculation.

**Purchasing**
- Quick purchase for a supplier who delivers on the spot.
- Real purchase orders for a supplier who ships later — nothing is owed until goods actually arrive.
- Supplier returns, drawn from the exact batch, only from what's still unused.

**Compliance & control**
- VAT built in.
- A live e-invoicing (NRS) readiness score with a checklist of exactly what's missing before the 2027/2028 enforcement dates.
- A full audit log — who changed a role, a price, a business setting, and what it was before.
- Four real roles (admin, sales, inventory, accounts), enforced by the database itself, not just hidden in the menu.
- Custom fields — add the field your business actually needs, on customers, products, or a sale.

**Ask StockFlow**
Its own spotlight, not folded into a bullet list — a chat built into the app that can actually check today's numbers, stock levels, and reorder suggestions for the person asking, scoped to exactly what their role is allowed to see. Genuinely novel in this market; worth a full section with a real screenshot of a real answered question.

### 3.3 Pricing (`/pricing`)
The same three tiers as Home's teaser, in full — reads straight from `src/lib/api.ts`'s `PLANS` array so the page can never drift from what Paystack actually charges. Every card: "14-day free trial, no card required" (accurate — `tenants.trial_ends_at` defaults to `now() + 14 days` on signup, confirmed in `0001_init.sql`). A short FAQ under the table for billing-specific questions (what happens if I downgrade, can I switch plans, is my data safe if I stop paying).

### 3.4 FAQ (`/faq`)
Product questions that don't belong on Pricing: does it work with no internet, can each branch have its own stock, is this ready for the new e-invoicing rules (careful wording here — it's a *readiness score*, StockFlow doesn't yet submit e-invoices to NRS directly, since no accredited provider is connected yet), can I bring in my Excel/notebook records (→ CSV import), what happens to a fake bank alert now.

---

## 4. Screenshots — from the real, logged-in app

v1 proposed screenshotting the `/__dev/dashboards` fixture-data preview. Correcting that: `oguntunde123@gmail.com` is StockFlow's own dedicated pitch/demo account (per the hard constraints in `HANDOVER.md` — sample data exists there and only there, specifically for exactly this kind of use), so it's the right account to actually log into and capture real screens from, not a synthetic fixture.

**Blocked on one thing:** the demo account's password isn't stored anywhere in this project or its memory (checked). Needs it from the user before this step can run.

Once available, the capture list (dev server already running on `:3000`, via the `stockflow` launch config):

| Screen | Route | Proves |
|---|---|---|
| Owner dashboard | `/dashboard` (admin login) | Hero image — the whole-business view. |
| Cashier dashboard | `/dashboard` (sales login, if a second seeded user exists — else note as a gap) | The role-shaped dashboard claim. |
| Storekeeper dashboard | `/dashboard` (inventory login) | Same. |
| POS, mid-sale | `/pos` | Real product, not a mockup. |
| Sales list with a credit note | `/sales` | Returns/credit notes are real. |
| Inventory with a batch/expiry | `/inventory` or `/batches` | NAFDAC-shaped tracking. |
| Quotes list | `/quotes` | Quotes/proforma. |
| Purchases, an order awaiting receipt | `/purchases` | Real purchase orders. |
| Deliveries | `/deliveries` | Waybills. |
| Reports → Product Profitability | `/reports` | Real FIFO-costed margin. |
| Ask StockFlow, a real answered question | `/assistant` | The AI assistant, the novel differentiator. |
| Settings → E-Invoicing tab | `/settings` | The readiness score. |

Each screenshot gets wrapped in a plain browser-chrome frame (a small shared `ScreenshotFrame` component, not a heavy device mockup asset) so it reads as "real software" rather than marketing art — consistent with §7's "real screenshots over stock art" stance from v1.

---

## 5. File structure

```
src/marketing/
  MarketingLayout.tsx        -- nav + footer shell, wraps every page below via <Outlet/>
  MarketingLayout.scss
  pages/
    Home.tsx
    Product.tsx
    Pricing.tsx
    Faq.tsx
  sections/                  -- reused across pages, not duplicated per-page
    Hero.tsx
    ProblemSolution.tsx       -- §2's table, as a real component
    FeatureCategory.tsx       -- one of Product's six category blocks
    ScreenshotFrame.tsx       -- the browser-chrome wrapper, §4
    DashboardShowcase.tsx
    PricingTable.tsx          -- imports PLANS from '../../lib/api', used by both Home and Pricing
    FaqList.tsx
    FinalCta.tsx
  MarketingNav.tsx
  MarketingFooter.tsx
src/components/PublicGate.tsx
```

Reuses the existing design tokens (`src/styles/_variables.scss`, `_mixins.scss`) — locked `#2563eb` accent, Plus Jakarta Sans, the same navy used for the authenticated sidebar for any dark section, so moving from marketing site into the real product doesn't feel like two companies. SCSS only, per the standing rule.

Each of the four pages is its own lazy-loaded chunk (`React.lazy`, matching every other route in `App.tsx`) so an unauthenticated visitor's first paint doesn't pull in the authenticated app bundle, and vice versa.

---

## 6. A gap this plan still surfaces: no Terms of Service or Privacy Policy

Unchanged from v1, re-checked — still true. A public signup form collecting an email, a company name, and eventually a Paystack card really does need these before the footer links go live. Treated as its own small piece of work, content drafted and reviewed by the user rather than invented and shipped silently; footer links point at WhatsApp/email in the meantime if they're not ready.

---

## 7. SEO — and its real limit

Unchanged from v1: `public/index.html` already carries an accurate static title/description/OG tags. With four real routes instead of one, each page gets its own `<title>`/description via a small hand-rolled `useMeta` hook (no new dependency) — genuinely more useful now than it would have been for a single-page site. The underlying limit is unchanged: CRA has no server-side rendering, so a crawler that doesn't execute JavaScript sees an empty shell on every route. `robots.txt` + a `sitemap.xml` naming the four public paths is worth doing; real prerendering is a future decision, not part of this build.

---

## 8. CTA and signup flow

Unchanged from v1 — signup already works end to end (`Login.tsx`'s `signUp`, 14-day trial). `Start free trial` buttons across all four pages link to `/login?signup=1`; `Login.tsx` opens directly in sign-up mode on that param. Wiring, not building.

---

## 9. Build phases

1. **Routing migration** (§1) — move the dashboard, add `PublicGate`, fix the six link/redirect sites. Build, click through, confirm nothing 404s — before any marketing content exists.
2. **Shell** — `MarketingLayout`, `MarketingNav`, `MarketingFooter`, four empty pages wired into the router.
3. **Get the demo login and capture every screenshot in §4** — this now blocks real content on three of the four pages, so it happens early, not last.
4. **Home** — hero, problem/solution table, three signature capabilities, dashboard showcase, pricing teaser, FAQ teaser, final CTA.
5. **Product** — all six categories, full copy from §3.2, one screenshot per category.
6. **Pricing** — full table + billing FAQ.
7. **FAQ** — the full list from §3.4.
8. **Signup deep-link** (§8) — the one small `Login.tsx` change.
9. **Terms/Privacy stubs** (§6) — only once content exists.
10. **SEO pass** (§7) — per-page meta, `robots.txt`, `sitemap.xml`.

Each phase independently shippable.

---

## 10. Verification

- `tsc --noEmit` clean.
- Production build exits 0; bundle report confirms all four marketing pages are their own lazy chunks.
- Browser-pane check at 375px and desktop for all four pages: no horizontal scroll, nav collapses sensibly, Product's category sections and Pricing's cards stack correctly.
- Click-through: logged out → `/`, `/product`, `/pricing`, `/faq` all render; a signed-in session hitting any of the four redirects straight to `/dashboard`; `Start free trial` pre-opens signup; a real signup lands on `/dashboard`; logging out returns to `/`, not a stale cached dashboard.
- All six routing-migration link sites (§1) resolve correctly post-change.

---

## 11. Open decisions for the user

1. **The demo login (§4)** — the password for `oguntunde123@gmail.com` isn't in this project or its memory. Needed before real screenshots can be captured.
2. **A second seeded user on the demo account** — is there a sales/inventory-role login on the demo tenant too (for the Cashier/Storekeeper dashboard screenshots), or does that need creating?
3. **Social proof** — still no publicized customers. Recommendation unchanged from v1: omit rather than fabricate, revisit once a real one exists.
4. **Terms/Privacy** (§6) — does content already exist somewhere, or does it need drafting from scratch?

Nothing above blocks starting Phase 1 (§1's routing migration) or Phase 2 (the empty shell) — both are safe to begin regardless of how these are answered.
