import { whatsappLink } from '../whatsapp';

describe('whatsappLink', () => {
  it('converts a Nigerian local number to international format', () => {
    // 080… is how customers actually give their number; wa.me needs 23480…
    expect(whatsappLink('08031234567', 'hi')).toContain('wa.me/2348031234567');
  });

  it('strips a leading + and keeps the country code', () => {
    expect(whatsappLink('+2348031234567', 'hi')).toContain('wa.me/2348031234567');
  });

  it('ignores spaces, dashes and brackets in a pasted number', () => {
    expect(whatsappLink('0803 123-4567', 'hi')).toContain('wa.me/2348031234567');
  });

  it('opens the contact picker when there is no phone number', () => {
    const link = whatsappLink(null, 'hi');
    expect(link).toBe('https://wa.me/?text=hi');
  });

  it('treats blank/whitespace as no number', () => {
    expect(whatsappLink('   ', 'hi')).toBe('https://wa.me/?text=hi');
  });

  it('url-encodes the message body', () => {
    // Reminder text contains newlines, ₦ and * for WhatsApp bold.
    const link = whatsappLink('08031234567', 'Balance *₦1,500*\nThanks');
    expect(link).toContain('%E2%82%A6');   // ₦
    expect(link).toContain('%0A');          // newline
    expect(link).not.toContain(' ');
  });
});

describe('payment requests', () => {
  const { paymentRequestMessage, howToPayLines, hasBank } = require('../whatsapp');
  const bank = { bank_name: 'Access Bank', account_number: '0123456789', account_name: 'Ada Stores' };

  it('tells the customer exactly where to pay', () => {
    const msg = paymentRequestMessage({ businessName: 'Ada Stores', customerName: 'Bola', total: 42500, bank });
    expect(msg).toContain('₦42,500');
    expect(msg).toContain('Account number: 0123456789');
    expect(msg).toContain('Bank: Access Bank');
    expect(msg).toContain('Account name: Ada Stores');
  });

  it('puts a pay link first when there is one', () => {
    const lines = howToPayLines(bank, 'https://paystack.com/pay/abc');
    expect(lines[0]).toMatch(/Pay online/);
    expect(lines).toContain('https://paystack.com/pay/abc');
    expect(lines.join('\n')).toMatch(/Or pay by bank transfer/);
  });

  it('lists only invoices with a balance', () => {
    const msg = paymentRequestMessage({
      businessName: 'X', customerName: 'Y', total: 100,
      invoices: [{ docNo: 'INV-1', balance: 100 }, { docNo: 'INV-2', balance: 0 }],
    });
    expect(msg).toContain('INV-1');
    expect(msg).not.toContain('INV-2');
  });

  it('adds nothing about banks when none is saved', () => {
    expect(howToPayLines(null)).toEqual([]);
    expect(hasBank({ bank_name: ' ', account_number: '' })).toBe(false);
  });
});
