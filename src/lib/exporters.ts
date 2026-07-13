import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// A column reduced to what export needs: a header + a plain-value accessor.
export interface ExportColumn<T = any> {
  header: string;
  value: (row: T) => string | number;
}

function toObjects<T>(columns: ExportColumn<T>[], rows: T[]) {
  return rows.map(r => {
    const o: Record<string, any> = {};
    columns.forEach(c => { o[c.header] = c.value(r); });
    return o;
  });
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

export function exportExcel<T>(columns: ExportColumn<T>[], rows: T[], name: string) {
  const ws = XLSX.utils.json_to_sheet(toObjects(columns, rows));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
  XLSX.writeFile(wb, `${name}.xlsx`);
}

export function exportCSV<T>(columns: ExportColumn<T>[], rows: T[], name: string) {
  const ws = XLSX.utils.json_to_sheet(toObjects(columns, rows));
  download(XLSX.utils.sheet_to_csv(ws), `${name}.csv`, 'text/csv;charset=utf-8;');
}

export function exportPDF<T>(columns: ExportColumn<T>[], rows: T[], name: string, title?: string) {
  const doc = new jsPDF({ orientation: columns.length > 6 ? 'landscape' : 'portrait' });
  doc.setFontSize(13);
  doc.text(title ?? name, 14, 15);
  doc.setFontSize(9);
  doc.setTextColor(120);
  doc.text(new Date().toLocaleString('en-GB'), 14, 21);
  autoTable(doc, {
    head: [columns.map(c => c.header)],
    body: rows.map(r => columns.map(c => String(c.value(r) ?? ''))),
    startY: 26,
    styles: { fontSize: 8, cellPadding: 2 },
    headStyles: { fillColor: [37, 99, 235] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
  });
  doc.save(`${name}.pdf`);
}
