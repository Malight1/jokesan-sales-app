import { StockLevel } from './api';

// Helpers over stock_levels() rows (migration 0020). Kept pure so the POS,
// the stock pages and the notification bell all read branch stock the same
// way — and so it can be unit-tested without a database.

/** Quantity per product, for one branch (or summed across all when branchId is empty). */
export function qtyByProduct(levels: StockLevel[] | null | undefined, branchId?: string | null): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of levels ?? []) {
    if (branchId && l.branch_id !== branchId) continue;
    out.set(l.product_id, (out.get(l.product_id) ?? 0) + Number(l.qty || 0));
  }
  return out;
}

/** Rows at or below their reorder level — out-of-stock first, then the emptiest. */
export function lowStockRows(levels: StockLevel[] | null | undefined): StockLevel[] {
  return (levels ?? [])
    .filter(l => Number(l.qty) <= Number(l.min_level))
    .sort((a, b) => {
      const outA = Number(a.qty) <= 0 ? 0 : 1;
      const outB = Number(b.qty) <= 0 ? 0 : 1;
      if (outA !== outB) return outA - outB;
      if (Number(a.qty) !== Number(b.qty)) return Number(a.qty) - Number(b.qty);
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
    return { ...l, qty: Math.max(0, Number(l.qty) - t) };
  });
}
