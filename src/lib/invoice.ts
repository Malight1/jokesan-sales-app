import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';

// NOTE: jsPDF's built-in fonts cannot render the ₦ glyph, so PDFs
// use "NGN"; WhatsApp text messages use ₦ freely.
const money = (n: number) => 'NGN ' + (n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 });

export interface InvoiceData {
  companyName: string;
  invoiceNo: string;
  date: string;
  customerName: string;
  customerPhone?: string | null;
  customerAddress?: string | null;
  items: { name: string; qty: number; unitPrice: number; amount: number }[];
  total: number;
  paid: number;
  balance: number;
}

export function generateInvoicePdf(d: InvoiceData) {
  const doc = new jsPDF();
  const pageW = doc.internal.pageSize.getWidth();

  // Header
  doc.setFontSize(19);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text(d.companyName, 14, 20);

  doc.setFontSize(22);
  doc.setTextColor(37, 99, 235);
  doc.text('INVOICE', pageW - 14, 20, { align: 'right' });

  doc.setDrawColor(226, 232, 240);
  doc.setLineWidth(0.5);
  doc.line(14, 26, pageW - 14, 26);

  // Meta (right)
  doc.setFontSize(10);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  doc.text(`Invoice No: ${d.invoiceNo}`, pageW - 14, 34, { align: 'right' });
  doc.text(`Date: ${d.date}`, pageW - 14, 40, { align: 'right' });

  const status = d.balance <= 0 ? 'PAID' : d.paid > 0 ? 'PART PAYMENT' : 'UNPAID';
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(d.balance <= 0 ? 22 : 220, d.balance <= 0 ? 163 : 38, d.balance <= 0 ? 74 : 38);
  doc.text(status, pageW - 14, 46, { align: 'right' });

  // Bill to (left)
  doc.setFontSize(9);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(148, 163, 184);
  doc.text('BILL TO', 14, 34);
  doc.setFontSize(11);
  doc.setFont('helvetica', 'bold');
  doc.setTextColor(30, 41, 59);
  doc.text(d.customerName, 14, 40);
  doc.setFontSize(9);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(100, 116, 139);
  let y = 45;
  if (d.customerPhone) { doc.text(d.customerPhone, 14, y); y += 5; }
  if (d.customerAddress) { doc.text(d.customerAddress, 14, y); y += 5; }

  // Items
  autoTable(doc, {
    startY: Math.max(y + 6, 56),
    head: [['Item', 'Qty', 'Unit Price', 'Amount']],
    body: d.items.map(i => [i.name, i.qty.toLocaleString(), money(i.unitPrice), money(i.amount)]),
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [37, 99, 235] },
    alternateRowStyles: { fillColor: [248, 250, 252] },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } },
  });

  // Totals
  const afterTable = (doc as any).lastAutoTable.finalY + 8;
  const rows: [string, string, boolean][] = [
    ['Total', money(d.total), false],
    ['Amount Paid', money(d.paid), false],
    ['Balance Due', money(d.balance), true],
  ];
  let ty = afterTable;
  rows.forEach(([label, value, strong]) => {
    doc.setFontSize(strong ? 12 : 10);
    doc.setFont('helvetica', strong ? 'bold' : 'normal');
    doc.setTextColor(strong && d.balance > 0 ? 220 : 30, strong && d.balance > 0 ? 38 : 41, strong && d.balance > 0 ? 38 : 59);
    doc.text(label, pageW - 70, ty);
    doc.text(value, pageW - 14, ty, { align: 'right' });
    ty += strong ? 8 : 6;
  });

  // Footer
  doc.setFontSize(8);
  doc.setFont('helvetica', 'normal');
  doc.setTextColor(148, 163, 184);
  doc.text('Generated with StockFlow — stockflow.africa', pageW / 2, doc.internal.pageSize.getHeight() - 10, { align: 'center' });

  doc.save(`${d.invoiceNo}.pdf`);
}

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
