import { parseBankAlert, rankMatches } from '../bankAlert';

describe('parseBankAlert', () => {
  it('reads a ₦ amount with thousands separators', () => {
    const r = parseBankAlert('Credit Alert ₦25,000.00 from BOLA ADESANYA');
    expect(r.amount).toBe(25000);
  });

  it('reads NGN and bare-N formats', () => {
    expect(parseBankAlert('NGN 7,500 credited').amount).toBe(7500);
    expect(parseBankAlert('Acct credited N1,250.50').amount).toBe(1250.5);
  });

  it('falls back to a bare comma-grouped figure when no currency mark', () => {
    expect(parseBankAlert('Transfer of 12,000 received').amount).toBe(12000);
  });

  it('returns null when there is no amount at all', () => {
    expect(parseBankAlert('Your OTP is ready').amount).toBeNull();
  });

  it('pulls the sender name out after "from"', () => {
    expect(parseBankAlert('₦25,000 from BOLA ADESANYA').senderName).toBe('BOLA ADESANYA');
  });

  it('trims bank noise that trails the name', () => {
    const r = parseBankAlert('₦10,000 from JOHN DOE ref 998877');
    expect(r.senderName).toBe('JOHN DOE');
  });

  it('keeps the raw text for display', () => {
    expect(parseBankAlert('  ₦100 from ADE  ').raw).toBe('₦100 from ADE');
  });
});

describe('rankMatches', () => {
  const sales = [
    { id: 'a', customerName: 'Bola Adesanya', balance: 25000, totalAmount: 25000, date: '2026-08-01' },
    { id: 'b', customerName: 'Chidi Okeke',   balance: 40000, totalAmount: 60000, date: '2026-08-10' },
    { id: 'c', customerName: 'Ngozi Eze',     balance: 90000, totalAmount: 90000, date: '2026-08-15' },
  ];

  it('puts an exact balance match with a matching name first', () => {
    const parsed = parseBankAlert('₦25,000 from BOLA ADESANYA');
    expect(rankMatches(parsed, sales)[0].saleId).toBe('a');
  });

  it('still surfaces a plausible part payment', () => {
    const parsed = parseBankAlert('₦20,000 from CHIDI OKEKE');
    const top = rankMatches(parsed, sales)[0];
    expect(top.saleId).toBe('b');
  });

  it('drops candidates that score nothing', () => {
    // An amount larger than every invoice, and a name matching nobody.
    const parsed = parseBankAlert('₦500,000 from UNKNOWN PERSON');
    expect(rankMatches(parsed, sales)).toHaveLength(0);
  });

  it('never returns more than five suggestions', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      id: String(i), customerName: 'Someone', balance: 1000, totalAmount: 1000, date: '2026-08-01',
    }));
    expect(rankMatches(parseBankAlert('₦1,000'), many).length).toBeLessThanOrEqual(5);
  });
});
