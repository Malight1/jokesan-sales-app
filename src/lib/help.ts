// In-app help: what each page is for, how to use it, and the short tips
// shown the first time someone opens a busy page. One place for all the
// words, so they're easy to keep in step with the app and the user guide.
//
// A tip points at an element marked data-tour="<target>". If that element
// isn't on screen (wrong role, plan, empty page), the tip is skipped.

export interface HelpTip { target: string; title: string; body: string }
export interface PageHelp {
  title: string;
  intro: string;
  steps?: string[];
  notes?: string[];
  tips?: HelpTip[];
}

const HELP: Record<string, PageHelp> = {
  '/dashboard': {
    title: 'Dashboard',
    intro: 'Your business at a glance: what came in today, your profit, what is running out and who owes you.',
    steps: [
      'Check today’s takings and how this month compares with last month.',
      'Tap Remind next to a customer who owes you to send a polite WhatsApp reminder.',
      'Tap Buy next to anything running out to restock it.',
    ],
    notes: [
      'Profit here is after the cost of the goods sold, worked out from what each item really cost you.',
      'New here? Follow the Get set up card at the top. It disappears once you are done.',
    ],
  },
  '/pos': {
    title: 'Point of Sale',
    intro: 'The till. Ring up sales, take payment and give receipts. It keeps working when the network drops.',
    steps: [
      'Open the till: count the cash in the drawer, enter it as the opening float and choose Open till.',
      'Tap products, search, or scan a barcode to add them to the sale.',
      'Pick the customer if they are buying on credit. Otherwise leave it as Walk-in customer.',
      'Choose how they are paying and enter the amount, then choose Charge.',
      'Print the receipt or send it on WhatsApp.',
    ],
    notes: [
      'Hold puts a sale aside so you can serve the next person. Find it again under Held sales.',
      'Returns lets you take items back and refund or give store credit.',
      'At the end of the shift choose Close till and count the cash. Any amount short or over is recorded.',
    ],
    tips: [
      { target: 'pos-search', title: 'Find a product', body: 'Type a name or scan a barcode here. You can also tap the product tiles below.' },
      { target: 'pos-tile', title: 'Tap to add', body: 'Tap a product to add it to the sale. Tap again for more. The small number shows how many are in the sale.' },
      { target: 'pos-cart', title: 'The current sale', body: 'Everything being bought is listed here. Change quantities or prices, or add a discount, before you charge.' },
      { target: 'pos-pay', title: 'Take payment', body: 'Pick the payment method, then press Charge. Cash shows the change to give.' },
    ],
  },
  '/sales': {
    title: 'Sales Orders',
    intro: 'Every sale and invoice, including those made at the till.',
    steps: [
      'Choose New Sale to make an invoice away from the till, for example for a wholesale customer.',
      'Open an invoice to download it, send it on WhatsApp, record a payment or return items.',
      'Invoices past their due date show as Overdue.',
    ],
    notes: ['A sale can be voided, not deleted, so there is always a record of it.'],
    tips: [
      { target: 'sales-new', title: 'Make an invoice', body: 'Use New Sale for invoices that aren’t rung up at the till.' },
    ],
  },
  '/quotes': {
    title: 'Quotes',
    intro: 'Price quotes and proforma invoices. Stock and money only move when a quote becomes a sale.',
    steps: [
      'Choose New Quote, pick the customer and add products.',
      'Send it as a PDF or on WhatsApp.',
      'When the customer agrees, turn it into a sale from the quote.',
    ],
  },
  '/deliveries': {
    title: 'Deliveries',
    intro: 'Waybills and delivery notes for goods leaving the shop, and whether they arrived.',
    steps: ['Make a delivery note for a sale.', 'Mark it delivered when the customer receives it.'],
  },
  '/money-received': {
    title: 'Money Received',
    intro: 'Every payment Moniepoint, Paystack or OPay confirmed for you, from pay links and the till.',
    notes: ['These payments are confirmed by the provider, so they can’t be faked with a screenshot.'],
  },
  '/match-payment': {
    title: 'Match Bank Payment',
    intro: 'Paste a bank alert or drop a screenshot of a transfer, and ProfixBook finds the invoice it pays.',
    steps: ['Paste the alert text or add the screenshot.', 'Check the invoice it found, then record the payment.'],
  },
  '/customers': {
    title: 'Customers',
    intro: 'Everyone you sell to, what they have bought and what they still owe you.',
    steps: [
      'Choose Add Customer to add someone, or bring many in from Import Data.',
      'Tap a customer to open their account: unpaid invoices, payments and store credit.',
      'From their account, send a payment request, record a payment or download a statement.',
    ],
    notes: ['Statements, write-offs and debts from before ProfixBook are on the Growth plan.'],
    tips: [
      { target: 'cust-add', title: 'Add a customer', body: 'Name and phone are enough. The phone is used for WhatsApp receipts and reminders.' },
      { target: 'cust-list', title: 'Open an account', body: 'Tap a customer to see what they owe and to collect payment.' },
    ],
  },
  '/suppliers': {
    title: 'Suppliers',
    intro: 'Everyone you buy from and what you still owe them.',
    steps: ['Choose Add Supplier.', 'Open a supplier to see unpaid bills and record payments to them.'],
  },
  '/finished-goods': {
    title: 'Products',
    intro: 'Everything you sell, with its price, what it cost you and how much is in stock.',
    steps: [
      'Choose Add Product: name, unit, cost, selling price and a barcode if it has one.',
      'Set a reorder level so you are warned before it runs out.',
      'To add many at once, use Import Data with an Excel sheet.',
    ],
    notes: ['Stock goes up when you buy or produce, and down when you sell. Use Adjust stock for damage or a recount.'],
    tips: [
      { target: 'prod-add', title: 'Add a product', body: 'Start here. Or bring all your products in at once from Import Data.' },
    ],
  },
  '/production': {
    title: 'Production',
    intro: 'Turn raw materials into finished goods. ProfixBook works out exactly what each one cost to make.',
    steps: [
      'Set up a recipe for the product in Settings, Recipes.',
      'Choose New Production Run, pick the product and how many you made.',
      'Raw materials come out of stock and the finished goods go in, at their true cost.',
    ],
  },
  '/batches': {
    title: 'Batches',
    intro: 'Every batch with its number and expiry date. Hold, recall or trace a batch.',
    notes: ['Expiry alerts, hold, recall and trace are on the Growth plan.'],
  },
  '/transfers': {
    title: 'Stock Transfers',
    intro: 'Move stock between branches. It keeps the cost it was bought at.',
    steps: ['Choose the branch it leaves and the branch it goes to, then the items and quantities.'],
  },
  '/stock-movement': {
    title: 'Stock Movement',
    intro: 'The full history of every item in and out: sales, purchases, production, transfers and adjustments.',
  },
  '/stock-alerts': {
    title: 'Stock Alerts',
    intro: 'What is running low, what is out, and what is about to expire.',
    steps: ['Buy more of anything below its reorder level.', 'Sell or move stock that is close to expiring.'],
  },
  '/purchases': {
    title: 'Purchases',
    intro: 'Stock you buy from suppliers. ProfixBook shows your margin on every item before you save.',
    steps: [
      'Choose Buy Stock (Quick Purchase if you make products) and pick the supplier.',
      'Add each item with the quantity and what you paid.',
      'Enter any supplier VAT, and the amount you paid now. The rest is what you owe them.',
    ],
    tips: [
      { target: 'purch-new', title: 'Buy stock', body: 'Every purchase adds stock at what it cost you, so your profit stays real.' },
    ],
  },
  '/inventory': {
    title: 'Raw Materials',
    intro: 'The materials you make your products from, with their stock and cost.',
    steps: ['Choose Add Material.', 'Buy materials on Purchases; production uses them up.'],
  },
  '/money': {
    title: 'Bank & Cash',
    intro: 'How much is in every cash drawer, bank account and POS wallet right now, and every naira in and out.',
    steps: [
      'Tap an account to see its movements.',
      'Choose Record money for money that isn’t a sale or an expense: moving money, owner money, loans, VAT paid.',
      'Choose Check statement on a bank account to compare your bank statement with ProfixBook.',
    ],
    notes: [
      'Sales, supplier payments and expenses appear here by themselves.',
      'Set a starting balance on each account so the totals match your real money.',
    ],
    tips: [
      { target: 'money-accounts', title: 'Your accounts', body: 'Each card is a drawer, bank or wallet with its balance now. Tap one to see what went in and out.' },
      { target: 'money-record', title: 'Record money', body: 'For banking cash, owner money, loans or VAT paid. Sales and expenses come in by themselves.' },
      { target: 'money-statements', title: 'Check a statement', body: 'Upload your bank or Moniepoint statement and ProfixBook matches it line by line.' },
    ],
  },
  '/money/statements': {
    title: 'Checking a statement',
    intro: 'Each line of your bank statement next to what ProfixBook recorded.',
    steps: [
      'Lines that matched by themselves are done.',
      'For each line marked Not found in ProfixBook: Match it to something recorded, Add it, or Skip it.',
      'Check the list of things in ProfixBook that the bank doesn’t show, and chase each one.',
      'When every line is done, choose Finish.',
    ],
  },
  '/expenses': {
    title: 'Expenses',
    intro: 'Rent, salaries, fuel and every other cost. They come off your profit.',
    steps: [
      'Choose Log Expense, pick the type and enter the amount.',
      'Enter any VAT you can claim back.',
      'For rent or salaries, set Repeat so it is logged on each date for you.',
    ],
    notes: ['Expenses are voided, never deleted, so the record stays.'],
    tips: [
      { target: 'exp-new', title: 'Log an expense', body: 'Every cost you log comes off your profit on the reports.' },
    ],
  },
  '/reports': {
    title: 'Reports',
    intro: 'Every report, grouped by what you want to find out. Each one downloads as Excel or PDF.',
    steps: [
      'Pick a report to open it.',
      'Choose the dates, and the branch if you have more than one.',
      'Download it as Excel or PDF.',
    ],
    notes: ['The Accountant pack puts everything your accountant needs for a period into one file.'],
    tips: [
      { target: 'rep-first', title: 'Start here', body: 'Profit & Loss shows whether you made money after every cost.' },
      { target: 'rep-accountant', title: 'For your accountant', body: 'One Excel file with every report and record for a month, quarter or year.' },
    ],
  },
  '/reports/*': {
    title: 'This report',
    intro: 'Choose the dates or branch at the top. Download it as Excel or PDF with the buttons on the right.',
    notes: ['Go back to All reports to pick a different one.'],
  },
  '/insights': {
    title: 'Smart Insights',
    intro: 'Patterns in your sales and stock worth acting on, worked out from your own records.',
    notes: ['The more sales you record, the more useful these become.'],
  },
  '/import': {
    title: 'Import Data',
    intro: 'Bring products, customers, suppliers and opening stock in from Excel or CSV.',
    steps: ['Pick what you are importing.', 'Download the template, fill it in and upload it.', 'Check the columns, then import.'],
  },
  '/audit': {
    title: 'Audit Log',
    intro: 'Who changed what, and when. Voids, price changes and settings are all recorded.',
  },
  '/settings': {
    title: 'Settings',
    intro: 'Your business details, staff, branches, plan, payment methods and more.',
    steps: [
      'Business: name, VAT, TIN, bank details and payment terms.',
      'Team: invite staff and choose their role.',
      'Billing: your plan and payments.',
      'Payments: connect Moniepoint, OPay or Paystack.',
    ],
  },
  '/assistant': {
    title: 'Ask ProfixBook',
    intro: 'Ask questions about your business in plain words, like “What sold most last week?”.',
    notes: ['Answers come from your own records. Included on Growth (20 a month) and Business (100 a month).'],
  },
  '/support': {
    title: 'Support',
    intro: 'Something not working, or a question? Open a ticket and we reply here.',
    steps: ['Choose New Ticket and tell us what happened.', 'We reply in the same ticket.'],
  },
  '/profile': {
    title: 'My Profile',
    intro: 'Your name, password, and whether you see tips on new pages.',
  },
};

/** Help for a route. Report pages share one entry; unknown routes get none. */
export function helpFor(pathname: string, retail: boolean): PageHelp | null {
  const exact = HELP[pathname];
  const base = exact
    ?? (pathname.startsWith('/money/statements') ? HELP['/money/statements'] : null)
    ?? (pathname.startsWith('/reports/') ? HELP['/reports/*'] : null)
    ?? (pathname.startsWith('/support/') ? HELP['/support'] : null);
  if (!base) return null;
  if (pathname === '/finished-goods' && !retail) return { ...base, title: 'Finished Goods' };
  return base;
}

/** The key tips are remembered under, so a page's tips show once per person. */
export const tourKey = (pathname: string) =>
  pathname.startsWith('/reports/') ? '/reports/*' : pathname.startsWith('/money/statements') ? '/money/statements' : pathname;
