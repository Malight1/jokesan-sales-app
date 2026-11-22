import { zReportSections, ZReportData } from '../receipt';

const base: ZReportData = {
  opened_at: '2026-11-22T08:00:00Z', closed_at: '2026-11-22T18:00:00Z', opening_float: 5000,
  sales_count: 3, sales_total: 20000, discount_total: 0, refunds_total: 0,
  expected: { cash: 9000, opening_float: 5000, cash_sales: 4000, transfer: 16000 },
  counted_cash: 9000, variance: 0,
};

describe('Z report: confirmed transfers by provider', () => {
  it('lists each provider with how many and how much', () => {
    const secs = zReportSections({ ...base, confirmed: [
      { provider: 'monnify', total: 12000, count: 2 }, { provider: 'opay', total: 4000, count: 1 },
    ] });
    const sec = secs.find(s => s.title === 'Confirmed transfers');
    expect(sec).toBeTruthy();
    expect(sec!.rows.map(r => r[0])).toEqual(['Moniepoint (2)', 'OPay (1)']);
    expect(sec!.rows[0][1]).toContain('12,000');
  });

  it('leaves the section out when nothing was confirmed', () => {
    expect(zReportSections(base).some(s => s.title === 'Confirmed transfers')).toBe(false);
  });
});
