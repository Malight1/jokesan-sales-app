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
