// jsbarcode + jsPDF load on demand — label printing is a rare, deliberate action.

export interface LabelItem {
  name: string;
  barcode: string;
  priceLabel?: string; // e.g. "₦2,400" — shown under the barcode
}

// Renders a Code128 barcode to a data URL via an offscreen canvas.
// Takes JsBarcode as an argument so it stays synchronous inside the layout
// loop — the module itself is loaded once by printBarcodeLabels.
function barcodeDataUrl(JsBarcode: (el: HTMLCanvasElement, text: string, opts: object) => void, code: string): string {
  const canvas = document.createElement('canvas');
  JsBarcode(canvas, code, { format: 'CODE128', width: 2, height: 40, displayValue: true, fontSize: 12, margin: 4 });
  return canvas.toDataURL('image/png');
}

// Prints a sheet of small barcode labels (3 per row) — for sticking on
// shelves/products so the phone camera can scan them at the counter.
export async function printBarcodeLabels(items: LabelItem[], title = 'Barcode Labels') {
  const [{ default: jsPDF }, { default: JsBarcode }] = await Promise.all([
    import('jspdf'),
    import('jsbarcode'),
  ]);
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 10;
  const cols = 3;
  const cellW = (pageW - margin * 2) / cols;
  const cellH = 30;
  let x = margin, y = margin;
  let col = 0;

  doc.setFontSize(10);
  doc.setTextColor(148, 163, 184);
  doc.text(title, margin, 6);

  items.forEach((item) => {
    if (y + cellH > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      x = margin; y = margin; col = 0;
    }
    doc.setDrawColor(226, 232, 240);
    doc.rect(x, y, cellW - 3, cellH - 3);

    doc.setFontSize(8);
    doc.setTextColor(30, 41, 59);
    const nameLines = doc.splitTextToSize(item.name, cellW - 8);
    doc.text(nameLines.slice(0, 1), x + 2, y + 5);

    try {
      const img = barcodeDataUrl(JsBarcode, item.barcode);
      doc.addImage(img, 'PNG', x + 2, y + 7, cellW - 8, 14);
    } catch {
      doc.setFontSize(7);
      doc.text(item.barcode, x + 2, y + 14);
    }

    if (item.priceLabel) {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text(item.priceLabel, x + 2, y + cellH - 5);
      doc.setFont('helvetica', 'normal');
    }

    col++;
    if (col >= cols) { col = 0; x = margin; y += cellH; }
    else { x += cellW; }
  });

  doc.save('barcode-labels.pdf');
}

// Generates a random, tenant-scoped-unique-enough EAN-like code for
// products that don't already have a real manufacturer barcode.
export function generateBarcode(): string {
  const digits = Array.from({ length: 12 }, () => Math.floor(Math.random() * 10)).join('');
  return digits;
}
