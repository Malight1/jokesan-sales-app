import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, TrendingUp, ShieldCheck, Users, Sparkles, Store, Factory } from 'lucide-react';
import ScreenshotFrame from '../ScreenshotFrame';
import Reveal from '../Reveal';
import useMeta from '../useMeta';

// Everything here is a shipped feature, nothing aspirational. Four full
// rows with real screenshots (selling, shops, makers, the owner's view),
// a compact card group for the rest, and the assistant last.
const ROWS: { eyebrow: string; title: string; img: string; w: number; h: number; alt: string; items: string[]; icon?: typeof Store }[] = [
  {
    eyebrow: 'Every business',
    title: 'Sell and get paid',
    img: '/screenshots/pos.webp', w: 1800, h: 1125,
    alt: 'Point of sale with a basket of items, cash, transfer or credit',
    items: [
      'A till that keeps selling with no network, then syncs when it’s back',
      'Tap, scan a barcode or search to add an item. Keyboard shortcuts for busy counters',
      'Cash, transfer or credit, part payments, change worked out for you',
      'WhatsApp invoices and polite debtor reminders, no app needed by the customer',
      'Quotes and proforma invoices that turn into a sale in one click',
      'Price lists, quantity breaks, and manager-PIN limits on discounts',
      'Paystack pay links that confirm themselves when the money lands',
      'Returns, credit notes, shifts and end-of-day cash-up',
    ],
  },
  {
    eyebrow: 'For shops',
    icon: Store,
    title: 'Buy and resell, with your margin in view',
    img: '/screenshots/buy-stock.webp', w: 1800, h: 1125,
    alt: 'Buying stock: last price paid, selling price and margin shown for each item',
    items: [
      'A shop dashboard built around the till: today’s takings, the week, and who owes you',
      'Buy stock from suppliers and see last price paid, selling price and margin before you save',
      'Paid in full, part paid or on credit, and what you still owe each supplier',
      'What’s running out, what hasn’t sold in 30 days, and the cash tied up in stock',
      'Expiry dates for drugs, food and cosmetics, with earliest-expiry-first selling when you switch it on',
      'Return goods to a supplier from the exact delivery they came in',
    ],
  },
  {
    eyebrow: 'For manufacturers',
    icon: Factory,
    title: 'Run production and raw materials',
    img: '/screenshots/storekeeper.webp', w: 1600, h: 922,
    alt: 'Storekeeper view: raw materials and products to reorder or produce, batches expiring',
    items: [
      'Recipes turn raw materials into finished goods, costed layer by layer',
      'Batch numbers, expiry dates, NAFDAC-ready labels and a full recall trace',
      'Order raw materials ahead and receive them in parts as they arrive',
      'Reorder suggestions worked out from real usage and supplier lead times',
      'Buy by the carton or drum, use and sell by the piece or litre',
    ],
  },
];

const CARDS = [
  {
    icon: TrendingUp,
    title: 'Real profit',
    items: [
      'FIFO costing: every sale costed from the exact stock it came from',
      'Profit by product, discounts given, returns, and profit after expenses',
      'Stock valued at what you paid, not just what you’ll sell it for',
    ],
  },
  {
    icon: Users,
    title: 'Branches and staff',
    items: [
      'Separate stock per branch, transfers that keep the original cost',
      'Cashier, storekeeper and accountant logins that only see their own work',
      'Each branch side by side on the owner’s dashboard',
    ],
  },
  {
    icon: ShieldCheck,
    title: 'Compliance and control',
    items: [
      'VAT built in, and an e-invoicing readiness check with a fix-it list',
      'A full audit log: who changed what, and what it was before',
      'Import products and opening stock from Excel or CSV',
    ],
  },
];

const ASK_EXAMPLES = [
  'What’s running low, and what should I reorder first?',
  'How is my profit this month compared to last?',
  'Which products did I give the most discount on?',
  'Who owes me the most right now?',
];

export default function Product() {
  useMeta(
    'Product, ProfixBook',
    'Everything ProfixBook does: offline point of sale, shop and manufacturer modes, FIFO profit, batch and expiry tracking, purchases, branches, and a built-in assistant.'
  );
  return (
    <div className="mkt-product">
      <section className="mkt-section mkt-section--intro">
        <span className="mkt-eyebrow">The full tour</span>
        <h1>Everything ProfixBook does, for shops and for makers.</h1>
        <p>Nothing on this page is “coming soon”. It’s all in the product today.</p>
      </section>

      {ROWS.map((r, i) => (
        <section key={r.title} className={`mkt-product-row ${i % 2 === 1 ? 'mkt-product-row--reverse' : ''}`}>
          <Reveal className="mkt-product-row__copy">
            <span className="mkt-eyebrow">{r.icon && <r.icon size={14} aria-hidden="true" />} {r.eyebrow}</span>
            <h2>{r.title}</h2>
            <ul>
              {r.items.map(it => <li key={it}>{it}</li>)}
            </ul>
          </Reveal>
          <ScreenshotFrame src={r.img} alt={r.alt} width={r.w} height={r.h} />
        </section>
      ))}

      <section className="mkt-section mkt-section--alt">
        <div className="mkt-section__head">
          <h2>And the rest of what runs the business.</h2>
        </div>
        <div className="mkt-cardgrid">
          {CARDS.map(c => (
            <div className="mkt-productcard" key={c.title}>
              <div className="mkt-productcard__icon"><c.icon size={20} aria-hidden="true" /></div>
              <h3>{c.title}</h3>
              <ul>
                {c.items.map(it => <li key={it}>{it}</li>)}
              </ul>
            </div>
          ))}
        </div>
      </section>

      <section className="mkt-section">
        <div className="mkt-ask">
          <div className="mkt-ask__copy">
            <span className="mkt-eyebrow"><Sparkles size={14} aria-hidden="true" /> Ask ProfixBook</span>
            <h2>Ask your business a question in plain English.</h2>
            <p>A chat built into the app that answers from your real numbers. It only sees what the person asking is allowed to see, so a cashier can’t ask their way into your profit.</p>
          </div>
          <ul className="mkt-ask__examples" aria-label="Example questions">
            {ASK_EXAMPLES.map(q => <li key={q}>{q}</li>)}
          </ul>
        </div>
      </section>

      <section className="mkt-final-cta">
        <h2>See it on your own numbers.</h2>
        <p>Free for 14 days. No card required.</p>
        <div className="mkt-final-cta__actions">
          <Link to="/login?signup=1&type=retail" className="btn-primary btn-lg"><Store size={18} aria-hidden="true" /> Start as a shop</Link>
          <Link to="/login?signup=1&type=manufacturing" className="btn-secondary btn-lg mkt-final-cta__alt"><Factory size={18} aria-hidden="true" /> Start as a manufacturer</Link>
        </div>
        <p className="mkt-final-cta__more"><Link to="/pricing">Compare plans <ArrowRight size={14} /></Link></p>
      </section>
    </div>
  );
}
