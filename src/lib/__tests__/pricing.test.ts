import { priceListFor, listPrice, resolvePriceLocal, discountAmount } from '../pricing';
import { Customer, CustomerType, PriceListItem } from '../api';

// Mirrors resolve_price() in migration 0025 — kept in sync by hand, so any
// drift between the preview shown here and what create_sale actually
// charges should show up as a failing test on one side or the other.

const wholesale: CustomerType = { id: 'ct-wholesale', name: 'Wholesale', price_list_id: 'list-wholesale' };
const retail: CustomerType = { id: 'ct-retail', name: 'Retail' }; // no list of its own

const items: PriceListItem[] = [
  { id: '1', price_list_id: 'list-wholesale', finished_good_id: 'soap', min_qty: 1, price: 80 },
  { id: '2', price_list_id: 'list-wholesale', finished_good_id: 'soap', min_qty: 10, price: 70 },
  { id: '3', price_list_id: 'list-default', finished_good_id: 'soap', min_qty: 1, price: 95 },
];

const customers: Customer[] = [
  { id: 'cust-wholesale', first_name: 'Wholesale Buyer', last_name: null, company_store: null, address: null, phone: null, email: null, customer_type_id: 'ct-wholesale', last_reminded_at: null },
  { id: 'cust-retail', first_name: 'Retail Buyer', last_name: null, company_store: null, address: null, phone: null, email: null, customer_type_id: 'ct-retail', last_reminded_at: null },
  { id: 'cust-own-list', first_name: 'VIP', last_name: null, company_store: null, address: null, phone: null, email: null, customer_type_id: 'ct-retail', last_reminded_at: null, price_list_id: 'list-wholesale' },
];

const ctx = { priceListItems: items, defaultListId: 'list-default', customers, customerTypes: [wholesale, retail] };

describe('priceListFor', () => {
  it('uses the customer type\'s list when the customer has none of their own', () => {
    expect(priceListFor('cust-wholesale', ctx)).toBe('list-wholesale');
  });
  it('falls back to the company default when the type has no list either', () => {
    expect(priceListFor('cust-retail', ctx)).toBe('list-default');
  });
  it('prefers the customer\'s own list over their type\'s', () => {
    expect(priceListFor('cust-own-list', ctx)).toBe('list-wholesale');
  });
  it('gives a walk-in the company default', () => {
    expect(priceListFor(null, ctx)).toBe('list-default');
    expect(priceListFor(undefined, ctx)).toBe('list-default');
  });
});

describe('listPrice', () => {
  it('picks the plain price at low quantities', () => {
    expect(listPrice('soap', 1, 'list-wholesale', items, 999)).toBe(80);
  });
  it('picks the quantity-break price once the threshold is reached', () => {
    expect(listPrice('soap', 10, 'list-wholesale', items, 999)).toBe(70);
    expect(listPrice('soap', 9, 'list-wholesale', items, 999)).toBe(80);
  });
  it('falls back when there is no list at all', () => {
    expect(listPrice('soap', 1, null, items, 100)).toBe(100);
  });
  it('falls back when the list has nothing for this product', () => {
    expect(listPrice('lotion', 1, 'list-wholesale', items, 55)).toBe(55);
  });
});

describe('resolvePriceLocal', () => {
  it('resolves the full chain: customer -> type -> default -> selling price', () => {
    expect(resolvePriceLocal('soap', 1, 'cust-wholesale', ctx, 100)).toBe(80);
    expect(resolvePriceLocal('soap', 10, 'cust-wholesale', ctx, 100)).toBe(70);
    expect(resolvePriceLocal('soap', 1, 'cust-retail', ctx, 100)).toBe(95);
    expect(resolvePriceLocal('soap', 1, null, ctx, 100)).toBe(95);
  });
  it('falls back to the plain selling price with no lists configured at all', () => {
    const empty = { priceListItems: [], defaultListId: null, customers: [], customerTypes: [] };
    expect(resolvePriceLocal('soap', 1, null, empty, 60)).toBe(60);
  });
});

describe('discountAmount', () => {
  it('counts charging less than list as a discount', () => {
    expect(discountAmount(80, 50, 2)).toBe(60);
  });
  it('never counts charging more as a negative discount', () => {
    expect(discountAmount(80, 100, 2)).toBe(0);
  });
  it('is zero when charged exactly matches list', () => {
    expect(discountAmount(80, 80, 5)).toBe(0);
  });
});
