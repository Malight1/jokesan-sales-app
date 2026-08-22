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
