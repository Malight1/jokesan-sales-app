import {
  addDays, daysUntil, expiryState, expiryLabel, labelMonth, parseDateLoose, todayIso,
} from '../batches';

// A fixed "today": 12 September 2026, local time.
const now = new Date(2026, 8, 12, 9, 30);

describe('expiry maths', () => {
  it('counts whole calendar days, whatever the time of day', () => {
    expect(daysUntil('2026-09-12', now)).toBe(0);
    expect(daysUntil('2026-09-11', now)).toBe(-1);
    expect(daysUntil('2026-10-12', now)).toBe(30);
    expect(daysUntil('2026-09-12', new Date(2026, 8, 12, 23, 59))).toBe(0);
  });

  it('agrees with the server: the expiry day itself is still sellable', () => {
    expect(expiryState('2026-09-12', 60, now)).toBe('soon');
    expect(expiryState('2026-09-11', 60, now)).toBe('expired');
  });

  it('flags a batch inside the warning window, not before', () => {
    expect(expiryState('2026-11-11', 60, now)).toBe('soon');
    expect(expiryState('2026-11-12', 60, now)).toBe('ok');
    expect(expiryState(null, 60, now)).toBe('none');
  });

  it('describes expiry in words a storekeeper would use', () => {
    expect(expiryLabel('2026-09-09', now)).toBe('Expired 3 days ago');
    expect(expiryLabel('2026-09-11', now)).toBe('Expired yesterday');
    expect(expiryLabel('2026-09-12', now)).toBe('Expires today');
    expect(expiryLabel('2026-09-13', now)).toBe('Expires tomorrow');
    expect(expiryLabel('2026-10-02', now)).toBe('Expires in 20 days');
    expect(expiryLabel(null, now)).toBe('No expiry');
  });

  it('adds days across month and leap-year ends', () => {
    expect(addDays('2026-09-12', 365)).toBe('2027-09-12');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(todayIso(now)).toBe('2026-09-12');
  });

  it('prints label dates as MM/YYYY, the way NAFDAC asks', () => {
    expect(labelMonth('2027-03-31')).toBe('03/2027');
    expect(labelMonth(null)).toBe('');
  });
});

describe('parseDateLoose (spreadsheet dates)', () => {
  it('reads ISO dates', () => {
    expect(parseDateLoose('2027-03-31')).toBe('2027-03-31');
    expect(parseDateLoose('2027-3-5')).toBe('2027-03-05');
  });

  it('reads day-first dates, as they are written in Nigeria', () => {
    expect(parseDateLoose('31/03/2027')).toBe('2027-03-31');
    expect(parseDateLoose('05.03.2027')).toBe('2027-03-05');
    expect(parseDateLoose('31-03-27')).toBe('2027-03-31');
  });

  it('reads an expiry month as the last day of that month', () => {
    expect(parseDateLoose('03/2027')).toBe('2027-03-31');
    expect(parseDateLoose('02/2028')).toBe('2028-02-29');
  });

  it('reads Excel date serials', () => {
    expect(parseDateLoose(46477)).toBe('2027-03-31');
    expect(parseDateLoose('46477')).toBe('2027-03-31');
  });

  it('refuses to guess at anything it cannot read', () => {
    expect(parseDateLoose('31/02/2027')).toBeNull();
    expect(parseDateLoose('13/2027')).toBeNull();
    expect(parseDateLoose('soon')).toBeNull();
    expect(parseDateLoose('')).toBeNull();
    expect(parseDateLoose(7)).toBeNull();
  });
});
