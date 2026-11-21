import { zReportText, zReportSections } from '../receipt';

const z = {
  doc_no: 'MTS-Z-000040', business_name: 'Mama Tolu Stores', branch_name: 'Ikeja', register_name: 'Till 1',
  opened_by_name: 'Ada', closed_by_name: 'Ada',
  opened_at: '2026-11-21T08:00:00Z', closed_at: '2026-11-21T18:00:00Z', opening_float: 5000,
  sales_count: 12, sales_total: 84500, discount_total: 1500, refunds_total: 0, credit_given: 6000,
  expected: { cash: 44500, opening_float: 5000, cash_sales: 42000, pay_in: 0, pay_out: 2500, drop: 0, transfer: 36500 },
  cash_movements: [{ kind: 'pay_out' as const, amount: 2500, reason: 'fuel' }],
  counted_cash: 44000, counted_breakdown: { '1000': 40, '500': 8 }, variance: -500, notes: null,
};

describe('Z report', () => {
  it('shows a short drawer as Short, with the amount', () => {
    const drawer = zReportSections(z).find(s => s.title === 'Cash drawer')!;
    expect(drawer.rows).toContainEqual(['Short', '₦500.00', true]);
  });

  it('lists transfers but not the cash workings as payment methods', () => {
    const pay = zReportSections(z).find(s => s.title === 'Payments taken')!;
    expect(pay.rows.map(r => r[0])).toEqual(['Cash', 'Transfer']);
  });

  it('includes the note count and credit given in the WhatsApp text', () => {
    const text = zReportText(z);
    expect(text).toContain('*Mama Tolu Stores: MTS-Z-000040*');
    expect(text).toContain('₦1,000 × 40: ₦40,000.00');
    expect(text).toContain('Left owing (credit): ₦6,000.00');
    expect(text).toContain('Pay-out: fuel: −₦2,500.00');
  });
});
