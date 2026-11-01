// Which plan unlocks which feature. Mirrors plan_level()/feature_level() in
// migration 0052 — the database is the authority and refuses the write
// anyway; this lets the UI show "upgrade" instead of a broken button.
import type { Tenant } from './AuthContext';

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
  | 'debt_reminders'
  | 'custom_fields';

const PLAN_LEVEL: Record<string, number> = {
  free: 1,
  starter: 1, // legacy, moved to Growth by 0052
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
  assistant: 2,
  debt_reminders: 2,
  auto_payments: 3,
  einvoicing: 3,
  custom_fields: 3,
};

type PlanTenant = Pick<Tenant, 'plan' | 'trial_ends_at' | 'plan_expires_at'>;

/**
 * The plan a business is really on right now. Mirrors effective_plan() in
 * 0052: once a trial ends or a paid period runs out, it's on Free until
 * it pays again.
 */
export function effectivePlan(tenant: PlanTenant | null | undefined): string {
  if (!tenant) return 'free';
  const now = Date.now();
  const past = (iso: string | null) => !!iso && new Date(iso).getTime() <= now;
  if (tenant.plan === 'trial' && past(tenant.trial_ends_at)) return 'free';
  if (tenant.plan !== 'trial' && tenant.plan !== 'free' && past(tenant.plan_expires_at)) return 'free';
  return tenant.plan;
}

/** Pass the tenant (preferred, so a lapsed plan counts as Free) or a plan id. */
export function hasFeature(planOrTenant: PlanTenant | string | null | undefined, feature: Feature): boolean {
  const plan = typeof planOrTenant === 'object' && planOrTenant !== null ? effectivePlan(planOrTenant) : planOrTenant;
  return (PLAN_LEVEL[plan ?? ''] ?? 1) >= FEATURE_LEVEL[feature];
}

/** The cheapest plan that includes a feature, by the name customers see. */
export function planFor(feature: Feature): 'Growth' | 'Business' {
  return FEATURE_LEVEL[feature] >= 3 ? 'Business' : 'Growth';
}

/** Plans whose support tickets are answered first (platform_tickets() sorts them up). */
export function isPriority(plan: string | null | undefined): boolean {
  return plan === 'business' || plan === 'enterprise';
}
