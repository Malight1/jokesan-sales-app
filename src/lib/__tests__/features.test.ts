import { hasFeature, planFor, isPriority } from '../features';

// Must agree with plan_level()/feature_level() in migration 0021 — the
// database refuses the write either way; this decides what the UI offers.
describe('plan features', () => {
  it('keeps batch and expiry tracking off Starter', () => {
    expect(hasFeature('starter', 'batch_tracking')).toBe(false);
  });

  it('turns batch tracking on from Growth up', () => {
    expect(hasFeature('growth', 'batch_tracking')).toBe(true);
    expect(hasFeature('business', 'batch_tracking')).toBe(true);
    expect(hasFeature('enterprise', 'batch_tracking')).toBe(true);
  });

  it('gives a trial everything, so people can try it all', () => {
    expect(hasFeature('trial', 'batch_tracking')).toBe(true);
    expect(hasFeature('trial', 'auto_payments')).toBe(true);
  });

  it('keeps Business features off Growth', () => {
    expect(hasFeature('growth', 'auto_payments')).toBe(false);
    expect(hasFeature('business', 'auto_payments')).toBe(true);
  });

  it('treats an unknown or missing plan as Starter', () => {
    expect(hasFeature(undefined, 'batch_tracking')).toBe(false);
    expect(hasFeature('mystery', 'batch_tracking')).toBe(false);
  });

  it('names the cheapest plan that includes a feature', () => {
    expect(planFor('batch_tracking')).toBe('Growth');
    expect(planFor('einvoicing')).toBe('Business');
  });

  it('puts the assistant on Growth and up, not Starter (0050)', () => {
    expect(hasFeature('starter', 'assistant')).toBe(false);
    expect(hasFeature('growth', 'assistant')).toBe(true);
    expect(planFor('assistant')).toBe('Growth');
  });

  it('gives Business and Enterprise priority support only', () => {
    expect(isPriority('business')).toBe(true);
    expect(isPriority('enterprise')).toBe(true);
    expect(isPriority('growth')).toBe(false);
    expect(isPriority('trial')).toBe(false);
    expect(isPriority(undefined)).toBe(false);
  });
});
