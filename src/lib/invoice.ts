// ============================================================
// ProfixBook documents: invoice, quote / proforma, credit note, waybill.
//
// One layout for all four, so every document a customer receives looks
// like it came from the same business:
//   - the app's own font (Plus Jakarta Sans, embedded from /public/fonts)
//     so amounts print with a real naira sign, not "NGN";
//   - one thin brand line at the top instead of coloured slabs;
//   - a quiet table (light header, hairline rows, right-aligned money);
//   - totals on the right, "How to pay" on the left with the account
//     number large enough to copy from a phone screen.
// If the font can't be fetched (offline), it falls back to Helvetica and
// "NGN" so a PDF is still produced.
// ============================================================

type RGB = [number, number, number];
const INK: RGB = [15, 23, 42];
const BODY: RGB = [51, 65, 85];
const MUTED: RGB = [100, 116, 139];
const LINE: RGB = [226, 232, 240];
const SOFT: RGB = [248, 250, 252];
const HEAD: RGB = [241, 245, 249];
const ACCENT: RGB = [37, 99, 235];
const ACCENT_DARK: RGB = [29, 78, 216];
const ACCENT_SOFT: RGB = [239, 246, 255];
const GOOD: RGB = [21, 128, 61];
const GOOD_SOFT: RGB = [240, 253, 244];
const WARN: RGB = [180, 83, 9];
const WARN_SOFT: RGB = [255, 251, 235];

const M = 16; // page margin, mm

type BankDetails = { bank_name?: string; account_name?: string; account_number?: string } | null;

// ---------------- fonts ----------------
export const FONT_FILES = {
  regular: 'PlusJakartaSans-Regular.ttf',
  semibold: 'PlusJakartaSans-SemiBold.ttf',
  bold: 'PlusJakartaSans-Bold.ttf',
} as const;
export type Weight = keyof typeof FONT_FILES;
let fontCache: Promise<Record<Weight, string> | null> | null = null;

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...Array.from(bytes.subarray(i, i + 0x8000)));
  return btoa(bin);
}

export function loadFonts(): Promise<Record<Weight, string> | null> {
  if (!fontCache) {
    const base = (typeof process !== 'undefined' && process.env?.PUBLIC_URL) || '';
    fontCache = Promise.all((Object.keys(FONT_FILES) as Weight[]).map(async w => {
      const r = await fetch(`${base}/fonts/${FONT_FILES[w]}`);
      if (!r.ok) throw new Error('font');
      return [w, toBase64(await r.arrayBuffer())] as const;
    }))
      .then(entries => Object.fromEntries(entries) as Record<Weight, string>)
      .catch(() => { fontCache = null; return null; });
  }
  return fontCache;
}

interface Ctx {
  doc: any;
  autoTable: (doc: any, opts: any) => void;
  W: number;
  H: number;
  family: (w: Weight) => string;
  money: (n: number) => string;
}

async function start(): Promise<Ctx> {
  const [{ default: jsPDF }, { default: autoTable }, fonts] = await Promise.all([
    import('jspdf'),
    import('jspdf-autotable'),
    loadFonts(),
  ]);
  const doc: any = new jsPDF({ unit: 'mm', format: 'a4' });
  let family = (_w: Weight) => 'helvetica';
  if (fonts) {
    (Object.keys(FONT_FILES) as Weight[]).forEach(w => {
      doc.addFileToVFS(FONT_FILES[w], fonts[w]);
      doc.addFont(FONT_FILES[w], `PJS-${w}`, 'normal');
    });
    family = (w: Weight) => `PJS-${w}`;
  }
  const naira = fonts ? '₦' : 'NGN ';
  const money = (n: number) => {
    const v = Number(n) || 0;
    const frac = Math.round(v * 100) % 100 !== 0;
    return (v < 0 ? '-' : '') + naira + Math.abs(v).toLocaleString('en-NG', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 });
  };
  return {
    doc, autoTable: autoTable as any, W: doc.internal.pageSize.getWidth(), H: doc.internal.pageSize.getHeight(),
    family: fonts ? family : () => 'helvetica', money,
  };
}

// Helvetica has bold as a style; the embedded font has a file per weight.
function font(c: Ctx, w: Weight, size: number, color: RGB = INK) {
  if (c.family(w) === 'helvetica') c.doc.setFont('helvetica', w === 'regular' ? 'normal' : 'bold');
  else c.doc.setFont(c.family(w), 'normal');
  c.doc.setFontSize(size);
  c.doc.setTextColor(...color);
}

