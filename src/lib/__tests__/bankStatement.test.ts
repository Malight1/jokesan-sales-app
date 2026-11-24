import { findHeader, guessColumns, buildRows, readDate, readMoney, closingBalance, NO_COLUMN } from '../bankStatement';

describe('reading bank statements', () => {
  it('finds the table under the account details and guesses debit/credit columns', () => {
    const grid = [
      ['Guaranty Trust Bank', '', '', '', '', ''],
      ['Account Name: KAYSAN GLOBAL', '', '', '', '', ''],
      ['', '', '', '', '', ''],
      ['Trans. Date', 'Value Date', 'Reference', 'Debits', 'Credits', 'Balance', 'Remarks'],
      ['02-Nov-2026', '02-Nov-2026', 'FT123', '', '50,000.00', '250,000.00', 'TRF FROM ADA'],
      ['03-Nov-2026 10:15', '03-Nov-2026', '', '163.25', '', '249,836.75', 'SMS ALERT CHARGES'],
      ['', '', '', '', '', '249,836.75', 'Closing balance'],
    ];
    const h = findHeader(grid);
    expect(h).toBe(3);
    const map = guessColumns(grid[h]);
    expect(map).toMatchObject({ date: 0, reference: 2, debit: 3, credit: 4, balance: 5, description: 6, amount: NO_COLUMN });
    const { rows, skipped } = buildRows(grid, h, map);
    expect(rows).toEqual([
      { date: '2026-11-02', description: 'TRF FROM ADA', reference: 'FT123', amount: 50000, balance: 250000 },
      { date: '2026-11-03', description: 'SMS ALERT CHARGES', reference: '', amount: -163.25, balance: 249836.75 },
    ]);
    expect(skipped).toBe(1);
    expect(closingBalance(rows)).toBe(249836.75);
  });

  it('reads a single signed amount column, newest first', () => {
    const grid = [
      ['Date', 'Description', 'Amount', 'Balance After'],
      ['2026-11-05 09:00:00', 'POS settlement', '12,400', '40,000'],
      ['2026-11-04', 'Transfer out', '(2,000.00)', '27,600'],
    ];
    const map = guessColumns(grid[findHeader(grid)]);
    expect(map.amount).toBe(2);
    const { rows } = buildRows(grid, 0, map);
    expect(rows.map(r => r.amount)).toEqual([12400, -2000]);
    expect(closingBalance(rows)).toBe(40000);
  });

  it('reads the date and money formats banks use', () => {
    expect(readDate('02/11/2026')).toBe('2026-11-02');
    expect(readDate('2 November 26')).toBe('2026-11-02');
    expect(readDate('Nov 02, 2026')).toBe('2026-11-02');
    expect(readDate('2026-11-02T10:15:00Z')).toBe('2026-11-02');
    expect(readDate('Opening balance')).toBeNull();
    expect(readMoney('₦1,500.50')).toBe(1500.5);
    expect(readMoney('1,500.00 DR')).toBe(-1500);
    expect(readMoney('750CR')).toBe(750);
    expect(readMoney('-')).toBeNull();
    expect(readMoney(42)).toBe(42);
  });
});
