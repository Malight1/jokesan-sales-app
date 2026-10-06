// Held ("parked") sales at the till. A customer goes to fetch money or one
// more item, the cashier holds their basket, serves the next person, then
// resumes it. Saved in this browser so a refresh or a closed tab doesn't
// lose a basket.
//
// A held sale is NOT a sale. Nothing touches the server until it's resumed
// and charged like any other, so it doesn't reserve stock, issue an invoice
// number or show up in reports. On resume, every line is checked again
// against what the branch has now: products that were deleted or sold out
// are dropped, and quantities are cut down to what's left.
//
// Scoped per business and per branch, so one device signed into two shops
// (or moved to another branch) never resumes the wrong basket. Shared by
// every cashier who signs in on that device (a customer who comes back
// after a shift change can still be served), but each held sale records
// who held it. The sale itself belongs to whoever finally charges it, and
// lands in their shift, because they're the one who took the money.

export interface HeldLine {
  goodId: string;
  name: string;           // kept so a since-deleted product can still be named
  qty: number;
  unitPrice: number;
  manual?: boolean;       // hand-priced by the cashier; kept as is on resume
  discountReason?: string;
}

export interface HeldSale {
  id: string;
  heldAt: number;
  customerId: string;     // '' = walk-in
  label: string;          // customer name or "Walk-in"
  orderDiscount: number;
  lines: HeldLine[];
  total: number;          // at the moment it was held, for the list only
  heldBy?: { id: string; name: string };   // missing on baskets held before this was recorded
}

/** A busy counter rarely parks more than a handful; this stops a forgotten list growing forever. */
export const MAX_HELD = 20;

const keyFor = (tenantId: string, branchId: string | null | undefined) =>
  `pfb_held_sales:${tenantId}:${branchId ?? 'main'}`;

export function listHeld(tenantId: string | null | undefined, branchId: string | null | undefined): HeldSale[] {
  if (!tenantId) return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(keyFor(tenantId, branchId)) ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(h => h && Array.isArray(h.lines)) : [];
  } catch {
    return [];
  }
}

function write(tenantId: string, branchId: string | null | undefined, list: HeldSale[]) {
  try { localStorage.setItem(keyFor(tenantId, branchId), JSON.stringify(list)); }
  catch { /* storage full or blocked: the list just doesn't persist past this page */ }
}

/** Newest first. Returns the updated list. */
export function holdSale(
  tenantId: string, branchId: string | null | undefined,
  sale: Omit<HeldSale, 'id' | 'heldAt'>, now: number = Date.now(),
): HeldSale[] {
  const held: HeldSale = { ...sale, id: `h_${now}_${Math.random().toString(36).slice(2, 7)}`, heldAt: now };
  const next = [held, ...listHeld(tenantId, branchId)].slice(0, MAX_HELD);
  write(tenantId, branchId, next);
  return next;
}

export function removeHeld(tenantId: string, branchId: string | null | undefined, id: string): HeldSale[] {
  const next = listHeld(tenantId, branchId).filter(h => h.id !== id);
  write(tenantId, branchId, next);
  return next;
}

export interface RestoredLine<G> {
  good: G;
  qty: number;
  unitPrice: number;
  manual?: boolean;
  discountReason?: string;
}

export interface Restored<G> {
  lines: RestoredLine<G>[];
  dropped: string[];   // names no longer sellable here (deleted or out of stock)
  reduced: string[];   // names whose quantity was cut to what's left
}

/**
 * Rebuild a held basket against today's products and stock. Prices come
 * back exactly as held; the till re-resolves the ones that weren't
 * hand-priced, the same as when the customer changes.
 */
export function restoreLines<G extends { id: string }>(
  lines: HeldLine[], goods: G[], available: (g: G) => number,
): Restored<G> {
  const out: Restored<G> = { lines: [], dropped: [], reduced: [] };
  for (const l of lines) {
    const good = goods.find(g => g.id === l.goodId);
    const left = good ? available(good) : 0;
    if (!good || left <= 0) { out.dropped.push(l.name); continue; }
    const qty = Math.min(l.qty, left);
    if (qty < l.qty) out.reduced.push(l.name);
    out.lines.push({ good, qty, unitPrice: l.unitPrice, manual: l.manual, discountReason: l.discountReason });
  }
  return out;
}

/** "you", "Amaka", or null when a basket predates this being recorded. */
export function heldByLabel(h: Pick<HeldSale, 'heldBy'>, currentUserId: string | null | undefined): string | null {
  if (!h.heldBy) return null;
  return h.heldBy.id === currentUserId ? 'you' : h.heldBy.name;
}

/** "just now", "4 min ago", "2 h ago", "yesterday". */
export function heldAgo(heldAt: number, now: number = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - heldAt) / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return hours < 48 ? 'yesterday' : `${Math.floor(hours / 24)} days ago`;
}
