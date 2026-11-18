// Pure: line items -> daily aggregate rows -> size-bounded, dictionary-encoded month data.
import type { CostBasis } from '../../../src/core/types';
import type { LineItem } from './columns';
import { daysInMonth } from './paths';

/** Synthetic resource id that small resources are folded into, so that totals still reconcile. */
export const OTHER_RESOURCES = '(other resources)';
/** Share of each group's cost whose resources are kept individually. */
export const KEEP_SHARE = 0.995;
/** Most distinct resources kept per month. */
export const MAX_RESOURCES = 5000;

export interface AggRow {
  /** YYYY-MM-DD */
  day: string;
  account: string;
  product: string;
  usageType: string;
  operation: string;
  region: string;
  /** '' = the line had no resource id */
  resource: string;
  cost: number;
  usage: number;
}

const DIMS = ['account', 'product', 'usageType', 'operation', 'region', 'resource'] as const;
export type StoredDim = (typeof DIMS)[number];

/** A month as stored on disk and held in memory: string tables + one integer per row and dimension. */
export interface MonthData {
  v: 1;
  /** YYYY-MM */
  month: string;
  basis: CostBasis;
  /** product code -> product name, for service resolution */
  productNames: Record<string, string>;
  dict: Record<StoredDim, string[]>;
  /** day of month (1-31) per row */
  day: number[];
  cols: Record<StoredDim, number[]>;
  cost: number[];
  usage: number[];
}

class Interner {
  readonly values: string[] = [];
  private readonly ids = new Map<string, number>();
  id(v: string): number {
    let i = this.ids.get(v);
    if (i === undefined) {
      i = this.values.length;
      this.values.push(v);
      this.ids.set(v, i);
    }
    return i;
  }
}

/**
 * Collects the line items of one billing month into (day, account, product, usage type, operation,
 * region, resource) totals. Memory grows with the number of distinct combinations, not with the
 * number of report lines (hourly lines collapse into days).
 */
export class MonthAggregator {
  private readonly interners: Record<StoredDim, Interner> = {
    account: new Interner(),
    product: new Interner(),
    usageType: new Interner(),
    operation: new Interner(),
    region: new Interner(),
    resource: new Interner(),
  };
  private readonly cells = new Map<string, { cost: number; usage: number }>();
  private readonly names: Record<string, string> = {};
  private readonly first: string;
  private readonly last: string;
  /** lines added */
  lines = 0;
  total = 0;

