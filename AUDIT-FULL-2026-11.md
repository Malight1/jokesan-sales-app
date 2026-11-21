# ProfixBook: full audit, second pass (21 November 2026)

The first report (`AUDIT-2026-11.md`) started from the client's complaints and covers what was fixed today. This second pass reads the actual logic of every page, the database rules and the backend functions. It also compares the app with what a Nigerian shop or small manufacturer expects. It covers **what is wrong, what is missing, and what should be better**, in priority order.

**Bottom line:** the core is strong. Stock is costed properly (FIFO), separated by branch, offline selling works, roles are enforced in the database, and there are 530 automated database checks. The problems are:
- a few money figures that are wrong after a return,
- two gaps that allow fraud,
- features owners will ask for that don't exist yet (statements, end-of-day report, product categories, stock take),
- deployment steps still waiting in Supabase.

---

## 1. Not live yet (do first)

| # | Item | Status |
|---|---|---|
| 1.1 | Migration **0053** (join links, supplier bank details) | Not run in Supabase |
| 1.2 | Edge function **accept-invite** (new, JWT verification OFF) | Not deployed |
| 1.3 | Edge function **invite-teammate** (new code, sends the invite email through Resend) | Old version still deployed |
| 1.4 | Migration **0054** (Cashier role) | Not run in Supabase |
| 1.5 | Cashier role code | Built and tested, **not committed or pushed** |
| 1.8 | Migration **0055** (money and fraud fixes, section 2) | Not run in Supabase; run after 0054 |
| 1.6 | `ticket-notify` (support emails) | Only works if the Resend key is set, which you say it is. Check by replying to a support ticket |
| 1.7 | Paystack webhook | Each business pastes the URL into its own Paystack dashboard. Settings → Payments now shows the URL with a copy button |

Until 1.1 to 1.3 are done, team invites still don't work live.

---

## 2. Wrong numbers and fraud gaps (fix next)

These are real defects, found in the code.

**Status (21 Nov, later the same day): all eight fixed, not yet deployed.** Database part in migration `0055_money_and_fraud_fixes.sql` (19 new database checks, 549/549 passing); app part in Reports, Sales Orders, Quotes, the till and `api.ts`.
- 2.1: Reports now take returns off sales, cost and profit, on the day of the return. The owner dashboard's month figures already did this (since 0047), so only Reports was wrong.
- 2.2: the P&L shows Sales before VAT, less returns, Revenue, COGS, Gross Profit; VAT collected is shown separately. Revenue minus COGS now equals Gross Profit. The dashboard's "sales" figures stay as takings including VAT, which matches the cash drawer.
- 2.3: only admin and accounts can date a sale on another day. Others get today, or up to 3 days back so offline sales still sync; anything older than yesterday goes in the audit log. The till now sends the shop's date, not UTC.
- 2.4: manager PINs (discounts, pay-outs, quote conversions) are checked first by `check_approval_pin`, which records every try and locks after 5 wrong in 10 minutes. The engine only accepts a PIN that passed that check, once.
- 2.5 / 2.6: New Sale defaults to the full amount and refuses a balance with no customer; a walk-in quote can't be turned into a sale on credit.
- 2.7: Record payment no longer lists "Credit".
- 2.8: New Sale checks and shows the branch's sellable stock.

