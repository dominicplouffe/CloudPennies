import type { Settings, Snapshot } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { stripRegion } from '../catalog';
import { addDays, dateRange, diffDays } from '../util';

export interface Leaf {
  service: string;
  usageType: string;
  /** region-stripped usage type */
  u: string;
  /** aligned with ctx.dates */
  cost: Float64Array;
  usage: Float64Array;
  cost30: number;
  prev30: number;
  usage30: number;
}

/** Pre-digested view of the snapshot shared by all analyzers */
export interface Ctx {
  snap: Snapshot;
  settings: Settings;
  /** contiguous daily dates covered by the 90-day series, ending at dataThrough */
  dates: string[];
  n: number;
  leaves: Leaf[];
  /** total daily cost aligned with dates */
  total: Float64Array;
  last30: number;
  /** sum of cost over the last 30 days for leaves matching */
  find(service: RegExp | null, usage: RegExp): { cost: number; prev: number; usage: number; leaves: Leaf[] };
}

export function buildContext(snap: Snapshot, settings: Settings = DEFAULT_SETTINGS): Ctx {
  const end = addDays(snap.meta.dataThrough, 1);
  let first = end;
  for (const r of snap.dailyByServiceUsage) if (r.date < first) first = r.date;
  if (diffDays(end, first) > 92) first = addDays(end, -92);
  const dates = dateRange(first, end);
  const n = dates.length;
  const idx = new Map(dates.map((d, i) => [d, i]));
  const byKey = new Map<string, Leaf>();
  const total = new Float64Array(n);
  for (const r of snap.dailyByServiceUsage) {
    const i = idx.get(r.date);
    if (i === undefined) continue;
    const [service, usageType] = r.keys;
    const k = service + '\u0001' + usageType;
    let leaf = byKey.get(k);
    if (!leaf) {
      leaf = { service, usageType, u: stripRegion(usageType ?? ''), cost: new Float64Array(n), usage: new Float64Array(n), cost30: 0, prev30: 0, usage30: 0 };
      byKey.set(k, leaf);
    }
    leaf.cost[i] += r.cost;
    leaf.usage[i] += r.usage ?? 0;
    total[i] += r.cost;
  }
  const leaves = [...byKey.values()];
  for (const l of leaves) {
    for (let i = Math.max(0, n - 30); i < n; i++) {
      l.cost30 += l.cost[i];
      l.usage30 += l.usage[i];
    }
    for (let i = Math.max(0, n - 60); i < n - 30; i++) l.prev30 += l.cost[i];
  }
  let last30 = 0;
  for (let i = Math.max(0, n - 30); i < n; i++) last30 += total[i];
  return {
    snap,
    settings,
    dates,
    n,
    leaves,
    total,
    last30,
    find(service, usage) {
      const ls = leaves.filter((l) => (!service || service.test(l.service)) && usage.test(l.u));
      return {
        cost: ls.reduce((a, l) => a + l.cost30, 0),
        prev: ls.reduce((a, l) => a + l.prev30, 0),
        usage: ls.reduce((a, l) => a + l.usage30, 0),
        leaves: ls,
      };
    },
  };
}
