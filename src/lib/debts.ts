// Due dates and how late a debt is (migration 0062).

const DAY = 86_400_000;
const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const todayIso = () => isoDay(new Date());

/** Whole days between the due date and `asOf` (positive = late). */
export function daysLate(due: string | null | undefined, asOf: string = todayIso()): number {
  if (!due) return 0;
  return Math.round((new Date(asOf + 'T00:00:00').getTime() - new Date(due.slice(0, 10) + 'T00:00:00').getTime()) / DAY);
}

export const AGING = [
  { key: 'current', label: 'Not due yet', test: (d: number) => d <= 0 },
  { key: 'd30', label: '1 to 30 days late', test: (d: number) => d >= 1 && d <= 30 },
  { key: 'd60', label: '31 to 60 days late', test: (d: number) => d >= 31 && d <= 60 },
  { key: 'd90', label: '61 to 90 days late', test: (d: number) => d >= 61 && d <= 90 },
  { key: 'over', label: 'Over 90 days late', test: (d: number) => d > 90 },
] as const;
export type AgingKey = typeof AGING[number]['key'];

export const agingKey = (due: string | null | undefined, asOf?: string): AgingKey =>
  AGING.find(b => b.test(daysLate(due, asOf)))!.key;

const short = (d: string) => new Date(d.slice(0, 10) + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/** "Due 12 Dec", "Due today", "12 days late". */
export function dueText(due: string | null | undefined): { text: string; late: boolean } {
  if (!due) return { text: '', late: false };
  const d = daysLate(due);
  if (d > 0) return { text: `${d} day${d === 1 ? '' : 's'} late`, late: true };
  if (d === 0) return { text: 'Due today', late: false };
  return { text: `Due ${short(due)}`, late: false };
}

/** Add days to an ISO date. */
export const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return isoDay(d);
};
