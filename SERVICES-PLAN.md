# ProfixBook for service businesses: plan

Status: proposal, not built. Written 26 November 2026.

## 1. The idea in one paragraph

ProfixBook today is built for businesses that sell things: shops that buy and resell, and manufacturers that make goods. Many businesses sell work instead of, or as well as, things: salons and barbers, tailors and fashion designers, phone and laptop repairers, mechanics, laundries and dry cleaners, cleaning companies, photographers and event planners, consultants and agencies, small clinics and spas. They have the same money problems as a shop: knowing real profit, chasing customers who owe, paying staff fairly, and keeping track of cash and bank. This plan lets ProfixBook serve them, in two stages, reusing almost everything that already exists.

## 2. Why it can't be done today

- Every line on a sale, quote or invoice must be a product that has stock. The sale engine (`create_sale`) takes stock out batch by batch and refuses the sale with "Insufficient stock" when there is none. A "Haircut" or "Screen repair" has no stock, so it can't be sold.
- At sign-up a business can only be a **shop** (`retail`) or a **manufacturer** (`manufacturing`). The screens are shaped around those two.
- There is no way to record which staff member did a job, so a salon can't pay commission from ProfixBook.

## 3. Who it is for

| Business | What they sell | What they need most |
|---|---|---|
| Salon, barber, spa | Services, plus hair and beauty products | Who did each job, commission, products used per service, appointments |
| Tailor, fashion designer | Made-to-order work | Deposits and balances, job status, customer measurements |
| Phone, laptop or electronics repair | Repairs, plus spare parts | Job cards, parts used per repair, "ready for collection" message |
| Mechanic, car wash | Labour, plus parts | Job cards, parts used, staff per job |
| Laundry, dry cleaner | Per-item cleaning | Job cards with item counts, ready message, packages |
| Cleaning, events, photography | Jobs and packages | Quotes, deposits, balances, staff per job |
| Consultant, agency, trainer | Time and projects | Quotes, invoices on terms, debts |
| Small clinic or pharmacy with services | Consultations, tests, plus drugs | Services next to stocked drugs with expiry |

Many of these also sell products, so a business must be able to sell **both** on one receipt.

## 4. Stage 1: services inside the current app

This is the big win for the least change. After Stage 1 a service business can sign up, set up its services, sell them at the till or on an invoice, see real profit, pay commission, and use everything else in ProfixBook unchanged.

### 4.1 What the owner will see

- **A third choice at sign-up:** "I sell services" next to "I buy and resell stock" and "I make products". A business can also switch on services later in Settings, so a shop can add repairs and a salon can sell products.
- **Services page** (beside Products): add a service with a name, a price, an optional duration ("about 45 minutes"), an optional cost, and optionally the products it uses up.
  - **Cost** is what one job costs you before materials, for example a fixed fee paid to an outside technician. Most businesses leave it at zero.
  - **Products used** (optional): "Relaxer treatment uses 1 tub of relaxer and 1 sachet of conditioner". When the service is sold, those products come out of stock at what they cost you, so profit is real.
- **The till and invoices** show services as tiles with their price and no stock count. A sale can mix services and products, for example "Haircut + 1 bottle of oil".
- **Who did it:** on each service line, pick the staff member who did the job. It defaults to the person ringing up the sale. Optional, can be switched off.
- **Commission:** set a commission per staff member, as a percentage of the service price or a fixed amount per job, with an optional different rate per service. ProfixBook works out what each person earned.
- **Quotes and invoices** take services exactly like products, so a cleaning company can quote "Deep clean, 3 bedrooms" and invoice it on 14-day terms.
- **Deposits** are already supported as part payments ("Paying part now, rest later"), and the balance shows under money owed.

### 4.2 What changes in reports

- **Profit & Loss:** service sales count as revenue. Their cost (fixed cost plus products used) counts as cost of sales, so gross profit stays correct.
- **Product profit** becomes **Product and service profit**, with a filter for each.
- **New report: Staff sales and commission.** For a period: each staff member, jobs done, value of services, commission earned, and a total. Downloads as Excel or PDF, and goes into the accountant pack.
- **Sales report** gains a "Products / Services" split.
- Stock reports, stock alerts, reorder suggestions and stock value ignore services.

### 4.3 What stays exactly as it is

Customers, debts and statements, WhatsApp receipts and reminders, pay links and confirmed transfers, staff logins and roles, branches, expenses and repeat expenses, Bank & Cash and bank statement checking, cash flow, balance sheet, VAT, closed books, the accountant pack, offline selling, and Ask ProfixBook.

### 4.4 Database changes (one new migration)

1. **`finished_goods.item_type`**: `'product'` (default, so nothing existing changes) or `'service'`. Also `service_cost numeric` (default 0) and `duration_minutes int` (optional). Services keep `qty_balance` at 0 and never get batches.
   - Reusing the products table keeps every existing link working: sale lines, quote lines, price lists, discounts, import and the till already point at `finished_goods`.
