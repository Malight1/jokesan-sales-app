// Client-side mirror of resolve_price() (migration 0025) — used to show a
// live price as a cart is built. The database is still the authority:
// create_sale re-resolves the price itself and never trusts what the app
// sends as "the list price," only the unit_price actually charged.
import { Customer, CustomerType, PriceListItem } from './api';

export interface PriceContext {
  priceListItems: PriceListItem[];
  defaultListId: string | null;   // the one price_lists row with is_default && is_active
  customers: Customer[];
  customerTypes: CustomerType[];
}

/** Which price list applies to this customer: their own, then their type's, then the company default. */
export function priceListFor(customerId: string | null | undefined, ctx: PriceContext): string | null {
  if (customerId) {
    const c = ctx.customers.find(x => x.id === customerId);
    if (c?.price_list_id) return c.price_list_id;
    const type = ctx.customerTypes.find(t => t.id === c?.customer_type_id);
    if (type?.price_list_id) return type.price_list_id;
  }
  return ctx.defaultListId;
}

/** The list price for a quantity: the largest min_qty at or below qty wins. */
export function listPrice(fgId: string, qty: number, listId: string | null, items: PriceListItem[], fallback: number): number {
  if (!listId) return fallback;
  const rows = items.filter(i => i.price_list_id === listId && i.finished_good_id === fgId && i.min_qty <= qty);
  if (rows.length === 0) return fallback;
  return rows.reduce((best, r) => (r.min_qty > best.min_qty ? r : best)).price;
}

/** Full resolution: customer/type/default list, then the quantity break within it. */
export function resolvePriceLocal(fgId: string, qty: number, customerId: string | null | undefined, ctx: PriceContext, fallback: number): number {
  const list = priceListFor(customerId, ctx);
  return listPrice(fgId, qty, list, ctx.priceListItems, fallback);
}

/** Charging less than list is a discount; charging more is a price-up (not counted), matching create_sale. */
export function discountAmount(listPriceEach: number, unitPrice: number, qty: number): number {
  return Math.max((listPriceEach - unitPrice) * qty, 0);
}