export const prettyDate = (iso?: string | null) => {
  if (!iso) return '';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

// ---------------- building blocks ----------------
function header(c: Ctx, o: {
  companyName: string; logoDataUrl?: string | null; lines: (string | null | undefined)[];
  title: string; docNo: string;
}): number {
  const { doc, W } = c;
  doc.setFillColor(...ACCENT);
  doc.rect(0, 0, W, 2, 'F');

  let x = M;
  if (o.logoDataUrl) {
    try {
      doc.addImage(o.logoDataUrl, o.logoDataUrl.includes('png') ? 'PNG' : 'JPEG', M, 14, 16, 16);
      x = M + 20;
    } catch { /* a broken logo never blocks the document */ }
  }
  font(c, 'bold', 15);
  doc.text(o.companyName, x, 20);
  font(c, 'regular', 8.5, MUTED);
  let y = 25.5;
  o.lines.filter(Boolean).forEach(l => { doc.text(String(l), x, y); y += 4.2; });

  font(c, 'semibold', 20);
  doc.text(o.title, W - M, 21, { align: 'right' });
  font(c, 'semibold', 9.5, MUTED);
  doc.text(o.docNo, W - M, 27, { align: 'right' });

  const bottom = Math.max(y, 32) + 4;
  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.3);
  doc.line(M, bottom, W - M, bottom);
  return bottom + 8;
}

// "Billed to" style block. Returns the y below it.
function party(c: Ctx, label: string, name: string, lines: (string | null | undefined)[], x: number, y: number, width = 80): number {
  font(c, 'semibold', 8, MUTED);
  c.doc.text(label, x, y);
  font(c, 'semibold', 11);
  const nameLines = c.doc.splitTextToSize(name, width);
  c.doc.text(nameLines, x, y + 6);
  let yy = y + 6 + nameLines.length * 5;
  font(c, 'regular', 9, BODY);
  lines.filter(Boolean).forEach(l => {
    const wrapped = c.doc.splitTextToSize(String(l), width);
    c.doc.text(wrapped, x, yy);
    yy += wrapped.length * 4.4;
  });
  return yy;
}

// Right-hand key facts (dates, references). Returns the y below it.
function facts(c: Ctx, rows: [string, string][], y: number): number {
  const xLabel = c.W - M - 62;
  rows.forEach(([k, v]) => {
    font(c, 'regular', 9, MUTED);
    c.doc.text(k, xLabel, y);
    font(c, 'semibold', 9, INK);
    c.doc.text(v, c.W - M, y, { align: 'right' });
    y += 5.6;
  });
  return y;
}

function chip(c: Ctx, text: string, tone: 'good' | 'warn' | 'accent', xRight: number, y: number) {
  const [fg, bg] = tone === 'good' ? [GOOD, GOOD_SOFT] : tone === 'warn' ? [WARN, WARN_SOFT] : [ACCENT_DARK, ACCENT_SOFT];
  font(c, 'semibold', 8.5, fg);
  const w = c.doc.getTextWidth(text) + 7;
  c.doc.setFillColor(...bg);
  c.doc.roundedRect(xRight - w, y - 4.3, w, 6.4, 3.2, 3.2, 'F');
  c.doc.text(text, xRight - w / 2, y, { align: 'center' });
}

function itemsTable(c: Ctx, y: number, head: string[], body: (string | number)[][], align: ('left' | 'right' | 'center')[], widths: Record<number, number> = {}) {
  const columnStyles: Record<number, any> = {};
  align.forEach((a, i) => { columnStyles[i] = { halign: a, ...(widths[i] ? { cellWidth: widths[i] } : {}) }; });
  columnStyles[0] = { ...columnStyles[0], textColor: MUTED };
  columnStyles[body[0]?.length - 1] = { ...columnStyles[body[0]?.length - 1], font: c.family('semibold'), fontStyle: c.family('semibold') === 'helvetica' ? 'bold' : 'normal' };
  c.autoTable(c.doc, {
    startY: y,
    margin: { left: M, right: M },
    head: [head],
    body,
    theme: 'plain',
    styles: { font: c.family('regular'), fontStyle: 'normal', fontSize: 9.2, textColor: INK, cellPadding: { top: 3.1, bottom: 3.1, left: 2.6, right: 2.6 }, lineColor: LINE },
    headStyles: { font: c.family('semibold'), fontStyle: c.family('semibold') === 'helvetica' ? 'bold' : 'normal', fontSize: 8.2, textColor: MUTED, fillColor: HEAD, cellPadding: { top: 2.6, bottom: 2.6, left: 2.6, right: 2.6 } },
    columnStyles,
    didParseCell: (data: any) => {
      if (data.section === 'head') data.cell.styles.halign = align[data.column.index];
      if (data.section === 'body') data.cell.styles.lineWidth = { bottom: 0.25 };
    },
  });
  return c.doc.lastAutoTable.finalY;
}

