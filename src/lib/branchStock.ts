import { StockLevel } from './api';

// Helpers over stock_levels() rows (migrations 0020/0022). Kept pure so the
// POS, the stock pages and the notification bell all read branch stock the
// same way — and so it can be unit-tested without a database.

/** What can be sold from a row: expired/held stock excluded. Rows cached
 *  before migration 0022 have no sellable_qty, so fall back to on-hand. */
export function sellable(l: StockLevel): number {
  return Number(l.sellable_qty ?? l.qty ?? 0);
}

/** Quantity per product, for one branch (or summed across all when branchId is empty). */
export function qtyByProduct(
  levels: StockLevel[] | null | undefined,
  branchId?: string | null,
  measure: 'qty' | 'sellable' = 'qty',
): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of levels ?? []) {
    if (branchId && l.branch_id !== branchId) continue;
    const q = measure === 'sellable' ? sellable(l) : Number(l.qty || 0);
    out.set(l.product_id, (out.get(l.product_id) ?? 0) + q);
  }
  return out;
}

/** Rows at or below their reorder level — out-of-stock first, then the
 *  emptiest. Judged on sellable stock: a shelf of expired soap is empty. */
export function lowStockRows(levels: StockLevel[] | null | undefined): StockLevel[] {
  return (levels ?? [])
    .filter(l => sellable(l) <= Number(l.min_level))
    .sort((a, b) => {
      const outA = sellable(a) <= 0 ? 0 : 1;
      const outB = sellable(b) <= 0 ? 0 : 1;
      if (outA !== outB) return outA - outB;
      if (sellable(a) !== sellable(b)) return sellable(a) - sellable(b);
      return a.name.localeCompare(b.name);
    });
}

/**
 * Take sold quantities off one branch's rows without a round-trip — used when
 * the till is offline, so the same last unit can't be sold twice before the
 * queued sale syncs. Never goes below zero.
 */
export function decrementAt(
  levels: StockLevel[] | null | undefined,
  branchId: string | null | undefined,
  lines: { productId: string; qty: number }[],
): StockLevel[] {
  const take = new Map<string, number>();
  for (const l of lines) take.set(l.productId, (take.get(l.productId) ?? 0) + l.qty);
  return (levels ?? []).map(l => {
    if (branchId && l.branch_id !== branchId) return l;
    const t = take.get(l.product_id);
    if (!t) return l;
    const next: StockLevel = { ...l, qty: Math.max(0, Number(l.qty) - t) };
    if (l.sellable_qty !== undefined) next.sellable_qty = Math.max(0, Number(l.sellable_qty) - t);
    return next;
  });
}
