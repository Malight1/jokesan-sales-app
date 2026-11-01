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
    frame.srcdoc = receiptHtml(d, width);
    document.body.appendChild(frame);
  });
}