// Totals on the right. `strong` row gets a top rule; `box` row is the
// one figure the reader acts on (balance due / credit total).
function totals(c: Ctx, y: number, rows: { label: string; value: string; strong?: boolean; box?: 'accent' | 'good' }[]): number {
  const { doc, W } = c;
  const x = W - M - 74;
  rows.forEach(r => {
    if (r.box) {
      y += 1.5;
      const [fg, bg] = r.box === 'good' ? [GOOD, GOOD_SOFT] : [ACCENT_DARK, ACCENT_SOFT];
      doc.setFillColor(...bg);
      doc.roundedRect(x - 3, y - 5.6, 74 + 3, 10.4, 2, 2, 'F');
      font(c, 'semibold', 10, fg);
      doc.text(r.label, x, y + 0.6);
      font(c, 'bold', 12.5, fg);
      doc.text(r.value, W - M - 2.5, y + 0.8, { align: 'right' });
      y += 10;
      return;
    }
    if (r.strong) {
      y += 2.5;
      doc.setDrawColor(...LINE); doc.setLineWidth(0.3);
      doc.line(x, y - 5, W - M, y - 5);
    }
    font(c, r.strong ? 'semibold' : 'regular', r.strong ? 10.5 : 9.2, r.strong ? INK : MUTED);
    doc.text(r.label, x, y);
    font(c, r.strong ? 'bold' : 'semibold', r.strong ? 10.5 : 9.2, INK);
    doc.text(r.value, W - M, y, { align: 'right' });
    y += r.strong ? 7.5 : 6;
  });
  return y;
}

// "How to pay" panel, left of the totals.
function payBox(c: Ctx, bank: BankDetails, reference: string | null, y: number, title = 'How to pay'): number {
  if (!bank || !(bank.account_number || bank.bank_name)) return y;
  const { doc } = c;
  const w = 84;
  const h = reference ? 31 : 26;
  doc.setFillColor(...SOFT);
  doc.setDrawColor(...LINE);
  doc.setLineWidth(0.3);
  doc.roundedRect(M, y - 5, w, h, 2.5, 2.5, 'FD');
  font(c, 'semibold', 8, MUTED);
  doc.text(title, M + 5, y + 0.5);
  font(c, 'semibold', 9.5, BODY);
  doc.text(bank.bank_name || 'Bank transfer', M + 5, y + 6.5);
  font(c, 'bold', 14, INK);
  doc.text((bank.account_number || '').replace(/(\d{3})(\d{3})(\d{4})/, '$1 $2 $3'), M + 5, y + 13.5);
  font(c, 'regular', 8.5, MUTED);
  if (bank.account_name) doc.text(doc.splitTextToSize(bank.account_name, w - 10)[0], M + 5, y + 18.5);
  if (reference) {
    font(c, 'regular', 8, MUTED);
    doc.text(`Use ${reference} as the transfer narration.`, M + 5, y + 23.5);
  }
  return y - 5 + h;
}

function textBlock(c: Ctx, label: string, text: string, y: number): number {
  font(c, 'semibold', 8, MUTED);
  c.doc.text(label, M, y);
  font(c, 'regular', 9, BODY);
  const lines = c.doc.splitTextToSize(text, c.W - 2 * M);
  c.doc.text(lines, M, y + 5);
  return y + 5 + lines.length * 4.4 + 4;
}

function footer(c: Ctx, note: string) {
  const { doc, W, H } = c;
  const pages = doc.getNumberOfPages();
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.setDrawColor(...LINE); doc.setLineWidth(0.3);
    doc.line(M, H - 16, W - M, H - 16);
    font(c, 'regular', 8, MUTED);
    doc.text(note, M, H - 10.5);
    doc.text(pages > 1 ? `Page ${p} of ${pages}  ·  Made with ProfixBook` : 'Made with ProfixBook', W - M, H - 10.5, { align: 'right' });
  }
}

