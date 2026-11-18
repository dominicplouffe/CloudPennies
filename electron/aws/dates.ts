// UTC ISO-date helpers for the collector (kept local so electron/ does not depend on src/core runtime code).

const DAY = 86_400_000;

export const toIso = (d: Date): string => d.toISOString().slice(0, 10);
export const parseIso = (s: string): Date => new Date(s.slice(0, 10) + 'T00:00:00Z');
export const addDays = (iso: string, n: number): string => toIso(new Date(parseIso(iso).getTime() + n * DAY));
export const diffDays = (a: string, b: string): number => Math.round((parseIso(a).getTime() - parseIso(b).getTime()) / DAY);
export const monthStart = (iso: string): string => iso.slice(0, 7) + '-01';
/** first day of the month `n` months away from the month containing `iso` */
export const addMonths = (iso: string, n: number): string => {
  const d = parseIso(iso);
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
};
export const todayIso = (now: Date = new Date()): string => toIso(now);

/** Best-effort conversion of the assorted date strings AWS returns in attribute maps to an ISO date. */
export function toIsoDate(v: string | Date | undefined | null): string | undefined {
  if (!v) return undefined;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? undefined : toIso(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(v);
  if (us) return `${us[3]}-${us[1].padStart(2, '0')}-${us[2].padStart(2, '0')}`;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : toIso(new Date(t));
}

export const num = (v: string | number | undefined | null): number => {
  if (v === undefined || v === null || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};
