import type { Feature } from '../lib/features';

// Every report, what it answers, and which plan it's on (0064). The
// Reports home groups these; each one opens on its own page.
export type ReportId =
  | 'pnl' | 'cashflow' | 'balance' | 'vat'
  | 'sales' | 'products' | 'discounts' | 'returns' | 'debtors'
  | 'stock' | 'expenses' | 'creditors'
  | 'accountant';

// dates: a From/To range. asof: one "as of" date. none: right now.
export type ReportFilter = 'dates' | 'asof' | 'none';

export interface ReportDef {
  id: ReportId;
  title: string;
  question: string;
  group: 'money' | 'sales' | 'stock' | 'accountant';
  feature?: Feature;
  filter: ReportFilter;
  branch: boolean;
  vatOnly?: boolean;
  tiersOnly?: boolean;
}

export const REPORTS: ReportDef[] = [
  { id: 'pnl', title: 'Profit & Loss', question: 'Did I make money, after every cost?', group: 'money', filter: 'dates', branch: true },
  { id: 'cashflow', title: 'Cash flow', question: 'Where did the money come from, and where did it go?', group: 'money', feature: 'accounting', filter: 'dates', branch: false },
  { id: 'balance', title: 'Balance sheet', question: 'What does the business own and owe right now?', group: 'money', feature: 'accounting', filter: 'none', branch: false },
  { id: 'vat', title: 'VAT', question: 'How much VAT do I owe the tax office?', group: 'money', filter: 'dates', branch: true, vatOnly: true },

  { id: 'sales', title: 'Sales', question: 'What did I sell, and is it going up?', group: 'sales', filter: 'dates', branch: true },
  { id: 'products', title: 'Product profit', question: 'Which products make me the most money?', group: 'sales', filter: 'dates', branch: true },
  { id: 'debtors', title: 'Debtors', question: 'Who owes me, and how late are they?', group: 'sales', feature: 'debt_tools', filter: 'asof', branch: true },
  { id: 'returns', title: 'Returns', question: 'What came back, and what was lost?', group: 'sales', filter: 'dates', branch: true },
  { id: 'discounts', title: 'Discounts', question: 'How much did discounts cost me?', group: 'sales', filter: 'dates', branch: true, tiersOnly: true },

  { id: 'stock', title: 'Stock', question: 'What is my stock worth?', group: 'stock', filter: 'none', branch: true },
  { id: 'expenses', title: 'Expenses', question: 'What am I spending on?', group: 'stock', filter: 'dates', branch: true },
  { id: 'creditors', title: 'Creditors', question: 'Who do I owe, and what is due first?', group: 'stock', feature: 'debt_tools', filter: 'asof', branch: true },

  { id: 'accountant', title: 'Accountant pack', question: 'Everything your accountant needs for a month, quarter or year, in one file.', group: 'accountant', feature: 'accounting', filter: 'none', branch: false },
];

export const GROUPS: { id: ReportDef['group']; title: string }[] = [
  { id: 'money', title: 'Profit and money' },
  { id: 'sales', title: 'Sales and customers' },
  { id: 'stock', title: 'Buying, stock and costs' },
  { id: 'accountant', title: 'For your accountant' },
];

export const reportById = (id: string | undefined) => REPORTS.find(r => r.id === id);