// ============================================================
// INVOICE
// ============================================================
export interface InvoiceData {
  companyName: string;
  companyAddress?: string | null;
  invoiceNo: string;
  date: string;
  customerName: string;
  customerPhone?: string | null;
  customerAddress?: string | null;
  items: { name: string; qty: number; unitPrice: number; amount: number }[];
  total: number;
  paid: number;
  balance: number;
  subtotal?: number;
  vatAmount?: number;
  vatRate?: number;
  tin?: string | null;
  logoDataUrl?: string | null;
  // When it should be paid (migration 0062); printed while money is owed.
  dueDate?: string | null;
  // Only printed when there's a balance left to collect.
  bankDetails?: BankDetails;
  // Sale-entity custom fields flagged show_on_invoice (migration 0032).
  customFields?: { label: string; value: any }[];
}

// Async because jsPDF, its table plugin and the font load on first use: a
// PDF is always user-triggered, and it keeps them out of the first download.
export async function generateInvoicePdf(d: InvoiceData) {
  const c = await start();
  let y = header(c, {
    companyName: d.companyName, logoDataUrl: d.logoDataUrl,
    lines: [d.companyAddress, d.tin ? `TIN ${d.tin}` : null],
    title: 'Invoice', docNo: d.invoiceNo,
  });

  const left = party(c, 'Billed to', d.customerName || 'Walk-in customer', [
    d.customerPhone, d.customerAddress,
    ...(d.customFields ?? []).map(f => `${f.label}: ${f.value}`),
  ], M, y);
  const status = d.balance <= 0 ? ['Paid in full', 'good'] : d.paid > 0 ? ['Part paid', 'warn'] : ['Unpaid', 'warn'];
  chip(c, status[0], status[1] as 'good' | 'warn', c.W - M, y);
  const right = facts(c, [
    ['Date issued', prettyDate(d.date)],
    ...(d.balance > 0 && d.dueDate && d.dueDate.slice(0, 10) !== d.date.slice(0, 10) ? [['Due by', prettyDate(d.dueDate)] as [string, string]] : []),
    ...(d.balance > 0 ? [['Amount due', c.money(d.balance)] as [string, string]] : []),
  ], y + 8);
  y = Math.max(left, right) + 6;

  y = itemsTable(c, y, ['#', 'Description', 'Qty', 'Unit price', 'Amount'],
    d.items.map((i, n) => [n + 1, i.name, i.qty.toLocaleString('en-NG'), c.money(i.unitPrice), c.money(i.amount)]),
    ['left', 'left', 'right', 'right', 'right'], { 0: 9, 2: 18, 3: 30, 4: 32 }) + 10;

  const rows: Parameters<typeof totals>[2] = [];
  if (d.vatAmount && d.vatAmount > 0) {
    rows.push({ label: 'Subtotal', value: c.money(d.subtotal ?? d.total - d.vatAmount) });
    rows.push({ label: `VAT (${d.vatRate ?? 7.5}%)`, value: c.money(d.vatAmount) });
  }
  rows.push({ label: 'Total', value: c.money(d.total), strong: true });
  if (d.paid > 0) rows.push({ label: 'Paid', value: c.money(d.paid) });
  rows.push(d.balance > 0
    ? { label: 'Balance due', value: c.money(d.balance), box: 'accent' }
    : { label: 'Paid in full', value: c.money(d.total), box: 'good' });
  const yTotals = totals(c, y, rows);
  const yPay = d.balance > 0 ? payBox(c, d.bankDetails ?? null, d.invoiceNo, y) : y;

  footer(c, d.balance > 0 ? 'Thank you. Please pay the balance due to the account shown.' : 'Thank you for your business.');
  void yTotals; void yPay;
  c.doc.save(`${d.invoiceNo}.pdf`);
}

// ============================================================
// CREDIT NOTE: a partial or full return against an existing invoice
// (migration 0023). Its own document: the invoice never changes after
// it's issued.
// ============================================================
export interface CreditNoteData {
  companyName: string;
  creditNoteNo: string;
  invoiceNo: string;
  date: string;
  customerName: string;
  customerPhone?: string | null;
  reason?: string | null;
  items: { name: string; qty: number; unitPrice: number; amount: number; condition: string }[];
  subtotal: number;
  vatAmount: number;
  vatRate: number;
  total: number;
  appliedToBalance: number;
  refunded: number;
  toStoreCredit: number;
  tin?: string | null;
  logoDataUrl?: string | null;
  companyAddress?: string | null;
}

