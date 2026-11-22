// Split out of invoice.ts so pages that only need a WhatsApp link (Dashboard,
// Reports) don't drag jsPDF into their bundle — it was ~200 kB of PDF engine
// pulled in for a string builder.

// Build a WhatsApp deep link. Nigerian local numbers (080…) are
// converted to international format (23480…). Without a phone the
// link opens WhatsApp's contact picker instead.
export function whatsappLink(phone: string | null | undefined, text: string): string {
  const encoded = encodeURIComponent(text);
  if (phone && phone.trim()) {
    let p = phone.replace(/[^\d+]/g, '');
    if (p.startsWith('+')) p = p.slice(1);
    if (p.startsWith('0')) p = '234' + p.slice(1);
    return `https://wa.me/${p}?text=${encoded}`;
  }
  return `https://wa.me/?text=${encoded}`;
}

export interface BankDetails { bank_name?: string; account_name?: string; account_number?: string }

export function hasBank(b: BankDetails | null | undefined): b is BankDetails {
  return !!(b && (b.account_number?.trim() || b.bank_name?.trim()));
}

// The "how to pay" lines that go at the end of every money message a
// customer receives (reminder, receipt with a balance, quote, statement).
// Without these the customer knows they owe, but not where to send it.
export function howToPayLines(bank: BankDetails | null | undefined, payUrl?: string | null, payUntil?: string | null): string[] {
  const lines: string[] = [];
  if (payUrl) {
    lines.push('*Pay online (card, transfer or USSD):*', payUrl);
    if (payUntil) {
      const t = new Date(payUntil).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
      lines.push(`This link works until ${t} today. Ask us for a new one after that.`);
    }
    lines.push('');
  }
  if (hasBank(bank)) {
    lines.push(payUrl ? '*Or pay by bank transfer:*' : '*Pay by bank transfer:*');
    if (bank.bank_name?.trim()) lines.push(`Bank: ${bank.bank_name.trim()}`);
    if (bank.account_number?.trim()) lines.push(`Account number: ${bank.account_number.trim()}`);
    if (bank.account_name?.trim()) lines.push(`Account name: ${bank.account_name.trim()}`);
    lines.push('');
  }
  return lines;
}

const nairaFmt = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

// A payment request for one customer: what they owe, on which invoices,
// and exactly how to pay it.
export function paymentRequestMessage(p: {
  businessName: string;
  customerName: string;
  total: number;
  invoices?: { docNo: string; date?: string | null; balance: number }[];
  bank?: BankDetails | null;
  payUrl?: string | null;
  payUntil?: string | null;
  friendly?: boolean;
}): string {
  const lines: string[] = [
    `Hello ${p.customerName},`,
    '',
    p.friendly === false
      ? `This is a payment request from *${p.businessName}*.`
      : `This is a friendly payment reminder from *${p.businessName}*.`,
    `Amount due: *${nairaFmt(p.total)}*`,
  ];
  const inv = (p.invoices ?? []).filter(i => i.balance > 0);
  if (inv.length > 0) {
    lines.push('');
    for (const i of inv.slice(0, 8)) lines.push(`• ${i.docNo}${i.date ? ` (${i.date})` : ''}: ${nairaFmt(i.balance)}`);
    if (inv.length > 8) lines.push(`• and ${inv.length - 8} more`);
  }
  lines.push('');
  lines.push(...howToPayLines(p.bank, p.payUrl, p.payUntil));
  lines.push('Please send your payment receipt here once you pay. Thank you!');
  return lines.join('\n');
}
