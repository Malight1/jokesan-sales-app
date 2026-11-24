// Till receipt for the small thermal printers shops use (58mm and 80mm
// rolls, Bluetooth or USB). Printed through the browser's own print dialog
// from a hidden iframe, so it works with any printer the phone or laptop
// can already see, with no driver or app of ours in between.
//
// The full-page invoice stays in invoice.ts (jsPDF); this is plain HTML so
// the ₦ sign prints, and so nothing heavy loads at the counter.

export type ReceiptWidth = 58 | 80;

export interface ReceiptData {
  companyName: string;
  companyAddress?: string | null;
  tin?: string | null;
  invoiceNo: string;
  date: Date;
  customerName?: string | null;
  items: { name: string; qty: number; unitPrice: number; amount: number }[];
  subtotal?: number;
  vatAmount?: number;
  vatRate?: number;
  total: number;
  paid: number;
  change?: number;
  balance: number;
  offline?: boolean;
}

const WIDTH_KEY = 'pfb_receipt_width';

// The printer belongs to this device, not the business, so the paper
// width is remembered here rather than in Settings.
export function getReceiptWidth(): ReceiptWidth {
  try { return localStorage.getItem(WIDTH_KEY) === '58' ? 58 : 80; }
  catch { return 80; }
}

export function setReceiptWidth(w: ReceiptWidth) {
  try { localStorage.setItem(WIDTH_KEY, String(w)); } catch { /* private window: just don't remember */ }
}

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const money = (n: number) => '₦' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function receiptHtml(d: ReceiptData, width: ReceiptWidth): string {
  // Printable width is a little under the roll: about 48mm on 58mm paper
  // and 72mm on 80mm.
  const printable = width === 58 ? 48 : 72;
  const small = width === 58;
  const row = (label: string, value: string, strong = false) =>
    `<div class="row${strong ? ' strong' : ''}"><span>${esc(label)}</span><span>${esc(value)}</span></div>`;

  const items = d.items.map(i => `
    <div class="item">
      <div class="name">${esc(i.name)}</div>
      <div class="row"><span>${i.qty.toLocaleString()} × ${esc(money(i.unitPrice))}</span><span>${esc(money(i.amount))}</span></div>
    </div>`).join('');

  const showSubtotal = d.subtotal !== undefined && (d.vatAmount ?? 0) > 0;
  const when = d.date.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(d.invoiceNo)}</title>
