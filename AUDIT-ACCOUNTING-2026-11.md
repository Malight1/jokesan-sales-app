# ProfixBook accounting audit (23 Nov 2026)

Written in plain words. Each item says what is wrong or missing, what it means for a shop owner, and how big the problem is.

Checked: every report on the Reports page, the dashboard figures, sales, payments, returns, expenses, purchases, supplier payments, the till (pay in, pay out, Z report), stock adjustments and write-offs, production costing, store credit, VAT, imports, and the database rules behind them (migrations 0001 to 0059).

## The short version

ProfixBook already does the **trading** side well. It covers selling, buying, stock at true cost (first in, first out), profit per sale, VAT kept out of profit, returns taken off on the day they happen, debtors and creditors, and till close with counted cash.

What it doesn't do yet is **bookkeeping**. It doesn't track where the money sits (cash drawer, bank, Moniepoint), it can't show money coming in and going out over a month (cash flow), and it has no Balance Sheet. Some figures also leave money out, so **profit can look higher than it really is**.

Accounting words used below:
- **Profit** is what you earned (sales minus what the goods cost minus running costs). **Cash flow** is money that actually came in or went out. A shop can make profit and still run out of cash, for example when customers owe it a lot.
- **Debtors** are customers who owe you. **Creditors** are suppliers you owe.
- **Balance Sheet** is a snapshot of what the business owns and owes on one day.
- **Reconciliation** means ticking your records against the bank statement so the two agree.

---

## Status (23 Nov 2026)

Part 1 is built (migration `0060_accounting_fixes.sql`, payments-webhook update, screens) but not yet deployed. Run order: migration 0060, redeploy `payments-webhook`, then push.

| Item | What was done |
|---|---|
| 1.1 Stock losses | `report_extras()` totals stock taken off without a sale, at FIFO cost. Shown on the P&L, the Reports Net Profit and the dashboard's "Profit after costs". Stock added (opening stock, found stock) is not counted as a gain. |
| 1.2 Till pay outs | The Pay out screen asks "What was it for?": an expense type creates the expense automatically; "Cash taken to the bank or safe" is a drop; "Something else" stays a plain pay out. Till short/over from closed tills is on the P&L and dashboard. |
| 1.3 Debtors as of a date | Debtors, Creditors and the "Owed to you" card use every unpaid invoice dated up to the To date, ignoring From. |
| 1.4 Stock at cost | Stock tab shows value at cost (main figure) and at selling price; raw materials at cost noted. |
| 1.5 Expense controls | Expenses can't be deleted (void instead, crossed out on the list); every add, edit and void is in the activity log; voided expenses are left out of the dashboard and reports. Backdating is covered by 1.6. |
| 1.6 Books closed | Settings → Business → "Books closed up to". Blocks adding, changing or voiding sales, purchases, payments, returns, expenses and production dated on or before it. Paying an old invoice today still works. Changes are logged. |
| 1.7 Production costs | Note on the production form not to log the same costs again on Expenses. |
| 1.8 Store credit owed | Shown on the Debtors tab. |
| 1.9 Provider charges | The webhook records Paystack `fees` and Monnify (amount paid minus `settlementAmount`) as a "Payment charges" expense, once per payment. OPay reads `fee.total` if present; not confirmed against a live OPay account. |
| 1.10 VAT | Expenses have "VAT included"; purchases have "Add supplier's VAT" (added on top, stock cost stays ex-VAT); new VAT tab by month; P&L counts expenses without claimable VAT. |
| **Extra bug found** | A customer or supplier payment made after a return recomputed the balance as total minus paid, which undid the return (customer shown owing more, supplier owed more). Payments now reduce the balance; 0060 repairs any balances already affected and logs each repair as `balance_corrected` in the activity log. |

Part 2.1 to 2.3 built 24 Nov (migration `0061_money_accounts.sql`, Bank & Cash page, Cash flow report tab), not yet deployed. Run 0061, then push.