const CONDITION_LABEL: Record<string, string> = { resellable: 'Resellable', damaged: 'Damaged', expired: 'Expired' };

export async function generateCreditNotePdf(d: CreditNoteData) {
  const c = await start();
  let y = header(c, {
    companyName: d.companyName, logoDataUrl: d.logoDataUrl,
    lines: [d.companyAddress, d.tin ? `TIN ${d.tin}` : null],
    title: 'Credit note', docNo: d.creditNoteNo,
  });
  const left = party(c, 'Returned by', d.customerName || 'Walk-in customer', [d.customerPhone, d.reason ? `Reason: ${d.reason}` : null], M, y);
  const right = facts(c, [['Date', prettyDate(d.date)], ['Against invoice', d.invoiceNo]], y + 2);
  y = Math.max(left, right) + 6;

  y = itemsTable(c, y, ['#', 'Description', 'Condition', 'Qty', 'Unit price', 'Amount'],
    d.items.map((i, n) => [n + 1, i.name, CONDITION_LABEL[i.condition] ?? i.condition, i.qty.toLocaleString('en-NG'), c.money(i.unitPrice), c.money(i.amount)]),
    ['left', 'left', 'left', 'right', 'right', 'right'], { 0: 9, 2: 24, 3: 16, 4: 28, 5: 30 }) + 10;

  const rows: Parameters<typeof totals>[2] = [];
  if (d.vatAmount > 0) {
    rows.push({ label: 'Subtotal', value: c.money(d.subtotal) });
    rows.push({ label: `VAT (${d.vatRate}%)`, value: c.money(d.vatAmount) });
  }
  rows.push({ label: 'Credit total', value: c.money(d.total), box: 'accent' });
  totals(c, y, rows);

  // How the credit was settled, left of the totals.
  const settled: [string, number][] = [
    ['Taken off the balance owed', d.appliedToBalance], ['Refunded', d.refunded], ['Added to store credit', d.toStoreCredit],
  ].filter(([, v]) => (v as number) > 0) as [string, number][];
  if (settled.length) {
    font(c, 'semibold', 8, MUTED);
    c.doc.text('How this credit was settled', M, y);
    let yy = y + 6;
    settled.forEach(([k, v]) => {
      font(c, 'regular', 9.2, BODY); c.doc.text(k, M, yy);
      font(c, 'semibold', 9.2, INK); c.doc.text(c.money(v), M + 78, yy, { align: 'right' });
      yy += 5.8;
    });
  }

  footer(c, 'Keep this credit note with your original invoice.');
  c.doc.save(`${d.creditNoteNo}.pdf`);
}

// ============================================================
// QUOTE / PROFORMA INVOICE: a price offer that hasn't touched stock or
// money yet (migration 0028). Both print the seller's bank details, so a
// customer who accepts never has to ask for the account number.
// ============================================================
export interface QuoteData {
  companyName: string;
  kind: 'quote' | 'proforma';
  docNo: string;
  date: string;
  validUntil?: string | null;
  customerName: string;
  customerPhone?: string | null;
  customerAddress?: string | null;
  items: { name: string; qty: number; unitPrice: number; amount: number }[];
  subtotal: number;
  vatAmount: number;
  vatRate: number;
  total: number;
  notes?: string | null;
  terms?: string | null;
  bankDetails?: BankDetails;
  tin?: string | null;
  logoDataUrl?: string | null;
  companyAddress?: string | null;
}

