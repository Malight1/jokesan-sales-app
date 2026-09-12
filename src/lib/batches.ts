// Date helpers for batch numbers, manufacture and expiry dates (migration
// 0022). Kept pure so labels, alerts and the batch list agree on what
// "expired" means — and so it can be tested without a database.
//
// Dates are ISO calendar days ('2026-09-12') and are compared as local
// calendar days, never as UTC instants: a batch that expires "today"
// must not flip to expired at 1am because of a timezone.

export type ExpiryState = 'none' | 'ok' | 'soon' | 'expired';

const pad = (n: number) => String(n).padStart(2, '0');

export function toIso(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIso(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}

export function todayIso(now: Date = new Date()): string {
  return toIso(now);
}

export function addDays(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setDate(d.getDate() + days);
  return toIso(d);
}

/** Whole days from today until the date (negative once it has passed). */
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
  if (!iso) return null;
  const ms = parseIso(iso).getTime() - parseIso(toIso(now)).getTime();
  return Math.round(ms / 86_400_000);
}

/** The expiry day itself is still sellable — the server agrees (0022). */
export function expiryState(iso: string | null | undefined, warningDays: number, now: Date = new Date()): ExpiryState {
  const d = daysUntil(iso, now);
  if (d === null) return 'none';
  if (d < 0) return 'expired';
  if (d <= warningDays) return 'soon';
  return 'ok';
}

export function expiryLabel(iso: string | null | undefined, now: Date = new Date()): string {
  const d = daysUntil(iso, now);
  if (d === null) return 'No expiry';
  if (d < -1) return `Expired ${-d} days ago`;
  if (d === -1) return 'Expired yesterday';
  if (d === 0) return 'Expires today';
  if (d === 1) return 'Expires tomorrow';
  if (d <= 60) return `Expires in ${d} days`;
  return `Expires ${longDate(iso!)}`;
}

export function longDate(iso: string): string {
  return parseIso(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** NAFDAC label format: MM/YYYY. */
export function labelMonth(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = parseIso(iso);
  return `${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
}

export const BATCH_STATUS: Record<string, string> = {
  available: 'Available',
  quarantine: 'On hold',
  recalled: 'Recalled',
};

/**
 * Reads the dates people actually type into spreadsheets: 2027-03-31,
 * 31/03/2027, 31-03-27, 03/2027 (an expiry month means its last day), or an
 * Excel serial number. Day-first, as Nigerians write dates. Returns null for
 * anything it can't read rather than guessing.
 */
export function parseDateLoose(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date && !isNaN(v.getTime())) return toIso(v);
  if (typeof v === 'number' && isFinite(v)) {
    if (v < 20000 || v > 80000) return null; // not a plausible Excel date
    const d = new Date(Math.round((v - 25569) * 86_400_000));
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return valid(+m[1], +m[2], +m[3]);
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return valid(y, +m[2], +m[1]);
  }
  m = s.match(/^(\d{1,2})[/.-](\d{4})$/);
  if (m) {
    const y = +m[2], mo = +m[1];
    if (mo < 1 || mo > 12) return null;
    return valid(y, mo, new Date(y, mo, 0).getDate());
  }
  if (/^\d+(\.\d+)?$/.test(s)) return parseDateLoose(Number(s));
  return null;
}

function valid(y: number, m: number, d: number): string | null {
  const dt = new Date(y, m - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return toIso(dt);
}
