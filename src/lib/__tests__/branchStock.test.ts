import { qtyByProduct, lowStockRows, decrementAt } from '../branchStock';
import { StockLevel } from '../api';

const row = (branch: string, product: string, name: string, qty: number, min = 5): StockLevel => ({
  branch_id: branch, branch_name: branch.toUpperCase(), product_kind: 'finished_good',
  product_id: product, name, unit: 'pcs', qty, min_level: min,
});

const levels: StockLevel[] = [
  row('lagos', 'soap', 'Soap', 25),
  row('abuja', 'soap', 'Soap', 15),
  row('lagos', 'lotion', 'Lotion', 0),
  row('abuja', 'lotion', 'Lotion', 3),
];

describe('qtyByProduct', () => {
  it('reads one branch only', () => {
    const m = qtyByProduct(levels, 'abuja');
    expect(m.get('soap')).toBe(15);
    expect(m.get('lotion')).toBe(3);
  });

  it('sums across every branch when no branch is given', () => {
    expect(qtyByProduct(levels).get('soap')).toBe(40);
  });

  it('treats an item a branch has never held as absent, not an error', () => {
    expect(qtyByProduct(levels, 'kano').get('soap')).toBeUndefined();
  });

  it('copes with numeric strings from Postgres', () => {
    const m = qtyByProduct([{ ...row('lagos', 'soap', 'Soap', 0), qty: '12.5' as unknown as number }], 'lagos');
    expect(m.get('soap')).toBe(12.5);
  });
});

describe('lowStockRows', () => {
  it('lists only rows at or below their reorder level, out-of-stock first', () => {
    const low = lowStockRows(levels);
    expect(low.map(l => `${l.branch_id}:${l.product_id}`)).toEqual(['lagos:lotion', 'abuja:lotion']);
  });

  it('counts sitting exactly on the reorder level as low', () => {
    expect(lowStockRows([row('lagos', 'soap', 'Soap', 5, 5)])).toHaveLength(1);
  });
});

describe('sellable stock (migration 0022)', () => {
  // 25 on the shelf at Lagos, but 20 of them expired or on hold.
  const mixed: StockLevel[] = [{ ...row('lagos', 'soap', 'Soap', 25, 10), sellable_qty: 5 }];

  it('counts on-hand and sellable separately', () => {
    expect(qtyByProduct(mixed, 'lagos').get('soap')).toBe(25);
    expect(qtyByProduct(mixed, 'lagos', 'sellable').get('soap')).toBe(5);
  });

  it('treats a shelf of expired stock as low (or out), not healthy', () => {
    expect(lowStockRows(mixed)).toHaveLength(1);
    expect(lowStockRows([{ ...mixed[0], sellable_qty: 0 }])[0].product_id).toBe('soap');
  });

  it('falls back to on-hand for rows cached before the migration', () => {
    expect(qtyByProduct([row('lagos', 'soap', 'Soap', 12)], 'lagos', 'sellable').get('soap')).toBe(12);
  });

  it('an offline sale takes from sellable stock too', () => {
    const after = decrementAt(mixed, 'lagos', [{ productId: 'soap', qty: 3 }]);
    expect(after[0].qty).toBe(22);
    expect(after[0].sellable_qty).toBe(2);
  });
});

describe('decrementAt', () => {
  it('only touches the branch the sale happened at', () => {
    const after = decrementAt(levels, 'abuja', [{ productId: 'soap', qty: 4 }]);
    expect(qtyByProduct(after, 'abuja').get('soap')).toBe(11);
    expect(qtyByProduct(after, 'lagos').get('soap')).toBe(25);
  });

  it('adds up repeated cart lines for the same product', () => {
    const after = decrementAt(levels, 'lagos', [{ productId: 'soap', qty: 2 }, { productId: 'soap', qty: 3 }]);
    expect(qtyByProduct(after, 'lagos').get('soap')).toBe(20);
  });

  it('never shows negative stock', () => {
    const after = decrementAt(levels, 'abuja', [{ productId: 'lotion', qty: 99 }]);
    expect(qtyByProduct(after, 'abuja').get('lotion')).toBe(0);
  });

  it('does not mutate the rows it was given', () => {
    decrementAt(levels, 'lagos', [{ productId: 'soap', qty: 1 }]);
    expect(levels[0].qty).toBe(25);
  });
});