| Item | What was done |
|---|---|
| 2.1 Money accounts | Every business gets a cash drawer per branch, a main bank account (from the bank details in Settings) and a wallet per connected provider. More can be added (safe, second bank, POS wallet). Each has a starting balance on a chosen day; movements before that day are history the starting balance already covers. Customer payments, refunds, supplier payments, expenses, till pay in/out, banked cash and till short/over all land in an account automatically (cash to the branch drawer, confirmed transfers to the provider's wallet, everything else to the main account, or wherever the owner points each payment method). Store credit moves no money. Voided sales and purchases drop out. |
| 2.2 Transfers and owner money | "Record money": move money between accounts, owner put money in, owner took money out, loan received, loan repayment, other money in. Void instead of delete, activity log, closed-books date applies. |
| 2.3 Cash flow report | Reports, Cash flow tab: money in and out by kind for the dates chosen, the net change, and each account's start, in, out and end. Money moved between your own accounts is shown but left out of the totals. Dashboard shows "Cash and bank" now. |

Part 2.5 to 2.9 built and live 24 Nov (migration `0062_debts_statements_repeats.sql`, commit a614777).

| Item | What was done |
|---|---|
| 2.5 Due dates and aging | Payment terms in days on customers, suppliers and the business (Settings). Every invoice and bill gets a due date; the owner, accounts or sales can move one. Invoices print "Due by". Sales show "Overdue". Debtors and Creditors split what is owed into not due, 1-30, 31-60, 61-90 and over 90 days late, on screen and in exports. |
| 2.6 Customer statements | Statement button on a customer's account: every invoice, payment, return, refund, store credit and write-off for a period with a running balance; PDF or WhatsApp. The closing figure always equals what they owe (tested for every customer). |
| 2.7 Opening debts | "Owed before ProfixBook" on a customer or supplier (owner only): an OB-numbered document that owes money but adds nothing to sales, profit or purchases. It can be collected or paid like any invoice and shows on statements and aging. Starting cash and bank balances were done in 2.1. |
| 2.8 Bad debts | Owner can write off all or part of an unpaid invoice. No money moves; the amount shows as "Bad debts written off" on the P&L; undo from the sale. |
| 2.9 Repeat expenses | "Repeat every month / week" when logging an expense. Each date is logged automatically when the owner or accounts opens the dashboard or Expenses (no scheduler needed); month ends handled; closed-books dates skipped; pause and resume. |

Part 2.4 and 2.10 built and live 24 Nov (migration `0063_reconcile_balance_sheet.sql`, commits 1097705 and 4cdad20).

| Item | What was done |
|---|---|
| 2.4 Bank reconciliation | Bank & Cash, "Check statement": upload a bank or Moniepoint statement (CSV or Excel). ProfixBook finds the table, guesses the date, description, money in/out (or amount) and balance columns, and shows a preview before uploading. Each line is matched automatically to a movement in that account with the same amount within 3 days. What's left: Match by hand, Add it to ProfixBook (bank charge as an expense, owner money, loan, other income, VAT paid), or Skip. A second list shows what ProfixBook recorded that the bank doesn't show. The statement's closing balance sits beside ProfixBook's, with the difference. Finish when every line is done; only the owner can reopen. Re-uploading overlapping files skips lines already uploaded. |
| 2.10 Balance sheet | Reports, Balance sheet tab (and Excel/PDF): owns (each account, stock at cost, customers owe, VAT to claim back), owes (suppliers, VAT owed, store credit, loans), and the owner's share split into owner money in less taken out, and profit kept plus starting balances. A snapshot of right now. Accounts checked against a statement show the date they were checked to. |
| VAT paid | New "VAT paid to the tax office" money entry. It lowers VAT owed on the balance sheet and is not an expense. |

Plans, Reports and the accountant pack, built 24 Nov (migration `0064_accounting_plan_locks.sql`), not yet deployed. Run 0064, then push.

| Item | What was done |
|---|---|
| Plan split | Free keeps Profit & Loss, Sales, Expenses, Stock, VAT, Product profit and every accuracy fix. Growth adds debtors/creditors by how late, due dates, customer statements, write-offs, debts from before ProfixBook and repeat expenses. Business adds Bank & Cash, cash flow, balance sheet, statement checking, closed books and the accountant pack. Enforced in the database too. Nothing is deleted on a lower plan; the money ledger keeps filling in, so upgrading shows the full history. Trials get everything. Plan lists and the pricing comparison updated. |
| Reports | One sidebar link to a Reports home: cards grouped as Profit and money, Sales and customers, Buying stock and costs, For your accountant, each with the question it answers and a plan label when locked. Each report is its own page (/reports/:kind) with a back link, only the filters that apply, and its own Excel/PDF buttons. The summary boxes moved off Reports (the dashboard has them). |
| Accountant pack | Reports, Accountant pack: pick a period (this or last month, quarter or year, or dates). One Excel workbook with a sheet each for a cover page (business details, what is inside, how figures are worked out), Profit & Loss, Balance sheet, Cash flow, VAT, Sales, Purchases, Expenses, Debtors, Creditors, Stock value and every money movement. The same as one PDF. |

---

## Part 1: Numbers that are wrong or incomplete today (fix first)

### 1.1 Stock losses never reduce profit (High)
Write-offs (expired batches), damaged stock, and count corrections that lower stock all reduce the quantity. The cost of the lost goods never shows on the Profit & Loss. The P&L is only sales, minus the cost of goods sold, minus expenses.
**What it means:** if ₦300,000 of milk expires, profit stays ₦300,000 too high.
**Fix:** add a "Stock losses" line to the P&L and the dashboard, taken from `stock_adjustments.total_cost` where the quantity went down. Stock found during a count goes the other way, as a gain.

### 1.2 Money paid out of the till is not an expense (High)
"Pay out" at the till (fuel, a delivery boy, buying water) only moves cash out of the drawer. It never appears in Expenses or on the P&L. Till shortages and overages from the Z report don't appear anywhere in the books either.
**What it means:** spending from the drawer is invisible in profit, and the money has gone.
**Fix:** a pay out asks for an expense type and creates the expense. The Z report difference (short or over) is posted as "Till shortage" or "Till overage".

### 1.3 Debtors and Creditors reports drop old debts when a date range is set (High)
Both reports, and the "Outstanding Debt" card, only look at invoices dated inside the From/To range. Set "this month" and a customer who has owed ₦500,000 since August disappears.
**Fix:** treat what people owe as "as of" a date: every unpaid invoice up to the To date, whatever the From date.

### 1.4 Two different "stock value" figures (Medium)
The Reports Stock tab values stock at **selling price**. The dashboard values it at **cost** (migration 0048). An accountant always values stock at cost.
**Fix:** show cost value as the main figure on the Stock tab, with selling value next to it labelled "if sold at today's prices".

### 1.5 Expenses can be changed or deleted without trace, on any date (High, fraud risk)
- Expenses are hard-deleted ("This cannot be undone").
- Editing an expense isn't written to the activity log.
- An expense can be dated any day, including last year.

Sales are protected (void instead of delete, a backdate guard, an audit line). Expenses have none of that.
**Fix:** void instead of delete, log every edit, and apply the same date guard used for sales.

### 1.6 Closed months can still be changed (High)
Nothing stops anyone with admin or accounts access from changing a sale, purchase or expense dated in a month that is already finished and reported. Once VAT is filed or accounts are handed to an accountant, those months must stay fixed.
**Fix:** add a "books closed up to" date in Settings, the same idea as QuickBooks' closing date. Nothing on or before that date can be added, edited or voided without the owner's PIN, and every override is logged.

### 1.7 Production costs can be counted twice (Medium)
"Additional expenses" on a production run (gas, labour) go into the product's cost, so they reach profit through cost of goods sold. If the owner also enters the same gas bill on the Expenses page, it is counted twice.
**Fix:** a clear note on both screens, plus an option to pick an existing expense and use it for the production run.

### 1.8 Store credit you owe customers isn't shown anywhere (Medium)
When a return becomes store credit, the business owes that customer. The balance sits in `customer_credit_ledger`, but no report shows the total.
**Fix:** add a "Store credit owed" total to the Debtors report (as money you owe) and to the Balance Sheet once it exists.

### 1.9 Payment provider fees are not recorded (Medium, needs checking with a live account)
When Moniepoint, OPay or Paystack confirm a payment, ProfixBook records the full amount. The provider then pays the shop the amount minus its fee. So the bank statement will show less than ProfixBook says came in, and the fees never reach expenses.
**Fix:** read the fee or settlement amount from the webhook and post the difference as a "Payment charges" expense.

### 1.10 VAT only counts the sales side (Medium, matters for VAT-registered shops)
VAT is worked out on sales (output VAT). Purchases and expenses have no VAT field, so the VAT paid to suppliers (input VAT) can't be claimed back, and that VAT ends up inside stock cost instead. There is also no monthly VAT summary for filing with FIRS.
**Fix:** add an optional VAT amount on purchases and expenses, plus a VAT report by month (VAT collected minus VAT paid = VAT to pay).

---

## Part 2: Cash flow (what you asked about)

Today the app can tell you **profit**, but not **where your money is** or **how much came in and went out**. These are the missing pieces, in the order I'd build them.

### 2.1 Money accounts (the foundation)
Payment types (Cash, Transfer, POS) are labels only. Add **money accounts**: Cash drawer per branch, each bank account, each Moniepoint/OPay/Paystack wallet, and the owner's petty cash.
Every customer payment, supplier payment, expense, refund and till pay in/out then goes into or out of a named account, and each account has a running balance.
**What it means:** you open the app and see "Cash ₦84,000 · GTBank ₦1.2m · Moniepoint ₦310,000".

### 2.2 Transfers and owner money
Record money moving between accounts (banking the day's cash, moving from Moniepoint to the bank) without it looking like a sale or an expense. Also record:
- the owner putting money in (capital)
- the owner taking money out for personal use (drawings)
- loans received and repaid

All of these move cash but are not profit or expense, so today there is nowhere honest to put them.

### 2.3 Cash flow report
For any period, show money in (customer payments by the date paid, not the invoice date) against money out (supplier payments, expenses, refunds, pay outs, drawings, loan repayments), with opening and closing balance per account. This is the report that answers "I made ₦2m profit, so where is the money?" The usual answer is stock and customers who owe you.

### 2.4 Bank reconciliation
Upload a bank or Moniepoint statement (CSV), match each line against recorded payments, and flag anything missing on either side. That catches lost payments, unrecorded charges and fraud.

### 2.5 How late debts are (aging)
Split what customers owe into "not due, 1–30 days, 31–60, 61–90, over 90 days late". This needs a **due date / payment terms** on invoices (for example "pay within 14 days"), which don't exist today. Do the same for suppliers, so the owner knows what must be paid this week.

### 2.6 Customer statements
The customer account screen lists unpaid invoices. Add a printable / WhatsApp **statement**: every invoice and payment over a period with a running balance. That is the document wholesale customers ask for.

### 2.7 Opening balances
Import only brings in opening **stock**. A shop moving from a notebook or Excel also needs:
- what each customer already owes
- what it already owes each supplier
- its starting cash and bank balances

Without these, the debtors and cash figures are wrong from day one.

### 2.8 Bad debts
There is no way to write off a debt that will never be paid. The owner would have to void the sale, which wrongly removes the sale and its stock movement. Add "write off balance", posted as a bad debt expense.

### 2.9 Recurring expenses
Rent, salaries, diesel and subscriptions are entered by hand every time. Add repeat expenses (monthly or weekly) that are created automatically, with a reminder.

### 2.10 Balance Sheet
Once 2.1 and 2.2 exist, ProfixBook can produce a simple Balance Sheet:
- **owns:** cash and bank, stock at cost, customers owe
- **owes:** suppliers, VAT, store credit, loans
- **the difference:** owner's equity

Banks and investors ask for this when a shop applies for a loan.

---

## Part 3: QuickBooks has it, ProfixBook doesn't

| QuickBooks feature | ProfixBook today | Needed for a Nigerian SME shop? |
|---|---|---|
| Chart of accounts and double-entry books (every money movement posts to two accounts) | No. Separate tables, no ledger | Yes, eventually: it is what makes the Balance Sheet and the accountant export possible. Can stay hidden from the owner |
| Bank accounts with running balances | No (payment types only) | **Yes, first** (2.1) |
| Bank feeds and bank reconciliation | No | Yes: CSV statement upload first (2.4); live bank feeds later (Mono/Okra) |
| Transfers between accounts | No | **Yes** (2.2) |
| Statement of cash flows | No | **Yes** (2.3) |
| Balance Sheet | No | Yes (2.10) |
| Profit & Loss | Yes | Already there, needs 1.1, 1.2, 1.9 |
| P&L by location or class | Yes, branch filter | Already there |
| Accounts receivable aging | No | **Yes** (2.5) |
| Accounts payable aging and bill due dates | No | Yes (2.5) |
| Invoice due dates and payment terms | No | **Yes** |
| Customer statements | Partial (account screen) | Yes (2.6) |
| Estimates and quotes, converted to invoices | Yes (Quotes, Proforma) | Already there |
| Credit notes and refunds | Yes | Already there |
| Bills and supplier payments | Yes (purchases + payments) | Already there |
| Supplier credits | Yes (purchase returns) | Already there |
| Recurring transactions | No | Yes (2.9) |
| Recurring / subscription invoices | No | Nice to have (B2B clients) |
| Online invoice payment | Yes (Paystack/Moniepoint/OPay links) | Already there, better than QuickBooks for Nigeria |
| Sales tax / VAT return | Sales side only | Yes for VAT-registered shops (1.10) |
| Closing date (lock past months) | No | **Yes** (1.6) |
| Audit log | Yes, but expenses missing | Fix 1.5 |
| Journal entries (manual corrections by an accountant) | No | Yes, for the accountant role only |
| Opening balances | Stock only | **Yes** (2.7) |
| Bad debt write-off | No | Yes (2.8) |
| Fixed assets and depreciation (generator, freezer, van) | No | Later |
| Loans and owner capital / drawings | No | Yes (2.2) |
| Budgets (planned against actual spend) | No | Later |
| Payroll (salaries, PAYE, pension) | No (salaries are just an expense) | Later: Nigerian payroll is its own product; a salary expense plus a staff list is enough for now |
| Receipt capture (photo of a receipt attached to an expense) | No | Yes, cheap and owners love it |
| Multi-currency (buy in USD, sell in NGN) | No (NGN only) | Later, for importers |
| Projects / job costing | No | Not for shops |
| Mileage and time tracking | No | No |
| Accountant access and exports (trial balance, general ledger, QuickBooks/Sage export) | Excel/PDF of each report only | Yes: an "accountant pack" export per month |
| 65+ standard reports | 9 report tabs | Add cash flow, aging, VAT, statements, balance sheet |

**ProfixBook has these that QuickBooks doesn't:** a real till with shifts and Z reports, cashier controls with manager PINs, production / recipes with true cost per batch, batch and expiry tracking, branch stock transfers, Nigerian bank transfer confirmation at the till, WhatsApp receipts and reminders, and naira-first pricing. Those are the reasons a Nigerian shop picks ProfixBook. The gaps above are the reasons an accountant would still ask for QuickBooks alongside it.

---

## Suggested order

1. **Fix the numbers (Part 1):**
   - stock losses and till pay outs in profit
   - "as of" debtors
   - stock at cost
   - expense controls
   - books-closed date
   - store credit owed

   About one round of work.
2. **Money accounts, transfers, owner money and the cash flow report (2.1–2.3).** This is the big one, and what "manage cash flow" really needs.
3. **Due dates, aging, customer statements, opening balances, bad debts, recurring expenses (2.5–2.9).**
4. **VAT on purchases with a VAT report, provider fees, bank statement reconciliation (1.9, 1.10, 2.4).**
5. **Balance Sheet, accountant export, journal entries (2.10, Part 3).** Underneath, this is where a proper double-entry ledger gets added, built from everything above.
