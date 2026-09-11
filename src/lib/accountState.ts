import { Tenant } from './AuthContext';

// Mirrors public.tenant_is_live() from migration 0017. The database is the
// authority — this exists so the UI can explain what's happening instead of
// letting every save fail with a raw Postgres error.
//
// Suspended and expired accounts are deliberately READ-ONLY rather than
// locked out: people can still see and export their own records, they just
// can't add more. Locking a business out of its own books over a billing
// lapse is how you earn a chargeback.
export type AccountState =
  | { live: true }
  | { live: false; reason: 'suspended' | 'trial_expired' | 'plan_expired'; message: string };

export function accountState(tenant: Tenant | null): AccountState {
  if (!tenant) return { live: true }; // nothing loaded yet — don't cry wolf

  if (tenant.is_active === false) {
    return {
      live: false,
      reason: 'suspended',
      message: 'This account has been suspended. You can still view and export your records, but nothing new can be saved. Please get in touch with support.',
    };
  }

  const now = Date.now();
  if (tenant.plan === 'trial' && tenant.trial_ends_at && new Date(tenant.trial_ends_at).getTime() <= now) {
    return {
      live: false,
      reason: 'trial_expired',
      message: 'Your free trial has ended. Your data is safe and still readable — choose a plan to start saving again.',
    };
  }

  if (tenant.plan_expires_at && new Date(tenant.plan_expires_at).getTime() <= now) {
    return {
      live: false,
      reason: 'plan_expired',
      message: 'Your subscription has lapsed. Your data is safe and still readable — renew to start saving again.',
    };
  }

  return { live: true };
}
