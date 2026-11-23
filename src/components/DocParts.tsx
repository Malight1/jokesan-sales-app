import React from 'react';
import './DocParts.scss';

// Pieces shared by the Quotes and Sales Orders screens so a quote, a sale
// and their detail views all add up the same way on screen as on the PDF.

export interface DocTotalRow { label: React.ReactNode; value: React.ReactNode; tone?: 'good' | 'bad' | 'muted'; }

/** Right-hand totals: one row per line, the final amount set apart. */
export function DocTotals({ rows, total, after }: {
  rows: (DocTotalRow | false | null | undefined)[];
  total: { label: React.ReactNode; value: React.ReactNode; tone?: 'accent' | 'good' | 'warn' };
  after?: (DocTotalRow | false | null | undefined)[];
}) {
  const line = (r: DocTotalRow, i: number) => (
    <div key={i} className={`dt-row${r.tone ? ` is-${r.tone}` : ''}`}><dt>{r.label}</dt><dd>{r.value}</dd></div>
  );
  return (
    <dl className="doc-totals">
      {rows.filter(Boolean).map((r, i) => line(r as DocTotalRow, i))}
      <div className={`dt-total${total.tone ? ` is-${total.tone}` : ''}`}><dt>{total.label}</dt><dd>{total.value}</dd></div>
      {(after ?? []).filter(Boolean).map((r, i) => line(r as DocTotalRow, 100 + i))}
    </dl>
  );
}

/** A document number in a table that opens the document. */
export function DocLink({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return <button type="button" className="doc-link" onClick={onClick} aria-label={label}>{children}</button>;
}