<style>
  @page { size: ${width}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { width: ${printable}mm; margin: 0 auto; padding: 3mm 0 6mm;
         font: ${small ? 10 : 11.5}px/1.35 ui-monospace, Menlo, Consolas, "Courier New", monospace; }
  .center { text-align: center; }
  h1 { font-size: ${small ? 13 : 15}px; margin: 0 0 1mm; }
  .muted { font-size: ${small ? 9 : 10}px; }
  .rule { border-top: 1px dashed #000; margin: 2mm 0; }
  .row { display: flex; justify-content: space-between; gap: 2mm; }
  .row span:last-child { white-space: nowrap; }
  .strong { font-weight: 700; font-size: ${small ? 11.5 : 13}px; }
  .item { margin-bottom: 1.2mm; }
  .item .name { word-break: break-word; }
</style></head>
<body>
  <div class="center">
    <h1>${esc(d.companyName)}</h1>
    ${d.companyAddress ? `<div class="muted">${esc(d.companyAddress)}</div>` : ''}
    ${d.tin ? `<div class="muted">TIN ${esc(d.tin)}</div>` : ''}
  </div>
  <div class="rule"></div>
  ${row(d.offline ? 'Receipt (not yet synced)' : 'Receipt', d.invoiceNo)}
  ${row('Date', when)}
  ${d.customerName ? row('Customer', d.customerName) : ''}
  <div class="rule"></div>
  ${items}
  <div class="rule"></div>
  ${showSubtotal ? row('Subtotal', money(d.subtotal!)) : ''}
  ${showSubtotal ? row(`VAT (${d.vatRate ?? 0}%)`, money(d.vatAmount!)) : ''}
  ${row('TOTAL', money(d.total), true)}
  ${row('Paid', money(d.paid))}
  ${(d.change ?? 0) > 0 ? row('Change', money(d.change!)) : ''}
  ${d.balance > 0 ? row('Balance owed', money(d.balance), true) : ''}
  <div class="rule"></div>
  <div class="center">Thank you for your custom.</div>
</body></html>`;
}

/** Opens the print dialog for a receipt. Resolves once the dialog is shown. */
export function printReceipt(d: ReceiptData, width: ReceiptWidth = getReceiptWidth()): Promise<void> {
  return printHtml(receiptHtml(d, width));
}

/** Prints a whole HTML document from a hidden iframe. */
export function printHtml(html: string): Promise<void> {
  return new Promise(resolve => {
    const frame = document.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    frame.onload = () => {
      const win = frame.contentWindow;
      if (!win) { frame.remove(); resolve(); return; }
      // Removing the frame straight after print() cancels the job on some
      // mobile browsers, so it stays until the dialog has closed.
      win.addEventListener('afterprint', () => setTimeout(() => frame.remove(), 500));
      setTimeout(() => frame.remove(), 60000);
      win.focus();
      win.print();
      resolve();
    };
    frame.srcdoc = html;
    document.body.appendChild(frame);
  });
}

// ---- Z report (end of shift) ----

/** Naira notes counted at close, biggest first. */
export const NOTE_VALUES = [1000, 500, 200, 100, 50, 20, 10, 5] as const;

export interface ZReportData {
  doc_no?: string | null;
  business_name?: string | null; branch_name?: string | null; register_name?: string | null;
  opened_by_name?: string | null; closed_by_name?: string | null;
  opened_at: string; closed_at?: string | null;
  opening_float: number;
  sales_count: number; sales_total: number; discount_total: number; refunds_total: number;
  credit_given?: number;
  expected: Record<string, number | undefined>;
  cash_movements?: { kind: 'pay_in' | 'pay_out' | 'drop'; amount: number; reason: string }[];
  counted_cash?: number | null; counted_breakdown?: Record<string, number> | null;
  variance?: number | null; notes?: string | null;
  // Transfers confirmed by a provider on this till (migration 0058).
  confirmed?: { provider: string; total: number; count: number }[];
}

const PROVIDER_LABEL: Record<string, string> = { monnify: 'Moniepoint', paystack: 'Paystack', opay: 'OPay' };

// Keys of `expected` that are cash workings, not payment methods.
const CASH_KEYS = new Set(['cash', 'opening_float', 'cash_sales', 'pay_in', 'pay_out', 'drop']);
const METHOD_LABEL: Record<string, string> = { transfer: 'Transfer', card: 'Card (POS)', store_credit: 'Store credit / other' };
const MOVE_LABEL = { pay_in: 'Pay-in', pay_out: 'Pay-out', drop: 'To bank or safe' } as const;

// Short enough to fit a 58mm roll next to its label.
const when = (iso?: string | null) => iso
  ? new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '';

/** The Z report's lines as label/value pairs, shared by print and WhatsApp. */
export function zReportSections(z: ZReportData): { title: string; rows: [string, string, boolean?][] }[] {
  const e = z.expected ?? {};
  const methods = Object.keys(e).filter(k => !CASH_KEYS.has(k) && Number(e[k] || 0) !== 0);
  const variance = z.variance ?? 0;
  const breakdown = z.counted_breakdown ?? {};
  const noteRows: [string, string][] = NOTE_VALUES
    .filter(n => Number(breakdown[String(n)] || 0) > 0)
    .map(n => [`₦${n.toLocaleString()} × ${breakdown[String(n)]}`, money(n * Number(breakdown[String(n)]))]);
  if (Number(breakdown.other || 0) > 0) noteRows.push(['Coins and other', money(Number(breakdown.other))]);

  return [
    { title: 'Till', rows: [
      ['Z report', z.doc_no ?? ''],
      ...(z.branch_name ? [['Branch', z.branch_name] as [string, string]] : []),
      ...(z.register_name ? [['Till', z.register_name] as [string, string]] : []),
      ['Opened', when(z.opened_at)],
      ['Closed', when(z.closed_at)],
      ...(z.opened_by_name ? [['Cashier', z.opened_by_name] as [string, string]] : []),
      ...(z.closed_by_name && z.closed_by_name !== z.opened_by_name ? [['Closed by', z.closed_by_name] as [string, string]] : []),
    ] },
    { title: 'Sales', rows: [
      ['Sales', `${z.sales_count} for ${money(z.sales_total)}`, true],
      ...(z.discount_total ? [['Discounts given', money(z.discount_total)] as [string, string]] : []),
      ...(z.refunds_total ? [['Refunds', money(z.refunds_total)] as [string, string]] : []),
      ...(z.credit_given ? [['Left owing (credit)', money(z.credit_given)] as [string, string]] : []),
    ] },
    { title: 'Payments taken', rows: [
      ['Cash', money(Number(e.cash_sales || 0))],
      ...methods.map(k => [METHOD_LABEL[k] ?? k.charAt(0).toUpperCase() + k.slice(1).replace(/_/g, ' '), money(Number(e[k] || 0))] as [string, string]),
    ] },
    ...((z.confirmed ?? []).length ? [{ title: 'Confirmed transfers', rows: (z.confirmed ?? []).map(c =>
      [`${PROVIDER_LABEL[c.provider] ?? c.provider} (${c.count})`, money(Number(c.total || 0))] as [string, string]) }] : []),
    { title: 'Cash drawer', rows: [
      ['Opening float', money(Number(e.opening_float ?? z.opening_float ?? 0))],
      ['Cash sales', money(Number(e.cash_sales || 0))],
      ...(z.cash_movements ?? []).map(m => [`${MOVE_LABEL[m.kind]}: ${m.reason}`, `${m.kind === 'pay_in' ? '' : '−'}${money(m.amount)}`] as [string, string]),
      ['Expected in drawer', money(Number(e.cash || 0)), true],
      ['Counted', money(Number(z.counted_cash || 0)), true],
      [variance === 0 ? 'Balanced' : variance > 0 ? 'Over' : 'Short', money(Math.abs(variance)), true],
    ] },
    ...(noteRows.length ? [{ title: 'Note count', rows: noteRows }] : []),
  ];
}

export function zReportHtml(z: ZReportData, width: ReceiptWidth): string {
  const printable = width === 58 ? 48 : 72;
  const small = width === 58;
  const body = zReportSections(z).map(sec => `
    <div class="rule"></div>
    <div class="sec">${esc(sec.title)}</div>
    ${sec.rows.map(([l, v, strong]) => `<div class="row${strong ? ' strong' : ''}"><span>${esc(l)}</span><span>${esc(v)}</span></div>`).join('')}
  `).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(z.doc_no ?? 'Z report')}</title>
<style>
  @page { size: ${width}mm auto; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { width: ${printable}mm; margin: 0 auto; padding: 3mm 0 6mm;
         font: ${small ? 10 : 11.5}px/1.35 ui-monospace, Menlo, Consolas, "Courier New", monospace; }
  .center { text-align: center; }
  h1 { font-size: ${small ? 13 : 15}px; margin: 0 0 1mm; }
  .rule { border-top: 1px dashed #000; margin: 2mm 0; }
  .sec { font-weight: 700; margin-bottom: 1mm; }
  .row { display: flex; justify-content: space-between; gap: 2mm; }
  .row span:first-child { word-break: break-word; }
  .row span:last-child { white-space: nowrap; }
  .strong { font-weight: 700; }
  .notes { margin-top: 2mm; word-break: break-word; }
</style></head>
<body>
  <div class="center">
    <h1>${esc(z.business_name ?? 'End of shift')}</h1>
    <div>END OF SHIFT (Z) REPORT</div>
  </div>
  ${body}
  ${z.notes ? `<div class="rule"></div><div class="notes">Notes: ${esc(z.notes)}</div>` : ''}
</body></html>`;
}

/** The same report as a WhatsApp message for the owner. */
export function zReportText(z: ZReportData): string {
  const lines = [`*${z.business_name ?? 'End of shift'}: ${z.doc_no ?? 'Z report'}*`];
  for (const sec of zReportSections(z)) {
    if (sec.title === 'Till') {
      lines.push(...sec.rows.slice(1).map(([l, v]) => `${l}: ${v}`));
      continue;
    }
    lines.push('', `*${sec.title}*`, ...sec.rows.map(([l, v, strong]) => strong ? `*${l}: ${v}*` : `${l}: ${v}`));
  }
  if (z.notes) lines.push('', `Notes: ${z.notes}`);
  return lines.join('\n');
}
