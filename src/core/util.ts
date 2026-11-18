// Small date / math / formatting helpers. All dates are UTC ISO strings (YYYY-MM-DD).

const DAY = 86_400_000;

export const toIso = (d: Date) => d.toISOString().slice(0, 10);
export const parseIso = (s: string) => new Date(s.slice(0, 10) + 'T00:00:00Z');
export const addDays = (iso: string, n: number) => toIso(new Date(parseIso(iso).getTime() + n * DAY));
export const diffDays = (a: string, b: string) => Math.round((parseIso(a).getTime() - parseIso(b).getTime()) / DAY);
export const monthStart = (iso: string) => iso.slice(0, 7) + '-01';
export const addMonths = (iso: string, n: number) => {
  const d = parseIso(iso);
  return toIso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
};
export const daysInMonth = (iso: string) => {
  const d = parseIso(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
};
export const todayIso = () => toIso(new Date());

export function dateRange(start: string, endExclusive: string): string[] {
  const out: string[] = [];
  for (let d = start; d < endExclusive; d = addDays(d, 1)) out.push(d);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (iso: string) => MONTHS[parseIso(iso).getUTCMonth()];
export const monthShort = (iso: string) => monthName(iso).slice(0, 3);
export const fmtDate = (iso: string) => `${monthShort(iso)} ${parseIso(iso).getUTCDate()}`;
export const fmtDateLong = (iso: string) => `${monthShort(iso)} ${parseIso(iso).getUTCDate()}, ${parseIso(iso).getUTCFullYear()}`;

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: number[]) => (xs.length ? sum(xs) / xs.length : 0);
export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/** median absolute deviation */
export function mad(xs: number[], med = median(xs)): number {
  return median(xs.map((x) => Math.abs(x - med)));
}
export const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export function groupSum<T>(items: T[], key: (t: T) => string, val: (t: T) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + val(it));
  }
  return m;
}

/** $1,234 · $12.3K · $1.2M — compact money for headlines */
export function money(n: number, opts: { compact?: boolean; cents?: boolean; sign?: boolean } = {}): string {
  const neg = n < 0;
  const a = Math.abs(n);
  let s: string;
  if (opts.compact && a >= 1_000_000) s = (a / 1_000_000).toFixed(a >= 10_000_000 ? 1 : 2) + 'M';
  else if (opts.compact && a >= 10_000) s = (a / 1000).toFixed(a >= 100_000 ? 0 : 1) + 'K';
  else if (opts.cents || (a < 10 && a > 0 && opts.cents !== false))
    s = a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  else s = Math.round(a).toLocaleString('en-US');
  const prefix = neg ? '−' : opts.sign ? '+' : '';
  return `${prefix}$${s}`;
}

export function pct(n: number, digits = 0, sign = false): string {
  if (!isFinite(n)) return '—';
  const s = Math.abs(n).toFixed(digits);
  return `${n < 0 ? '−' : sign ? '+' : ''}${s}%`;
}

export const pctChange = (cur: number, prev: number) => (prev > 0.005 ? ((cur - prev) / prev) * 100 : cur > 0.005 ? Infinity : 0);

export function bytes(n: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${u[i]}`;
}

/** deterministic PRNG (mulberry32) */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

export function joinList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  if (xs.length === 2) return `${xs[0]} and ${xs[1]}`;
  return `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`;
}
