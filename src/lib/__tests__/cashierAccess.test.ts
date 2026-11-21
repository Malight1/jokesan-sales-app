import { canAccess, homeFor } from '../permissions';

describe('cashier (till only)', () => {
  it('can open the till and their own profile', () => {
    expect(canAccess('cashier', '/pos')).toBe(true);
    expect(canAccess('cashier', '/profile')).toBe(true);
  });

  it('cannot open anything else', () => {
    for (const path of ['/dashboard', '/sales', '/customers', '/quotes', '/finished-goods', '/reports', '/settings', '/match-payment', '/assistant', '/stock-alerts']) {
      expect(canAccess('cashier', path)).toBe(false);
    }
  });

  it('lands on the till; everyone else on the dashboard', () => {
    expect(homeFor('cashier')).toBe('/pos');
    expect(homeFor('sales')).toBe('/dashboard');
    expect(homeFor('admin')).toBe('/dashboard');
  });

  it('leaves the sales role exactly as it was', () => {
    expect(canAccess('sales', '/sales')).toBe(true);
    expect(canAccess('sales', '/customers')).toBe(true);
  });
});
