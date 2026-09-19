import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight } from 'lucide-react';
import ScreenshotFrame from '../ScreenshotFrame';

type Category = { title: string; blurb: string; img: string; items: string[]; spotlight?: boolean };

// Everything here is checked against HANDOVER.md's migration table — nothing
// aspirational, only what's actually shipped.
const CATEGORIES: Category[] = [
  {
    title: 'Sell & get paid',
    blurb: 'Everything that happens at the till or on an invoice.',
    img: '/screenshots/pos.png',
    items: [
      'Point of sale that works with no signal — queues offline, syncs for real',
      'WhatsApp invoices and debtor reminders, no app for the customer',
      'Quotes and proforma invoices, one click to a real sale',
      'Price lists, quantity breaks, manager-PIN discount limits',
      'Paystack pay links — a transfer confirms itself',
      'Partial returns, credit notes, store credit',
      'Shifts & cash-up — X/Z reports, blind close counts',
      'Delivery notes and waybills, generated from a sale',
    ],
  },
  {
    title: 'Know your real profit',
    blurb: 'Costed from what a sale actually consumed, not an average.',
    img: '/screenshots/reports.png',
    items: [
      'FIFO costing, tracked layer by layer to the sale',
      'Product profitability & discount reports, costed from the actual batch',
      'A dashboard shaped differently for cashier, storekeeper and owner',
    ],
  },
  {
    title: 'Run inventory & production',
    blurb: 'From raw material to finished good, with a real audit trail.',
    img: '/screenshots/batches.png',
    items: [
      'Branches with separate stock, transfers that preserve cost',
      'Batch numbers, expiry dates, NAFDAC-shaped labels, FEFO picking, recall trace',
      'Units of measure — buy by the carton, sell by the piece, scan and get 12',
      'Barcode labels, printed in one click',
      'Reorder suggestions from real usage statistics — every number checkable',
    ],
  },
  {
    title: 'Purchasing',
    blurb: 'Order stock, receive it, or send it back — all tracked.',
    img: '/screenshots/purchases.png',
    items: [
      'Quick purchase for a supplier who delivers on the spot',
      'Real purchase orders — nothing owed until goods arrive',
      'Supplier returns, drawn from the exact batch',
    ],
  },
  {
    title: 'Compliance & control',
    blurb: 'The database enforces this, not just the menu.',
    img: '/screenshots/audit.png',
    items: [
      'VAT built in',
      'Live e-invoicing (NRS) readiness score with a fix-it checklist',
      'Full audit log — who changed what, and what it was before',
      'Four real roles, enforced by the database itself',
      'Custom fields — add what your business actually needs',
    ],
  },
  {
    title: 'Ask StockFlow',
    blurb: 'The spotlight — genuinely novel in this market.',
    img: '/screenshots/assistant.png',
    items: [
      "A chat built into the app that checks today's real numbers, stock and reorder suggestions for the person asking",
      "Scoped to exactly what the asking person's role can see — the database is still the only real security boundary",
    ],
    spotlight: true,
  },
];

export default function Product() {
  return (
    <div className="mkt-product">
      <section className="mkt-section mkt-section--intro">
        <span className="mkt-eyebrow">The full tour</span>
        <h1>Everything StockFlow actually does.</h1>
        <p>No feature here is aspirational — this is what's live in the product today, organized the way you'd actually use it.</p>
      </section>

      {CATEGORIES.map((c, i) => (
        <section key={c.title} className={`mkt-product-row ${i % 2 === 1 ? 'mkt-product-row--reverse' : ''} ${c.spotlight ? 'mkt-product-row--spotlight' : ''}`}>
          <div className="mkt-product-row__copy">
            <span className="mkt-eyebrow">{c.blurb}</span>
            <h2>{c.title}</h2>
            <ul>
              {c.items.map(it => <li key={it}>{it}</li>)}
            </ul>
          </div>
          <ScreenshotFrame src={c.img} alt={c.title} />
        </section>
      ))}

      <section className="mkt-final-cta">
        <h2>See it on your own numbers.</h2>
        <p>Start free for 14 days. No card required.</p>
        <Link to="/login?signup=1" className="btn-primary btn-lg">Start free trial <ArrowRight size={16} /></Link>
      </section>
    </div>
  );
}
