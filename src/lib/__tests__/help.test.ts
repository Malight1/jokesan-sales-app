import { helpFor, tourKey } from '../help';
import { readHelp, writeHelp, markSeen } from '../helpState';

describe('in-app help', () => {
  it('has help for the main pages and shares one entry across report pages', () => {
    for (const p of ['/dashboard', '/pos', '/sales', '/customers', '/purchases', '/money', '/expenses', '/reports', '/settings', '/profile']) {
      expect(helpFor(p, true)).not.toBeNull();
    }
    expect(helpFor('/reports/pnl', true)?.title).toBe('This report');
    expect(helpFor('/money/statements/abc', true)?.title).toBe('Checking a statement');
    expect(helpFor('/no-such-page', true)).toBeNull();
    expect(tourKey('/reports/balance')).toBe('/reports/*');
  });

  it('calls the product page Finished Goods for manufacturers', () => {
    expect(helpFor('/finished-goods', true)?.title).toBe('Products');
    expect(helpFor('/finished-goods', false)?.title).toBe('Finished Goods');
  });

  it('remembers seen tips per person, and the switch', () => {
    localStorage.clear();
    expect(readHelp('u1')).toEqual({ off: false, seen: [], checklistHidden: false });
    markSeen('u1', '/pos');
    markSeen('u1', '/pos');
    writeHelp('u1', { off: true });
    expect(readHelp('u1')).toEqual({ off: true, seen: ['/pos'], checklistHidden: false });
    expect(readHelp('u2').seen).toEqual([]);
  });
});
