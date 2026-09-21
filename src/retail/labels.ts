// ============================================================
// StockFlow — retail vocabulary.
//
// A shop owner buys and sells "products," not "finished goods" made from
// "raw materials." The machine-level identifiers (finished_good, material,
// the database columns, the RPC names) stay exactly as they are everywhere
// in the app — only the ~40 user-visible strings change, and only for a
// retail tenant. Every call site imports from here instead of hardcoding
// a ternary, so the vocabulary lives in one place.
// ============================================================

import type { Tenant } from '../lib/AuthContext';

export function isRetail(tenant?: Pick<Tenant, 'business_type'> | null): boolean {
  return tenant?.business_type === 'retail';
}

// label(retail, 'Finished Goods', 'Products') at each call site — explicit
// about both words at the point of use, rather than a dictionary lookup
// that hides what's being swapped.
export function label(retail: boolean, manufacturing: string, retailText: string): string {
  return retail ? retailText : manufacturing;
}
