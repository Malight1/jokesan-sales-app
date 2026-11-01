import { Tenant } from './AuthContext';
import { effectivePlan } from './features';

// Mirrors public.tenant_is_live() from migration 0052. The database is the
// authority — this exists so the UI can explain what's happening instead of
// letting every save fail with a raw Postgres error.
//
// A suspended account is READ-ONLY rather than locked out: people can still
// see and export their own records, they just can't add more. Locking a
// business out of its own books is how you earn a chargeback.
//
// An ended trial or a lapsed plan is not read-only any more: the business
// drops to Free and the owner keeps selling. Free is owner-only, so other
// staff can look but not save until the business upgrades.
export type AccountState =
  | { live: true; notice?: string }
  | { live: false; reason: 'suspended' | 'staff_on_free'; message: string };

export function accountState(tenant: Tenant | null, role?: string | null): AccountState {
  if (!tenant) return { live: true }; // nothing loaded yet — don't cry wolf

  if (tenant.is_active === false) {
    return {
      live: false,
      reason: 'suspended',
      message: 'This account has been suspended. You can still view and export your records, but nothing new can be saved. Please get in touch with support.',
    };
  }

  if (effectivePlan(tenant) !== 'free') return { live: true };

  if (role && role !== 'admin') {
    return {
      live: false,
      reason: 'staff_on_free',
      message: 'This business is on the Free plan, which is for the owner only. You can look but not save until the owner upgrades.',
    };
  }
  const why = tenant.plan === 'trial' ? 'Your free trial has ended, so you' : tenant.plan === 'free' ? 'You' : 'Your subscription has lapsed, so you';
  return {
    live: true,
    notice: `${why} are on the Free plan: the owner only, 1 branch, 50 products and 100 sales a month. Upgrade to Growth to add staff, debt reminders and expiry tracking.`,
  };
}
