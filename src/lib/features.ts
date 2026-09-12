// Which plan unlocks which feature. Mirrors plan_level()/feature_level() in
// migration 0021 — the database is the authority and refuses the write
// anyway; this lets the UI show "upgrade" instead of a broken button.

export type Feature =
  | 'batch_tracking'
  | 'price_tiers'
  | 'quotes'
  | 'units'
  | 'deliveries'
  | 'purchase_orders'
  | 'smart_reorder'
  | 'auto_payments'
  | 'einvoicing'
  | 'assistant'
  | 'custom_fields';

const PLAN_LEVEL: Record<string, number> = {
  starter: 1,
  growth: 2,
  business: 3,
  enterprise: 4,
  trial: 3, // a trial gets everything so people can try it
};

const FEATURE_LEVEL: Record<Feature, number> = {
  batch_tracking: 2,
  price_tiers: 2,
  quotes: 2,
  units: 2,
  deliveries: 2,
  purchase_orders: 2,
  smart_reorder: 2,
  auto_payments: 3,
  einvoicing: 3,
  assistant: 3,
  custom_fields: 3,
};

export function hasFeature(plan: string | null | undefined, feature: Feature): boolean {
  return (PLAN_LEVEL[plan ?? ''] ?? 1) >= FEATURE_LEVEL[feature];
}

/** The cheapest plan that includes a feature, by the name customers see. */
export function planFor(feature: Feature): 'Starter' | 'Growth' | 'Business' {
  const lvl = FEATURE_LEVEL[feature];
  return lvl >= 3 ? 'Business' : lvl === 2 ? 'Growth' : 'Starter';
}