| # | Problem | Where | Why it matters | Fix |
|---|---|---|---|---|
| 2.1 | **Returns are not taken off the figures** | Reports (P&L, Sales); owner dashboard "this month" / "last month" | Refund ₦50,000 and Reports still shows the ₦50,000 as sales and profit. The all-time figure does take returns off, so screens disagree with each other | Subtract `returned_total` / `returned_profit` everywhere (the retail all-time figure already does) |
| 2.2 | **"Revenue" includes VAT** (profit is correct: it already leaves VAT out) | Reports P&L "Revenue", dashboard sales figures | For a VAT business, Revenue is 7.5% too high, and on the P&L Revenue minus Cost of Goods doesn't equal Gross Profit, which confuses accountants | Show revenue before VAT, with VAT collected as its own line |
| 2.3 | **Any role can date a sale on any day**, past or future | `create_sale` (database), New Sale form | A cashier can backdate sales into a closed day, push sales into next month, or get round expiry checks (the expiry check uses the sale date) | Only admin/accounts may pick a date other than today; the database enforces it |
| 2.4 | **Discount PIN has no attempt limit** | `create_sale` approval | A cashier with basic tech knowledge could try all 10,000 four-digit PINs. Return approvals now lock after 5 wrong PINs; discount approvals don't | Same 5-tries lockout for discount PINs, and log failed tries |
| 2.5 | **New Sale form starts with "amount paid" at ₦0 and allows a walk-in** | Sales Orders → New Sale | A forgotten field silently records an unpaid sale, and with no customer named it can never be collected | Default to the full amount; require a customer whenever something is left owing (the till already does this) |
| 2.6 | **Turning a quote into a sale on credit allows a walk-in** | Quotes → Turn into a sale | Same uncollectable debt | Require a customer for "Not paid yet" |
| 2.7 | **Record payment can default to the "Credit" payment type** | Sales Orders → Record payment | A payment recorded as "Credit" means nothing was actually received | Leave Credit out of that list (Customers and Suppliers already do) |
| 2.8 | **New Sale checks company-wide stock, not the branch's** | Sales Orders → New Sale (multi-branch) | Lets staff try to sell stock that's in another branch; the server then refuses with an error | Use branch stock, like the till does |

---

## 3. Gaps in the new Cashier role

| # | Gap | Fix |
|---|---|---|
| 3.1 | **A cashier can't add a new customer**, but credit needs a named customer | A small "New customer" button (name and phone) right in the till's customer picker |
| 3.2 | No way to set a **credit limit** per cashier or per customer | Optional limits: e.g. a cashier can give up to ₦20,000 credit a day, a customer can owe up to ₦50,000; above that, PIN |
| 3.3 | Till watch only covers 7 days and lives on the dashboard | A Reports → "Cashiers" tab: sales, credit given, returns, discounts and till short/over per cashier, any date range |
| 3.4 | Closing the till takes one total, with no **printable Z report** and no note-by-note count | Count by ₦1000/₦500/₦200… notes, and print or WhatsApp the Z report to the owner |
| 3.5 | Owner isn't told when a till closes short | Alert on the dashboard (and WhatsApp/email once that exists) when a till closes short past your limit |

---

## 4. Missing features owners will ask for

Ordered by how often Nigerian SME owners ask for them.

| # | Feature | Today | Why it matters |
|---|---|---|---|
| 4.1 | **Customer statement** (PDF/WhatsApp: every invoice, payment and running balance) | Missing. The customer account screen shows unpaid invoices only | First thing a customer asks when disputing a debt |
| 4.2 | **Supplier statement** | Missing | Same, for agreeing balances with suppliers |
| 4.3 | **End-of-day report to the owner** (WhatsApp or email: sales, cash, transfers, credit given, expenses, low stock) | Missing | Owners who aren't in the shop want this every evening. Strong reason to pay |
| 4.4 | **Product categories** (Drinks, Provisions, Toiletries…) | Missing. Only a tax category | Needed for filtering at the till, reports by category, and shops with 300+ items |
| 4.5 | **Stock take** (count everything, see differences, approve in one go) | Only one-item-at-a-time "Adjust stock" | Monthly stock counts are standard; doing it item by item is painful |
| 4.6 | **Prices include VAT** option | VAT always added on top | Most retail shelf prices in Nigeria already include VAT |
| 4.7 | **VAT report** (VAT collected and paid, by month) | Missing | Needed for the monthly VAT return |
| 4.8 | **Product photos** | Missing | Makes the till faster to use, and needed for any future online store |
| 4.9 | **Variants** (size/colour) | Missing | Fashion, shoes, phone accessories |
| 4.10 | **Full backup / export everything** | Per-table exports only | Owners want to know they can take their data away; the privacy page promises it |
| 4.11 | **Onboarding checklist** for new owners (add products, bank account, invite staff, first sale) | Missing | Trials convert better when the first steps are guided |
| 4.12 | **Paystack payments list** ("Incoming payments", "Paid by Paystack" badge) | Missing | You can't see which money came in automatically |
| 4.13 | **Update selling price when buying at a new cost** | Purchase warns "costs more than its selling price" but stops there | One tap to update the price saves margin |
| 4.14 | **Loyalty points / gift vouchers** | Missing | Supermarkets and pharmacies ask for it; lower priority |
| 4.15 | **SMS** (receipts, reminders) for customers without WhatsApp | WhatsApp only | Smaller share of customers, but some do ask |
| 4.16 | **Two-step login** (code on sign-in) for owners | Missing | Protects the owner account; mostly a selling point |

