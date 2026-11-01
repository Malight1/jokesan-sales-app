import React from 'react';
import { Check, Minus } from 'lucide-react';
import { PLANS } from '../lib/api';
import { hasFeature, isPriority, Feature } from '../lib/features';

type Plan = (typeof PLANS)[number];
type Cell = boolean | string;
interface Row { label: string; cell: (p: Plan) => Cell }
interface Group { title: string; rows: Row[] }

const money = (n: number) => '₦' + n.toLocaleString();

// Whether a plan includes a feature comes from features.ts, the same table
// the app uses to show its upgrade prompts, so this can't drift from it.
const feature = (label: string, f: Feature): Row => ({ label, cell: p => hasFeature(p.id, f) });
const everyPlan = (label: string): Row => ({ label, cell: () => true });

// Mirrors plan_branch_limit(), plan_product_limit() and
// plan_monthly_sales_limit() in the database.
const BRANCHES: Record<string, string> = { free: '1', growth: 'Up to 3', business: 'Unlimited' };
const PRODUCTS: Record<string, string> = { free: 'Up to 50', growth: 'Unlimited', business: 'Unlimited' };
const SALES: Record<string, string> = { free: '100 a month', growth: 'Unlimited', business: 'Unlimited' };
const ASSISTANT: Record<string, string> = { growth: '20 questions a month', business: '100 questions a month' };

const GROUPS: Group[] = [
  {
    title: 'Size',
    rows: [
      { label: 'Staff logins', cell: p => String(p.users) },
      { label: 'Branches', cell: p => BRANCHES[p.id] },
      { label: 'Products', cell: p => PRODUCTS[p.id] },
      { label: 'Sales', cell: p => SALES[p.id] },
    ],
  },
  {
    title: 'Selling and profit',
    rows: [
      everyPlan('Point of sale that works with no network'),
      everyPlan('Real profit from FIFO costing'),
      everyPlan('WhatsApp receipts'),
      everyPlan('Till receipts for 58mm and 80mm printers'),
      feature('WhatsApp debt reminders', 'debt_reminders'),
      everyPlan('Import products from Excel or CSV'),
      everyPlan('VAT'),
      feature('Price lists, quantity breaks and discount limits', 'price_tiers'),
      feature('Quotes and proforma invoices', 'quotes'),
      feature('Delivery notes and waybills', 'deliveries'),
    ],
  },
  {
    title: 'Stock and buying',
    rows: [
      feature('Batch numbers and expiry dates (NAFDAC)', 'batch_tracking'),
      feature('Purchase orders: order now, receive later', 'purchase_orders'),
      feature('Units of measure: cartons, drums, pieces', 'units'),
      feature('Smart reorder suggestions', 'smart_reorder'),
    ],
  },
  {
    title: 'Automation and control',
    rows: [
      { label: 'Ask ProfixBook (ask your business a question)', cell: p => hasFeature(p.id, 'assistant') ? (ASSISTANT[p.id] ?? true) : false },
      feature('Paystack payments confirm themselves', 'auto_payments'),
      feature('Custom fields', 'custom_fields'),
      feature('E-invoicing readiness score', 'einvoicing'),
      { label: 'Priority support', cell: p => isPriority(p.id) },
    ],
  },
];

function CellView({ value }: { value: Cell }) {
  if (value === true) return <><Check size={16} aria-hidden="true" /><span className="mkt-sr">Included</span></>;
  if (value === false) return <><Minus size={16} aria-hidden="true" /><span className="mkt-sr">Not included</span></>;
  return <>{value}</>;
}

export default function PlanCompare() {
  return (
    <>
    <p className="mkt-compare__hint">Swipe sideways to compare all three plans.</p>
    <div className="mkt-compare" role="region" aria-label="Compare plans" tabIndex={0}>
      <table>
        <caption className="mkt-sr">What each ProfixBook plan includes</caption>
        <thead>
          <tr>
            <th scope="col"><span className="mkt-sr">Feature</span></th>
            {PLANS.map(p => (
              <th scope="col" key={p.id} className={p.id === 'growth' ? 'is-popular' : ''}>
                {p.name}
                <small>{p.price === 0 ? `${money(0)} for ever` : `${money(p.price)} a month`}</small>
              </th>
            ))}
          </tr>
        </thead>
        {GROUPS.map(g => (
          <tbody key={g.title}>
            <tr className="mkt-compare__group"><th scope="colgroup" colSpan={PLANS.length + 1}>{g.title}</th></tr>
            {g.rows.map(r => (
              <tr key={r.label}>
                <th scope="row">{r.label}</th>
                {PLANS.map(p => {
                  const v = r.cell(p);
                  return (
                    <td key={p.id} className={`${p.id === 'growth' ? 'is-popular' : ''}${v === false ? ' is-off' : ''}`}>
                      <CellView value={v} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    </div>
    </>
  );
}
