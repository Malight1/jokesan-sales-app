import * as XLSX from 'xlsx';
import { parseDateLoose } from './batches';

// Reading a bank or wallet statement (CSV or Excel) for reconciliation
// (migration 0063). Nigerian bank exports put a few lines of account
// details above the table, use "Debit"/"Credit" (or "Withdrawal"/
// "Lodgement") columns, and write dates like 02-Nov-2026 10:15. This finds
// the table, guesses the columns and turns each row into a signed amount.

export type Grid = unknown[][];
export interface ColumnMap {
  date: number; description: number; reference: number;
  debit: number; credit: number; amount: number; balance: number;
}
export interface StatementRow { date: string; description: string; reference: string; amount: number; balance: number | null; }
export const NO_COLUMN = -1;

export async function readGrid(file: File): Promise<Grid> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '', raw: true, blankrows: false });
  return rows.map(r => (Array.isArray(r) ? r : []));
}

const norm = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z]/g, '');

const SYNONYMS: Record<keyof ColumnMap, string[]> = {
  date:        ['transdate', 'transactiondate', 'posteddate', 'postdate', 'postingdate', 'txndate', 'date', 'createdat', 'datetime', 'valuedate'],
  description: ['narration', 'description', 'details', 'remarks', 'transactiondetails', 'particulars', 'narrative', 'memo', 'beneficiary'],
  reference:   ['reference', 'ref', 'refno', 'referenceno', 'referencenumber', 'transactionref', 'transactionid', 'sessionid', 'chequeno'],
  debit:       ['debit', 'debits', 'withdrawal', 'withdrawals', 'moneyout', 'dr', 'debitamount', 'paidout', 'out'],
  credit:      ['credit', 'credits', 'lodgement', 'lodgements', 'deposit', 'deposits', 'moneyin', 'cr', 'creditamount', 'paidin', 'in'],
  amount:      ['amount', 'transactionamount', 'amountngn'],
  balance:     ['balance', 'runningbalance', 'closingbalance', 'availablebalance', 'balanceafter', 'ledgerbalance'],
};

function findColumn(headers: string[], key: keyof ColumnMap, taken: Set<number>): number {
  const syn = SYNONYMS[key];
  // Exact first, then "contains", so "Value Date" doesn't steal "Amount".
  for (const exact of [true, false]) {
    for (const s of syn) {
      const i = headers.findIndex((h, idx) => !taken.has(idx) && h && (exact ? h === s : s.length > 3 && h.includes(s)));
      if (i >= 0) return i;
    }
  }
  return NO_COLUMN;
}

// The header row is the first row (in the top 30) that names a date column
// and at least one money column.
export function findHeader(grid: Grid): number {
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const h = grid[i].map(norm);
    const hasDate = h.some(c => SYNONYMS.date.some(s => c === s || (s.length > 3 && c.includes(s))));
    const hasMoney = h.some(c => [...SYNONYMS.debit, ...SYNONYMS.credit, ...SYNONYMS.amount].some(s => c === s || (s.length > 3 && c.includes(s))));
    if (hasDate && hasMoney) return i;
  }
  return 0;
}

export function guessColumns(headerRow: unknown[]): ColumnMap {
  const h = headerRow.map(norm);
  const taken = new Set<number>();
  const pick = (k: keyof ColumnMap) => { const i = findColumn(h, k, taken); if (i >= 0) taken.add(i); return i; };
  // Order matters: specific money columns before the generic "amount".
  const date = pick('date');
  const balance = pick('balance');
  const debit = pick('debit');
  const credit = pick('credit');
  const amount = debit >= 0 || credit >= 0 ? NO_COLUMN : pick('amount');
  const reference = pick('reference');
  const description = pick('description');
  return { date, description, reference, debit, credit, amount, balance };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const pad = (n: number) => String(n).padStart(2, '0');

export function readDate(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  let s = String(v ?? '').trim();
  if (!s) return null;
  // Drop a time part: "02/11/2026 10:15:33", "2026-11-02T10:15", "02-Nov-2026 10:15 AM".
  s = s.replace(/[T\s]+\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?\s*(Z|[+-]\d{2}:?\d{2})?$/i, '').trim();
  // 02-Nov-2026, 02 Nov 2026, 2-November-26
  let m = s.match(/^(\d{1,2})[\s\-/.]+([a-z]{3,9})[\s\-/.,]+(\d{2}|\d{4})$/i);
  if (m) {
    const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase());
    if (mo >= 0) return parseDateLoose(`${m[1]}/${mo + 1}/${m[3]}`);
  }
  // Nov 02, 2026
  m = s.match(/^([a-z]{3,9})[\s\-/.]+(\d{1,2}),?[\s\-/.]+(\d{4})$/i);
  if (m) {
    const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase());
    if (mo >= 0) return parseDateLoose(`${m[2]}/${mo + 1}/${m[3]}`);
  }
  return parseDateLoose(typeof v === 'number' ? v : s);
}

// "1,500.00", "₦1,500", "(1,500.00)", "-1500", "1,500.00 DR", "1500CR"
export function readMoney(v: unknown): number | null {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v ?? '').trim();
  if (!s || s === '-') return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) { sign = -1; s = s.slice(1, -1); }
  if (/\bdr\.?$/i.test(s)) { sign = -1; s = s.replace(/\bdr\.?$/i, ''); }
  s = s.replace(/\bcr\.?$/i, '');
  s = s.replace(/[^\d.-]/g, '');
  if (!s || s === '-' || s === '.') return null;
  const n = parseFloat(s);
  return isNaN(n) ? null : sign * n;
}

const cell = (row: unknown[], i: number) => (i >= 0 ? row[i] : '');
const text = (v: unknown) => (v instanceof Date ? '' : String(v ?? '').replace(/\s+/g, ' ').trim());

export function buildRows(grid: Grid, headerIdx: number, map: ColumnMap): { rows: StatementRow[]; skipped: number } {
  const rows: StatementRow[] = [];
  let skipped = 0;
  for (const r of grid.slice(headerIdx + 1)) {
    if (!r.some(c => String(c ?? '').trim() !== '')) continue;
    const date = readDate(cell(r, map.date));
    let amount: number | null = null;
    if (map.debit >= 0 || map.credit >= 0) {
      const dr = Math.abs(readMoney(cell(r, map.debit)) ?? 0);
      const cr = Math.abs(readMoney(cell(r, map.credit)) ?? 0);
      amount = cr - dr;
    } else if (map.amount >= 0) {
      amount = readMoney(cell(r, map.amount));
    }
    // Opening/closing balance rows and totals have no date or no movement.
    if (!date || amount === null || Math.abs(amount) < 0.005) { skipped++; continue; }
    rows.push({
      date,
      description: text(cell(r, map.description)).slice(0, 300),
      reference: text(cell(r, map.reference)).slice(0, 120),
      amount: Math.round(amount * 100) / 100,
      balance: map.balance >= 0 ? readMoney(cell(r, map.balance)) : null,
    });
  }
  return { rows, skipped };
}

// The statement's closing balance: the balance on its latest row. Banks
// list newest first or oldest first, so look at the dates.
export function closingBalance(rows: StatementRow[]): number | null {
  const withBal = rows.filter(r => r.balance !== null);
  if (withBal.length === 0) return null;
  const first = withBal[0], last = withBal[withBal.length - 1];
  return (first.date > last.date ? first : last).balance;
}