export async function generateQuotePdf(d: QuoteData) {
  const c = await start();
  const proforma = d.kind === 'proforma';
  let y = header(c, {
    companyName: d.companyName, logoDataUrl: d.logoDataUrl,
    lines: [d.companyAddress, d.tin ? `TIN ${d.tin}` : null],
    title: proforma ? 'Proforma invoice' : 'Quotation', docNo: d.docNo,
  });
  const left = party(c, proforma ? 'Billed to' : 'Prepared for', d.customerName || 'Customer', [d.customerPhone, d.customerAddress], M, y);
  const right = facts(c, [
    ['Date', prettyDate(d.date)],
    ...(d.validUntil ? [['Valid until', prettyDate(d.validUntil)] as [string, string]] : []),
  ], y + 2);
  y = Math.max(left, right) + 6;

  y = itemsTable(c, y, ['#', 'Description', 'Qty', 'Unit price', 'Amount'],
    d.items.map((i, n) => [n + 1, i.name, i.qty.toLocaleString('en-NG'), c.money(i.unitPrice), c.money(i.amount)]),
    ['left', 'left', 'right', 'right', 'right'], { 0: 9, 2: 18, 3: 30, 4: 32 }) + 10;

  const rows: Parameters<typeof totals>[2] = [];
  if (d.vatAmount > 0) {
    rows.push({ label: 'Subtotal', value: c.money(d.subtotal) });
    rows.push({ label: `VAT (${d.vatRate}%)`, value: c.money(d.vatAmount) });
  }
  rows.push({ label: proforma ? 'Amount to pay' : 'Total', value: c.money(d.total), box: 'accent' });
  const yTotals = totals(c, y, rows);
  const yPay = payBox(c, d.bankDetails ?? null, d.docNo, y, proforma ? 'How to pay' : 'To accept, pay into');

  let yy = Math.max(yTotals, yPay) + 8;
  if (d.terms) yy = textBlock(c, 'Terms', d.terms, yy);
  if (d.notes) textBlock(c, 'Notes', d.notes, yy);

  footer(c, d.validUntil ? `This ${proforma ? 'proforma' : 'quote'} is valid until ${prettyDate(d.validUntil)}.` : 'Thank you for considering us.');
  c.doc.save(`${d.docNo}.pdf`);
}

// ============================================================
// DELIVERY NOTE / WAYBILL: no prices, space for a signature (migration
// 0031). What travels with the goods, not what they cost.
// ============================================================
export interface WaybillData {
  companyName: string;
  docNo: string;
  date: string;
  customerName: string;
  customerAddress?: string | null;
  destination?: string | null;
  driverName?: string | null;
  vehicleNo?: string | null;
  items: { name: string; qty: number; unit?: string | null }[];
  note?: string | null;
  tin?: string | null;
  logoDataUrl?: string | null;
  companyAddress?: string | null;
  invoiceNo?: string | null;
  customerPhone?: string | null;
}

export async function generateWaybillPdf(d: WaybillData) {
  const c = await start();
  let y = header(c, {
    companyName: d.companyName, logoDataUrl: d.logoDataUrl,
    lines: [d.companyAddress, d.tin ? `TIN ${d.tin}` : null],
    title: 'Waybill', docNo: d.docNo,
  });
  const left = party(c, 'Deliver to', d.customerName || 'Customer', [d.customerPhone, d.destination || d.customerAddress], M, y);
  const right = facts(c, [
    ['Date', prettyDate(d.date)],
    ...(d.invoiceNo ? [['Invoice', d.invoiceNo] as [string, string]] : []),
    ...(d.driverName ? [['Driver', d.driverName] as [string, string]] : []),
    ...(d.vehicleNo ? [['Vehicle', d.vehicleNo] as [string, string]] : []),
  ], y + 2);
  y = Math.max(left, right) + 6;

  y = itemsTable(c, y, ['#', 'Description', 'Quantity'],
    d.items.map((i, n) => [n + 1, i.name, `${i.qty.toLocaleString('en-NG')}${i.unit ? ` ${i.unit}` : ''}`]),
    ['left', 'left', 'right'], { 0: 9, 2: 34 }) + 8;

  font(c, 'regular', 8.5, MUTED);
  c.doc.text(`${d.items.length} ${d.items.length === 1 ? 'line' : 'lines'}, ${d.items.reduce((s, i) => s + i.qty, 0).toLocaleString('en-NG')} items in total.`, M, y);
  y += 8;
  if (d.note) y = textBlock(c, 'Note', d.note, y);

  // Signatures at the foot of the page, where they're expected.
  const sy = c.H - 48;
  const colW = (c.W - 2 * M - 12) / 2;
  [['Dispatched by', M], ['Received in good condition by', M + colW + 12]].forEach(([label, x]) => {
    font(c, 'semibold', 8, MUTED);
    c.doc.text(String(label), x as number, sy);
    c.doc.setDrawColor(...LINE); c.doc.setLineWidth(0.3);
    c.doc.line(x as number, sy + 12, (x as number) + colW, sy + 12);
    font(c, 'regular', 7.5, MUTED);
    c.doc.text('Name and signature', x as number, sy + 16);
    c.doc.text('Date', (x as number) + colW, sy + 16, { align: 'right' });
  });

  footer(c, 'Check the goods before signing.');
  c.doc.save(`${d.docNo}.pdf`);
}
