import { holdSale, listHeld, removeHeld, restoreLines, heldAgo, heldByLabel, MAX_HELD, HeldLine } from '../heldSales';

const bread = { id: 'bread', name: 'Agege Bread (loaf)' };
const milk = { id: 'milk', name: 'Peak Milk 400g (carton)' };
const coke = { id: 'coke', name: 'Coca-Cola 50cl (crate)' };

const line = (goodId: string, name: string, qty: number, unitPrice: number, extra: Partial<HeldLine> = {}): HeldLine =>
  ({ goodId, name, qty, unitPrice, ...extra });

const basket = (label: string, lines: HeldLine[]) => ({
  customerId: '', label, orderDiscount: 0, lines,
  total: lines.reduce((s, l) => s + l.qty * l.unitPrice, 0),
});

beforeEach(() => localStorage.clear());

describe('held sales', () => {
  it('holds a basket and lists it back, newest first', () => {
    holdSale('t1', 'lagos', basket('Walk-in', [line('bread', bread.name, 2, 1200)]), 1000);
    holdSale('t1', 'lagos', basket('Mama Chidi', [line('milk', milk.name, 1, 18000)]), 2000);
    const list = listHeld('t1', 'lagos');
    expect(list.map(h => h.label)).toEqual(['Mama Chidi', 'Walk-in']);
    expect(list[1].lines[0]).toMatchObject({ goodId: 'bread', qty: 2, unitPrice: 1200 });
  });

  it('keeps each business and branch separate', () => {
    holdSale('t1', 'lagos', basket('Lagos basket', [line('bread', bread.name, 1, 1200)]));
    expect(listHeld('t1', 'abuja')).toEqual([]);
    expect(listHeld('t2', 'lagos')).toEqual([]);
    expect(listHeld(null, 'lagos')).toEqual([]);
  });

  it('removes one held sale without touching the others', () => {
    const [b] = holdSale('t1', null, basket('B', [line('bread', bread.name, 1, 1200)]), 2);
    holdSale('t1', null, basket('A', [line('milk', milk.name, 1, 18000)]), 1);
    const left = removeHeld('t1', null, b.id);
    expect(left.map(h => h.label)).toEqual(['A']);
    expect(listHeld('t1', null)).toHaveLength(1);
  });

  it('caps how many baskets can sit on hold', () => {
    for (let i = 0; i < MAX_HELD + 5; i++) holdSale('t1', null, basket(`#${i}`, [line('bread', bread.name, 1, 1200)]), i);
    const list = listHeld('t1', null);
    expect(list).toHaveLength(MAX_HELD);
    expect(list[0].label).toBe(`#${MAX_HELD + 4}`);
  });

  it('treats unreadable storage as an empty list instead of crashing the till', () => {
    localStorage.setItem('pfb_held_sales:t1:main', '{not json');
    expect(listHeld('t1', null)).toEqual([]);
  });

  it('restores against today\'s stock: drops what is gone, trims what is short, keeps hand prices', () => {
    const stockLeft: Record<string, number> = { bread: 1, milk: 0 };
    const res = restoreLines(
      [
        line('bread', bread.name, 3, 1000, { manual: true, discountReason: 'Regular customer' }),
        line('milk', milk.name, 1, 18000),
        line('gone', 'Imported Wine (pcs)', 1, 12000),
      ],
      [bread, milk, coke],
      g => stockLeft[g.id] ?? 0,
    );
    expect(res.lines).toEqual([{ good: bread, qty: 1, unitPrice: 1000, manual: true, discountReason: 'Regular customer' }]);
    expect(res.reduced).toEqual([bread.name]);
    expect(res.dropped).toEqual([milk.name, 'Imported Wine (pcs)']);
  });

  it('says how long ago a basket was held in plain words', () => {
    const now = 10 * 24 * 3600 * 1000;
    expect(heldAgo(now - 20 * 1000, now)).toBe('just now');
    expect(heldAgo(now - 4 * 60 * 1000, now)).toBe('4 min ago');
    expect(heldAgo(now - 2 * 3600 * 1000, now)).toBe('2 h ago');
    expect(heldAgo(now - 30 * 3600 * 1000, now)).toBe('yesterday');
    expect(heldAgo(now - 3 * 24 * 3600 * 1000, now)).toBe('3 days ago');
  });

  it('names who held a basket, or "you" for the person looking', () => {
    const h = { heldBy: { id: 'u1', name: 'Amaka Obi' } };
    expect(heldByLabel(h, 'u1')).toBe('you');
    expect(heldByLabel(h, 'u2')).toBe('Amaka Obi');
    expect(heldByLabel({}, 'u1')).toBeNull();
  });
});
