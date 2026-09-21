import { accountState } from '../accountState';
import { Tenant } from '../AuthContext';

const base: Tenant = {
  id: 't1', name: 'Acme', type: 'single', business_type: 'manufacturing', plan: 'growth', currency: 'NGN',
  logo_url: null, vat_enabled: false, vat_rate: 0, tin: null,
  trial_ends_at: null, plan_expires_at: null, is_active: true,
};

const days = (n: number) => new Date(Date.now() + n * 86400000).toISOString();

describe('accountState', () => {
  it('treats a healthy paid tenant as live', () => {
    expect(accountState(base).live).toBe(true);
  });

  it('does not cry wolf before the tenant has loaded', () => {
    expect(accountState(null).live).toBe(true);
  });

  it('flags a tenant the platform owner suspended', () => {
    const r = accountState({ ...base, is_active: false });
    expect(r.live).toBe(false);
    if (!r.live) expect(r.reason).toBe('suspended');
  });

  it('flags an expired trial', () => {
    const r = accountState({ ...base, plan: 'trial', trial_ends_at: days(-1) });
    expect(r.live).toBe(false);
    if (!r.live) expect(r.reason).toBe('trial_expired');
  });

  it('leaves a trial that still has time on it alone', () => {
    expect(accountState({ ...base, plan: 'trial', trial_ends_at: days(3) }).live).toBe(true);
  });

  it('flags a lapsed subscription', () => {
    const r = accountState({ ...base, plan_expires_at: days(-1) });
    expect(r.live).toBe(false);
    if (!r.live) expect(r.reason).toBe('plan_expired');
  });

  it('leaves a subscription that renews later alone', () => {
    expect(accountState({ ...base, plan_expires_at: days(20) }).live).toBe(true);
  });

  it('reports suspension ahead of expiry when both apply', () => {
    // Suspension is the actionable one — it needs a support conversation,
    // not a card.
    const r = accountState({ ...base, is_active: false, plan_expires_at: days(-5) });
    if (!r.live) expect(r.reason).toBe('suspended');
  });

  it('never leaves the reason without a message the user can act on', () => {
    const r = accountState({ ...base, is_active: false });
    if (!r.live) expect(r.message.length).toBeGreaterThan(20);
  });
});