---

## 5. Things that work but should be better

| # | Area | Improvement |
|---|---|---|
| 5.1 | Reports | Loads every sale and expense into the browser and adds them up there. Fine now, but slow for a business with tens of thousands of sales. Move totals to the server |
| 5.2 | Reports | Stock value is shown at selling price only. Show value at cost too (the data exists since migration 0048) |
| 5.3 | Sales Orders | The New Sale form repeats labels on every line and has no phone layout (no mobile styles in `Sales.scss`). Use the Quotes line layout |
| 5.4 | Sales Orders vs Till | Two ways to sell that look and behave differently. Relabel New Sale as "Invoice a customer (credit/delivery)" |
| 5.5 | Settings | 10 tabs. Group into Business, People, Money, Setup |
| 5.6 | Settings | ~160 hard-coded inline styles; ~520 across the app. Move them into stylesheets so every page looks consistent |
| 5.7 | Copy | Long dashes (—) all over the on-screen text, and some technical wording (e.g. Deliveries subtitle). Plain sentences |
| 5.8 | Forms | Many labels aren't linked to their fields (Settings 36, Sales 21): worse for screen readers and for tapping a label on a phone |
| 5.9 | Passwords | Minimum 6 characters. Raise to 8 (also set in Supabase → Auth) |
| 5.10 | Discount approvals | Only admins can approve discounts. Some owners will want a trusted sales lead to approve too (returns already allow that) |
| 5.11 | Single-shop accounts | Can't add a second till (the Branches tab is multi-branch only) |
| 5.12 | Stock Movement, Raw Materials | No date filter |
| 5.13 | Audit log | Price changes show an ID, not the product name |
| 5.14 | Match Bank Payment | Rename to "Confirm a transfer"; link it with Paystack payments (4.12) |
| 5.15 | Assistant | Runs on Groq's free tier, shared by all businesses. Fine for now; budget for a paid tier once used |
| 5.16 | Support | Support emails depend on `ticket-notify` + Resend; confirm they arrive (1.6) |

---

## 6. What's already strong (keep it)

- **Costing:** real FIFO, so profit per sale is the true profit, not a guess. Batches, expiry dates, NAFDAC numbers and recall tracing.
- **Branches:** each branch has its own stock, and transfers keep the original cost.
- **Offline till:** sales and debt payments queue on the device and sync later. Returns rightly need a connection.
- **Permissions:** enforced in the database, not just hidden on screen. Suspended or lapsed accounts become read-only.
- **Paystack:** pay links, with signed webhooks (checked: the signature is verified). Each business's secret key is stored in Supabase Vault and never readable.
- **Documents:** invoices, credit notes, quotes, waybills; invoice numbers are unique and issued by the server.
- **Installable:** works as a phone app (installable web app with offline cache).
- **Tests:** 530 database checks and 145 app tests.

---

## 7. Suggested order of work

1. **Deploy** what's waiting (section 1). Invites don't work until then.
2. **Fix the numbers and fraud gaps** (2.1 to 2.8). Small, contained changes, mostly in the database. Roughly a day with tests.
3. **Cashier follow-ups** 3.1 (add customer at the till) and 3.4 (Z report), so the new role is complete.
4. **Customer and supplier statements** (4.1, 4.2), and the **end-of-day report** (4.3).
5. **Product categories and stock take** (4.4, 4.5).
6. **VAT-inclusive prices and a VAT report** (4.6, 4.7).
7. Polish (section 5) page by page.

---

## How this was checked

- Read the logic of the till, Sales Orders, Quotes, Customers, Suppliers, Purchases, products, raw materials, Reports, dashboards, Settings, Profile and the approval and return flows. Checked the database functions behind sales, returns, shifts, approvals and dashboards, and the backend functions.
- Scanned every page for leftover debug code, unfinished work notes, browser pop-ups and raw error messages: none found.
- Searched the code and database for each feature in section 4 to confirm it's really missing, not just hidden.
- Section 2 findings are confirmed in the code (file and function named). They're not yet covered by a failing test; writing those tests is part of fixing them.
