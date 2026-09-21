import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, TrendingUp, Truck, ShieldCheck } from 'lucide-react';
import ScreenshotFrame from '../ScreenshotFrame';
import useMeta from '../useMeta';

// Everything here is checked against HANDOVER.md's migration table, nothing
// aspirational, only what's actually shipped. Two full rows with real
// screenshots, one compact card group for the rest, and the AI assistant
// gets its own spotlight, rather than six identical image-and-text rows
// in a line.
const ROWS = [
  {
    title: 'Sell & get paid',
    img: '/screenshots/pos.png',
    items: [
      'Point of sale that works with no signal, queues offline, syncs for real',
      'WhatsApp invoices and debtor reminders, no app for the customer',
      'Quotes and proforma invoices, one click to a real sale',
      'Price lists, quantity breaks, manager-PIN discount limits',
      'Paystack pay links: a transfer confirms itself',
      'Partial returns, credit notes, store credit',
      'Shifts and cash-up, X and Z reports, blind close counts',
      'Delivery notes and waybills, generated from a sale',
    ],
  },
  {
    title: 'Run inventory & production',
    img: '/screenshots/batches.png',
    items: [
      'Branches with separate stock, transfers that preserve cost',
      'Batch numbers, expiry dates, NAFDAC-shaped labels, FEFO picking, recall trace',
      'Units of measure: buy by the carton, sell by the piece',
      'Barcode labels, printed in one click',
      'Reorder suggestions from real usage statistics, every number checkable',
    ],
  },
];

const CARDS = [
  {
    icon: TrendingUp,
    title: 'Know your real profit',
    items: [
      'FIFO costing, tracked layer by layer to the sale',
      'Product profitability and discount reports, costed from the actual batch',
      'A dashboard shaped differently for cashier, storekeeper and owner',
    ],
  },
  {
    icon: Truck,
    title: 'Purchasing',
    items: [
      'Quick purchase for a supplier who delivers on the spot',
      'Real purchase orders: nothing owed until goods arrive',
      'Supplier returns, drawn from the exact batch',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Compliance & control',
    items: [
      'VAT built in, e-invoicing readiness score with a fix-it checklist',
      'Full audit log: who changed what, and what it was before',
      'Four real roles, enforced by the database itself',
    ],
  },
];

export default function Product() {
  useMeta(
    'Product, StockFlow',
    'Every feature StockFlow actually ships: FIFO costing, offline POS, batch and expiry tracking, purchase orders, compliance tools, and an AI assistant.'
  );
  return (
    <div className="mkt-product">
      <section className="mkt-section mkt-section--intro">
        <span className="mkt-eyebrow">The full tour</span>
        <h1>Everything StockFlow actually does.</h1>
        <p>No feature here is aspirational. This is what is live in the product today.</p>
      </section>

      {ROWS.map((r, i) => (
        <section key={r.title} className={`mkt-product-row ${i % 2 === 1 ? 'mkt-product-row--reverse' : ''}`}>
          <div className="mkt-product-row__copy">
            <h2>{r.title}</h2>
            <ul>
              {r.items.map(it => <li key={it}>{it}</li>)}
            </ul>
          </div>
          <ScreenshotFrame src={r.img} alt={r.title} />
        </section>
      ))}

      <section className="mkt-section mkt-section--alt">
        <div className="mkt-section__head">
          <h2>And the rest of what runs the business.</h2>
        </div>
        <div className="mkt-cardgrid">
          {CARDS.map(c => (
            <div className="mkt-productcard" key={c.title}>
              <div className="mkt-productcard__icon"><c.icon size={20} /></div>
              <h3>{c.title}</h3>
              <ul>
                {c.items.map(it => <li key={it}>{it}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mkt-product-row mkt-product-row--spotlight">
        <div className="mkt-product-row__copy">
          <span className="mkt-eyebrow">The spotlight</span>
          <h2>Ask StockFlow</h2>
          <ul>
            <li>A chat built into the app that checks today's real numbers, stock and reorder suggestions for the person asking</li>
            <li>Scoped to exactly what the asking person's role can see. The database is still the only real security boundary</li>
          </ul>
        </div>
        <ScreenshotFrame src="/screenshots/assistant.png" alt="Ask StockFlow" />
      </section>

      <section className="mkt-final-cta">
        <h2>See it on your own numbers.</h2>
        <p>Start free for 14 days. No card required.</p>
        <Link to="/login?signup=1" className="btn-primary btn-lg">Start free trial <ArrowRight size={16} /></Link>
      </section>
    </div>
  );
}
