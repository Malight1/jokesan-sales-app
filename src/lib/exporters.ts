// Report and table exports (PDF, Excel, CSV).
//
// Every export carries the business name, what it is, the dates it covers
// and when it was printed, then one or more tables. A column marked
// `total` gets a Total row; a column marked `money` prints as ₦1,234.50 in
// the PDF and stays a real number (formatted, so it can still be added
// up) in Excel.
//
// xlsx and jsPDF are both large and only ever needed once a user actually
// clicks Export, so they're pulled in on demand.
import { FONT_FILES, Weight, loadFonts } from './invoice';

export interface ExportColumn<T = any> {
  header: string;
  value: (row: T) => string | number | null | undefined;
  money?: boolean;      // ₦ in the PDF, number format in Excel
  total?: boolean;      // add up in the Total row
  align?: 'left' | 'right';
}

export interface ExportTable<T = any> {
  heading?: string;
  columns: ExportColumn<T>[];
  rows: T[];
  totalLabel?: string;
  strong?: (row: T) => boolean;   // subtotal lines, printed bold
}

export interface ExportDoc {
  name: string;          // file name, without extension
  title: string;         // what it is: "Profit & Loss"
  business?: string;     // whose it is
  subtitle?: string;     // the dates / branch it covers
  tables: ExportTable[];
  notes?: string[];      // plain lines printed after the tables
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v));
const isNum = (v: unknown) => v !== null && v !== '' && v !== undefined && Number.isFinite(num(v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const printedAt = () => new Date().toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

function totalsFor(t: ExportTable): (number | string | null)[] | null {
  if (!t.columns.some(c => c.total)) return null;
  const out: (number | string | null)[] = t.columns.map(c => (c.total
    ? round2(t.rows.reduce((s, r) => { const v = c.value(r); return s + (isNum(v) ? num(v) : 0); }, 0))
    : null));
  const labelAt = t.columns.findIndex(c => !c.total);
  if (labelAt >= 0) out[labelAt] = t.totalLabel ?? 'Total';
  return out;
}

const cellValue = (c: ExportColumn, v: unknown) => (c.money && isNum(v) ? round2(num(v)) : (v ?? ''));

function sheetRows(d: ExportDoc): { aoa: any[][]; money: [number, number][] } {
  const aoa: any[][] = [];
  const money: [number, number][] = [];
  if (d.business) aoa.push([d.business]);
  aoa.push([d.title]);
  if (d.subtitle) aoa.push([d.subtitle]);
  aoa.push([`Printed ${printedAt()}`]);
  d.tables.forEach(t => {
    aoa.push([]);
    if (t.heading) aoa.push([t.heading]);
    aoa.push(t.columns.map(c => c.header));
    const mark = () => t.columns.forEach((c, i) => { if (c.money) money.push([aoa.length - 1, i]); });
    t.rows.forEach(r => { aoa.push(t.columns.map(c => cellValue(c, c.value(r)))); mark(); });
    const tot = totalsFor(t);
    if (tot) { aoa.push(tot.map(v => v ?? '')); mark(); }
  });
  if (d.notes?.length) { aoa.push([]); d.notes.forEach(n => aoa.push([n])); }
  return { aoa, money };
}

async function buildSheet(d: ExportDoc) {
  const XLSX = await import('xlsx');
  const { aoa, money } = sheetRows(d);
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  money.forEach(([r, c]) => {
    const cell = ws[XLSX.utils.encode_cell({ r, c })];
    if (cell && cell.t === 'n') cell.z = '#,##0.00;(#,##0.00)';
  });
  const widths: number[] = [];
  d.tables.forEach(t => t.columns.forEach((c, i) => {
    const longest = Math.max(c.header.length, ...t.rows.slice(0, 500).map(r => String(c.value(r) ?? '').length));
    widths[i] = Math.min(48, Math.max(widths[i] ?? 10, longest + 2));
  }));
  ws['!cols'] = widths.map(w => ({ wch: w }));
  return { XLSX, ws };
}

export async function exportReport(kind: 'xlsx' | 'csv' | 'pdf', d: ExportDoc) {
  if (kind === 'pdf') return reportPdf(d);
  const { XLSX, ws } = await buildSheet(d);
  if (kind === 'csv') {
    download(XLSX.utils.sheet_to_csv(ws), `${d.name}.csv`, 'text/csv;charset=utf-8;');
    return;
  }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, d.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Report');
  XLSX.writeFile(wb, `${d.name}.xlsx`);
}

async function reportPdf(d: ExportDoc) {
  const [{ default: jsPDF }, { default: autoTable }, fonts] = await Promise.all([
    import('jspdf'), import('jspdf-autotable'), loadFonts(),
  ]);
  const wide = d.tables.some(t => t.columns.length > 6);
  const doc: any = new jsPDF({ unit: 'mm', format: 'a4', orientation: wide ? 'landscape' : 'portrait' });
  let font = (_w: Weight) => 'helvetica';
  if (fonts) {
    (Object.keys(FONT_FILES) as Weight[]).forEach(w => {
      doc.addFileToVFS(FONT_FILES[w], fonts[w]);
      doc.addFont(FONT_FILES[w], `PJS-${w}`, 'normal');
    });
    font = (w: Weight) => `PJS-${w}`;
  }
  const naira = fonts ? '₦' : 'NGN ';
  const money = (v: number) => {
    const frac = Math.round(Math.abs(v) * 100) % 100 !== 0;
    const body = naira + Math.abs(v).toLocaleString('en-NG', { minimumFractionDigits: frac ? 2 : 0, maximumFractionDigits: 2 });
    return v < 0 ? `(${body})` : body;   // accountants' brackets for money going out
  };
  const show = (c: ExportColumn, v: unknown) => {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
      return new Date(v + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
    }
    if (c.money && isNum(v)) return money(num(v));
    if (typeof v === 'number') return v.toLocaleString('en-NG', { maximumFractionDigits: 3 });
    return String(v);
  };
  const W = doc.internal.pageSize.getWidth();
  const M = 14;
  const ink: [number, number, number] = [15, 23, 42];
  const muted: [number, number, number] = [100, 116, 139];

  let y = 16;
  if (d.business) {
    doc.setFont(font('bold'), 'normal'); doc.setFontSize(14); doc.setTextColor(...ink);
    doc.text(d.business, M, y); y += 7;
  }
  doc.setFont(font(d.business ? 'semibold' : 'bold'), 'normal'); doc.setFontSize(d.business ? 11.5 : 14); doc.setTextColor(...ink);
  doc.text(d.title, M, y); y += 5.5;
  doc.setFont(font('regular'), 'normal'); doc.setFontSize(8.5); doc.setTextColor(...muted);
  if (d.subtitle) { doc.text(d.subtitle, M, y); y += 4.5; }
  doc.text(`Printed ${printedAt()}`, M, y); y += 4;
  doc.setDrawColor(226, 232, 240); doc.line(M, y, W - M, y); y += 5;

  d.tables.forEach(t => {
    if (t.heading) {
      doc.setFont(font('semibold'), 'normal'); doc.setFontSize(10); doc.setTextColor(...ink);
      doc.text(t.heading, M, y + 1); y += 4;
    }
    const tot = totalsFor(t);
    const columnStyles: Record<number, any> = {};
    t.columns.forEach((c, i) => { if (c.money || c.total || c.align === 'right') columnStyles[i] = { halign: 'right' }; });
    // Dates ("22 Nov 2026") and invoice numbers stay on one line.
    t.columns.forEach((c, i) => { if (/^(date|invoice|bill|no\.?)$/i.test(c.header.trim())) columnStyles[i] = { ...columnStyles[i], minCellWidth: 24 }; });
    (autoTable as any)(doc, {
      startY: y,
      margin: { left: M, right: M },
      head: [t.columns.map(c => c.header)],
      body: t.rows.length
        ? t.rows.map(r => t.columns.map(c => show(c, c.value(r))))
        : [[{ content: 'Nothing in this period.', colSpan: t.columns.length, styles: { textColor: muted } }]],
      foot: tot ? [tot.map((v, i) => (typeof v === 'number' ? show({ ...t.columns[i], money: t.columns[i].money }, v) : (v ?? '')))] : undefined,
      showFoot: 'lastPage',
      theme: 'plain',
      styles: { font: font('regular'), fontStyle: 'normal', fontSize: 8.5, cellPadding: { top: 2.2, bottom: 2.2, left: 2, right: 2 }, textColor: [51, 65, 85], lineColor: [226, 232, 240], lineWidth: { bottom: 0.2 } },
      headStyles: { font: font('semibold'), fontStyle: 'normal', fontSize: 8, textColor: muted, fillColor: [248, 250, 252], lineWidth: { bottom: 0.3 } },
      footStyles: { font: font('bold'), fontStyle: 'normal', fontSize: 8.8, textColor: ink, fillColor: [241, 245, 249], lineWidth: { top: 0.3 } },
      columnStyles,
      didParseCell: (data: any) => {
        if ((data.section === 'head' || data.section === 'foot') && columnStyles[data.column.index]) data.cell.styles.halign = 'right';
        if (data.section === 'body' && t.strong && t.rows[data.row.index] && t.strong(t.rows[data.row.index])) {
          data.cell.styles.font = font('bold');
          data.cell.styles.textColor = ink;
        }
      },
    });
    y = doc.lastAutoTable.finalY + 8;
  });

  if (d.notes?.length) {
    doc.setFont(font('regular'), 'normal'); doc.setFontSize(8.5); doc.setTextColor(...muted);
    d.notes.forEach(n => {
      const lines = doc.splitTextToSize(n, W - 2 * M);
      if (y + lines.length * 4.2 > doc.internal.pageSize.getHeight() - 14) { doc.addPage(); y = 16; }
      doc.text(lines, M, y); y += lines.length * 4.2 + 1.5;
    });
  }

  const pages = doc.getNumberOfPages();
  const H = doc.internal.pageSize.getHeight();
  for (let i = 1; i <= pages; i++) {
    doc.setPage(i);
    doc.setFont(font('regular'), 'normal'); doc.setFontSize(7.5); doc.setTextColor(148, 163, 184);
    doc.text(`${d.business ? d.business + ' · ' : ''}${d.title}`, M, H - 8);
    doc.text(`Page ${i} of ${pages}`, W - M, H - 8, { align: 'right' });
  }
  doc.save(`${d.name}.pdf`);
}

function download(content: BlobPart, filename: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// One-table exports, used by every list's Export button.
export interface ExportMeta { business?: string; subtitle?: string; }

export const exportExcel = <T,>(columns: ExportColumn<T>[], rows: T[], name: string, title?: string, meta?: ExportMeta) =>
  exportReport('xlsx', { name, title: title ?? name, ...meta, tables: [{ columns, rows }] });
export const exportCSV = <T,>(columns: ExportColumn<T>[], rows: T[], name: string, title?: string, meta?: ExportMeta) =>
  exportReport('csv', { name, title: title ?? name, ...meta, tables: [{ columns, rows }] });
export const exportPDF = <T,>(columns: ExportColumn<T>[], rows: T[], name: string, title?: string, meta?: ExportMeta) =>
  exportReport('pdf', { name, title: title ?? name, ...meta, tables: [{ columns, rows }] });