  constructor(readonly month: string) {
    this.first = `${month}-01`;
    this.last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`;
  }

  add(item: LineItem): void {
    // A few lines of a bill carry a usage date outside the billing month (late-arriving usage, fees).
    // They are booked on the nearest day of the month so that the month's files hold the whole month's bill.
    const day = item.day < this.first ? this.first : item.day > this.last ? this.last : item.day;
    // Cost Explorer reports tax as its own service
    const tax = item.lineItemType.toLowerCase() === 'tax';
    const product = tax ? 'Tax' : item.productCode;
    if (tax) this.names.Tax = 'Tax';
    else if (item.productName && !this.names[product]) this.names[product] = item.productName;
    const i = this.interners;
    const key = `${Number(day.slice(8, 10))}|${i.account.id(item.account)}|${i.product.id(product)}|${i.usageType.id(item.usageType)}|${i.operation.id(item.operation)}|${i.region.id(item.region)}|${i.resource.id(item.resourceId)}`;
    const cell = this.cells.get(key);
    if (cell) {
      cell.cost += item.cost;
      cell.usage += item.usage;
    } else this.cells.set(key, { cost: item.cost, usage: item.usage });
    this.lines++;
    this.total += item.cost;
  }

  get size(): number {
    return this.cells.size;
  }

  rows(): AggRow[] {
    const i = this.interners;
    const out: AggRow[] = [];
    for (const [key, cell] of this.cells) {
      const p = key.split('|').map(Number);
      out.push({
        day: `${this.month}-${String(p[0]).padStart(2, '0')}`,
        account: i.account.values[p[1]],
        product: i.product.values[p[2]],
        usageType: i.usageType.values[p[3]],
        operation: i.operation.values[p[4]],
        region: i.region.values[p[5]],
        resource: i.resource.values[p[6]],
        cost: cell.cost,
        usage: cell.usage,
      });
    }
    return out;
  }

  productNames(): Record<string, string> {
    return { ...this.names };
  }
}

const SEP = '\u0001';

/**
 * Bound the number of resources: within each (account, product, usage type, region) keep the resources
 * that make up the top `keepShare` of that group's cost, then keep at most `maxResources` resources
 * overall (largest first). Everything else is folded into OTHER_RESOURCES. Rows without a resource id
 * are untouched. The total cost and usage are unchanged.
 */
export function foldResources(rows: AggRow[], opts: { keepShare?: number; maxResources?: number } = {}): AggRow[] {
  const keepShare = opts.keepShare ?? KEEP_SHARE;
  const maxResources = opts.maxResources ?? MAX_RESOURCES;
  const groupOf = (r: AggRow) => `${r.account}${SEP}${r.product}${SEP}${r.usageType}${SEP}${r.region}`;

  // 1. per group: resource -> |cost|
  const groups = new Map<string, Map<string, number>>();
  for (const r of rows) {
    if (!r.resource) continue;
    const g = groupOf(r);
    let m = groups.get(g);
    if (!m) groups.set(g, (m = new Map()));
    m.set(r.resource, (m.get(r.resource) ?? 0) + Math.abs(r.cost));
  }
  /** `${group}${SEP}${resource}` of the pairs kept after step 1 */
  const kept = new Set<string>();
  const weight = new Map<string, number>();
  for (const [g, m] of groups) {
    const sorted = [...m].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    const total = sorted.reduce((a, [, c]) => a + c, 0);
    if (total <= 0) continue; // nothing in the group costs anything: no resource is worth keeping
    const target = total * keepShare;
    let cum = 0;
    for (const [resource, c] of sorted) {
      if (cum >= target || c <= 0) break;
      kept.add(`${g}${SEP}${resource}`);
      weight.set(resource, (weight.get(resource) ?? 0) + c);
      cum += c;
    }
  }

  // 2. overall cap
  let allowed: Set<string> | null = null;
  if (weight.size > maxResources) {
    allowed = new Set(
      [...weight]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, Math.max(0, maxResources))
        .map(([resource]) => resource),
    );
  }

  // 3. fold and merge
  const out = new Map<string, AggRow>();
  for (const r of rows) {
    let resource = r.resource;
    if (resource && (!kept.has(`${groupOf(r)}${SEP}${resource}`) || (allowed && !allowed.has(resource)))) resource = OTHER_RESOURCES;
    const key = `${r.day}${SEP}${r.account}${SEP}${r.product}${SEP}${r.usageType}${SEP}${r.operation}${SEP}${r.region}${SEP}${resource}`;
    const cur = out.get(key);
    if (cur) {
      cur.cost += r.cost;
      cur.usage += r.usage;
    } else out.set(key, { ...r, resource });
  }
  return [...out.values()];
}

/** Dictionary-encode rows of one month. Rows are ordered by day so that range scans and gzip both do well. */
export function encodeMonth(month: string, basis: CostBasis, rows: AggRow[], productNames: Record<string, string> = {}): MonthData {
  const interners = Object.fromEntries(DIMS.map((d) => [d, new Interner()])) as Record<StoredDim, Interner>;
  const sorted = [...rows].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  const data: MonthData = {
    v: 1,
    month,
    basis,
    productNames: {},
    dict: { account: [], product: [], usageType: [], operation: [], region: [], resource: [] },
    day: [],
    cols: { account: [], product: [], usageType: [], operation: [], region: [], resource: [] },
    cost: [],
    usage: [],
  };
  for (const r of sorted) {
    if (r.cost === 0 && r.usage === 0) continue;
    data.day.push(Number(r.day.slice(8, 10)));
    for (const d of DIMS) data.cols[d].push(interners[d].id(r[d]));
    data.cost.push(r.cost);
    data.usage.push(r.usage);
  }
  for (const d of DIMS) data.dict[d] = interners[d].values;
  for (const code of data.dict.product) if (productNames[code]) data.productNames[code] = productNames[code];
  return data;
}

export const monthTotal = (data: Pick<MonthData, 'cost'>): number => data.cost.reduce((a, c) => a + c, 0);

/** Structural check of a month file read back from disk. */
export function isMonthData(x: unknown): x is MonthData {
  const d = x as MonthData | null;
  if (!d || typeof d !== 'object' || d.v !== 1 || typeof d.month !== 'string' || !d.dict || !d.cols) return false;
  if (!Array.isArray(d.day) || !Array.isArray(d.cost) || !Array.isArray(d.usage)) return false;
  const n = d.day.length;
  if (d.cost.length !== n || d.usage.length !== n) return false;
  return DIMS.every((k) => Array.isArray(d.dict[k]) && Array.isArray(d.cols[k]) && d.cols[k].length === n);
}

export { DIMS as STORED_DIMS };
