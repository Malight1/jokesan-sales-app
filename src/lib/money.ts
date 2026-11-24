import { MoneyEntryKind, MoneyKind } from './api';

// Plain words for every kind of money movement (migration 0061).
export const CATEGORY_LABEL: Record<string, string> = {
  customer_payment: 'Customer payments',
  refund: 'Refunds to customers',
  supplier_payment: 'Paid to suppliers',
  expense: 'Expenses',
  till_pay_in: 'Paid into tills',
  till_pay_out: 'Paid out of tills',
  till_difference: 'Till short or over',
  transfer: 'Moved between your accounts',
  owner_in: 'Owner put money in',
  owner_out: 'Owner took money out',
  loan_in: 'Loans received',
  loan_repay: 'Loan repayments',
  other_in: 'Other money in',
  opening: 'Starting balance',
};

export const KIND_LABEL: Record<MoneyKind, string> = { cash: 'Cash', bank: 'Bank', wallet: 'Wallet' };

export const ENTRY_KINDS: { id: MoneyEntryKind; label: string; hint: string; from: boolean; to: boolean }[] = [
  { id: 'transfer', label: 'Move money between accounts', hint: 'For example, banking the day’s cash, or moving money from Moniepoint to the bank.', from: true, to: true },
  { id: 'owner_in', label: 'Owner put money in', hint: 'Your own money going into the business. Not a sale, so not profit.', from: false, to: true },
  { id: 'owner_out', label: 'Owner took money out', hint: 'Money you took for personal use. Not a business cost, so not an expense.', from: true, to: false },
  { id: 'loan_in', label: 'Loan received', hint: 'Money borrowed from a bank, cooperative or person. You will pay it back.', from: false, to: true },
  { id: 'loan_repay', label: 'Loan repayment', hint: 'Paying back a loan. Put any interest on the Expenses page.', from: true, to: false },
  { id: 'other_in', label: 'Other money in', hint: 'Money that isn’t from a sale, such as interest from the bank.', from: false, to: true },
];

export const naira = (n: number) => {
  const v = Number(n) || 0;
  return (v < 0 ? '−' : '') + '₦' + Math.abs(v).toLocaleString('en-NG', { maximumFractionDigits: 2 });
};