2. **`service_materials`** (new): service id, product id, quantity per job. The products a service uses up.
3. **`sale_items.performed_by uuid`** (references `profiles`) and **`sale_items.commission numeric`**, worked out when the sale is saved so later rate changes don't rewrite history.
4. **`staff_commission_rates`** (new): staff member, optional service, percentage or fixed amount.
5. **`tenants.business_type`** gains `'services'`, and **`tenants.sells_services boolean`** lets a shop or manufacturer switch services on.
6. **`create_sale`**: for a service line, skip the batch/FIFO step and the stock check, and work out its cost as `service_cost × quantity` plus the FIFO cost of each product in `service_materials` (those products ARE taken out of stock, with their own "Insufficient stock" check). Product lines are unchanged.
7. **`create_sale_return`**: a returned service is a refund or store credit only; nothing goes back into stock (its materials are not restocked either).
8. **Voiding a sale**: puts back only the products, including materials a service used.
9. **Guards**: services can't be bought on a purchase, transferred, adjusted, counted or given batches. Price lists, discounts and VAT work as for products.
10. **Plan limits**: the Free plan's 50-product limit counts products and services together, so the limit stays simple to explain.
11. **Tests**: add a section to `supabase/tests/tests.sql`: selling a service with no stock, a mixed sale, materials taken at FIFO cost, commission worked out, return of a service, void puts back materials only, a service refused on a purchase, plan limit counting both.

### 4.5 Screens that change

| Screen | Change |
|---|---|
| Sign-up | Third choice, "I sell services". |
| Settings, Business | "We also sell services" switch; commission on or off. |
| Settings, Team | Commission rate on each staff member. |
| Services (new page, or a tab on Products) | Add, edit and import services; products each one uses. |
| Point of Sale | Service tiles with no stock badge; "Done by" picker on service lines. |
| Quotes, Sales Orders, invoice and receipt PDFs | Services listed like products; "Done by" printed on the receipt if wanted. |
| Import Data | "Type" column (product or service) in the product template. |
| Dashboard | Its own dashboard for service businesses (see 4.8). |
| Reports | Product and service profit; new Staff sales and commission report; accountant pack sheet. |
| Stock pages, purchases, transfers, batches | Services hidden. |
| User guide, decks, pricing page | New section and lines for services. |

### 4.6 Plans

- **Every plan:** selling services, services on quotes and invoices, products used per service.
- **Growth and above:** "Done by" on each job, commission rates and the Staff sales and commission report (Growth already adds staff logins, so this is where commission belongs).
- **Business:** no extra service features in Stage 1; the accounting features already there apply.

### 4.7 Order of work

1. Database migration and tests (the sale engine change is the risky part; it is tested first, on its own).
2. Services page, sign-up choice and Settings switch.
3. Till, quotes, invoices and receipts.
4. "Done by", commission rates and the commission report.
5. Reports, dashboard, import template.
6. Guide, decks and pricing page.

### 4.8 A dashboard of their own

A service business gets its own dashboard, the way shops already get a different one from manufacturers. It leads with the work and the people, not with stock.

- **Today:** takings and jobs done, against the same day last week.
- **Staff:** each person's jobs today and the commission they've earned so far this week (Growth plan).
- **Top services this month** by money made, with profit after the products they used.
- **Who owes you:** unpaid balances and deposits, with a Remind button.
- **Quick buttons:** Ring up a job, New quote, Add customer.
- **Running low:** shown only if the business sells products or its services use them up.
- **Stage 2 adds** today's appointments in time order, and job cards by status (received, in progress, ready, not yet collected), with jobs late for collection flagged.

## 5. Stage 2: managing the work

Decide on Stage 2 after seeing which service businesses sign up first, because a salon and a repair shop want different things.

- **Job cards** (repairs, tailoring, laundry, mechanics): customer drops something off; a job card records what it is, the problem or order, photos, a deposit, the promised date and the staff member. Status moves from Received to In progress to Ready to Collected. The customer gets a WhatsApp message when it's ready, and the balance is charged on collection. Job cards are searchable by customer or phone number.
- **Customer measurements and notes** for tailors and salons, kept on the customer.
- **Appointments** (salons, clinics, consultants): a day view per staff member, booked from the till or by the business, with a WhatsApp reminder the day before. Later, a booking link customers can use themselves.
- **Packages and memberships:** "10 washes for ₦45,000", tracked per customer, with uses left.
- **Staff payouts:** mark commission as paid for a period, with the payout recorded as an expense or from Bank & Cash.

Suggested plans: job cards and measurements on Growth; appointments with reminders, packages and payouts on Business.

## 6. Risks and how to handle them

- **The sale engine is the heart of ProfixBook.** A mistake there affects every sale. Change it in one migration with full tests before any screen work, and keep the product path byte-for-byte the same.
- **Profit must stay true.** A service with no cost and no materials shows 100% margin. The Services page should say so plainly and suggest adding materials used, so owners aren't misled.
- **Commission disputes.** Store the commission on each sale line when the sale is made, so changing a rate later never rewrites what staff were owed.
- **Free plan abuse.** Counting services in the 50-item limit keeps the Free plan fair.

## 7. Open questions for the owner

1. Should services have their own menu item, or be a tab on the Products page?
2. Commission as a percentage of the service price, a fixed amount per job, or both?
3. Should a cashier be able to change "Done by", or only an owner or manager?
4. Which service businesses should we pitch first? That decides which Stage 2 feature comes first: job cards (repairs, tailoring, laundry) or appointments (salons, clinics).
