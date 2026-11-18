// Pure translation between CloudPennies' CostQuery/CostRow model and Cost Explorer's GetCostAndUsage API.
import { createHash } from 'node:crypto';
import type {
  Expression,
  GetCostAndUsageCommandInput,
  GetCostAndUsageCommandOutput,
  GroupDefinition,
} from '@aws-sdk/client-cost-explorer';
import type { CostBasis, CostQuery, CostRow, Dim } from '../../src/core/types';
import { addDays } from './dates';

export const HOUR_MS = 3_600_000;
export const QUERY_TTL_MS = 6 * HOUR_MS;
export const SETTLED_TTL_MS = 7 * 24 * HOUR_MS;

/** Record types left out of every cost series so that an expiring credit never looks like a spike. */
export const EXCLUDED_RECORD_TYPES = ['Credit', 'Refund'];

export const excludeCreditsExpression = (): Expression => ({
  Not: { Dimensions: { Key: 'RECORD_TYPE', Values: [...EXCLUDED_RECORD_TYPES] } },
});

export const isTagDim = (d: Dim): d is `TAG:${string}` => d.startsWith('TAG:');
export const tagKeyOf = (d: Dim): string => d.slice(4);

export function toGroupDefinition(d: Dim): GroupDefinition {
  return isTagDim(d) ? { Type: 'TAG', Key: tagKeyOf(d) } : { Type: 'DIMENSION', Key: d };
}

function dimExpression(dim: Dim, values: string[]): Expression | null {
  const vals = [...new Set(values)];
  if (!vals.length) return null;
  if (!isTagDim(dim)) return { Dimensions: { Key: dim, Values: vals } };
  const key = tagKeyOf(dim);
  const present = vals.filter((v) => v !== '');
  const parts: Expression[] = [];
  if (present.length) parts.push({ Tags: { Key: key, Values: present, MatchOptions: ['EQUALS'] } });
  // '' = untagged: resources that do not carry the tag at all
  if (present.length !== vals.length) parts.push({ Tags: { Key: key, MatchOptions: ['ABSENT'] } });
  return parts.length === 1 ? parts[0] : { Or: parts };
}

/** true when the query deals with RECORD_TYPE itself, in which case credits/refunds are passed through untouched */
export function touchesRecordType(q: Pick<CostQuery, 'groupBy' | 'filters'>): boolean {
  return q.groupBy.includes('RECORD_TYPE') || (q.filters?.RECORD_TYPE?.length ?? 0) > 0;
}

/**
 * Filters -> CE Expression. AND across dimensions, OR within one.
 * Unless `includeCredits` is set (or the query touches RECORD_TYPE), Credit and Refund records are excluded.
 */
export function buildFilter(q: Pick<CostQuery, 'groupBy' | 'filters'>, opts: { includeCredits?: boolean } = {}): Expression | undefined {
  const parts: Expression[] = [];
  const filters = q.filters ?? {};
  for (const dim of Object.keys(filters).sort() as Dim[]) {
    const e = dimExpression(dim, filters[dim] ?? []);
    if (e) parts.push(e);
  }
  if (!opts.includeCredits && !touchesRecordType(q)) parts.push(excludeCreditsExpression());
  if (!parts.length) return undefined;
  return parts.length === 1 ? parts[0] : { And: parts };
}

/** CE rejects end dates in the future beyond "tomorrow" (exclusive end = today inclusive). */
export function clampEnd(end: string, today: string): string {
  const max = addDays(today, 1);
  return end > max ? max : end;
}

/**
 * CostQuery -> GetCostAndUsage request. Returns null when the (clamped) period is empty,
 * in which case no request should be made at all.
 */
export function buildCostAndUsageRequest(
  q: CostQuery,
  costBasis: CostBasis,
  today: string,
  opts: { includeCredits?: boolean } = {},
): GetCostAndUsageCommandInput | null {
  if (q.groupBy.length > 2) throw new Error('Cost Explorer supports at most two group-by dimensions');
  const end = clampEnd(q.end, today);
  if (!(q.start < end)) return null;
  const req: GetCostAndUsageCommandInput = {
    TimePeriod: { Start: q.start, End: end },
    Granularity: q.granularity,
    Metrics: [costBasis, 'UsageQuantity'],
  };
  if (q.groupBy.length) req.GroupBy = q.groupBy.map(toGroupDefinition);
  const filter = buildFilter(q, opts);
  if (filter) req.Filter = filter;
  return req;
}

/** Tag group keys come back as `key$value` (`key$` when untagged). */
export function stripTagKey(raw: string, tagKey: string): string {
  const prefix = tagKey + '$';
  if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  const i = raw.indexOf('$');
  return i >= 0 ? raw.slice(i + 1) : raw;
}

/** One GetCostAndUsage page -> CostRows. Rows where cost and usage are both zero are dropped. */
export function mapCostAndUsage(
  page: Pick<GetCostAndUsageCommandOutput, 'ResultsByTime'>,
  groupBy: Dim[],
  costBasis: CostBasis,
): CostRow[] {
  const rows: CostRow[] = [];
  const push = (keys: string[], date: string, metrics: Record<string, { Amount?: string }> | undefined) => {
    const cost = Number(metrics?.[costBasis]?.Amount ?? 0) || 0;
    const usage = Number(metrics?.UsageQuantity?.Amount ?? 0) || 0;
    if (cost === 0 && usage === 0) return;
    rows.push({ keys, date, cost, usage });
  };
  for (const r of page.ResultsByTime ?? []) {
    const date = r.TimePeriod?.Start?.slice(0, 10);
    if (!date) continue;
    if (!groupBy.length) {
      push([], date, r.Total);
      continue;
    }
    for (const g of r.Groups ?? []) {
      const keys = groupBy.map((d, i) => {
        const raw = g.Keys?.[i] ?? '';
        return isTagDim(d) ? stripTagKey(raw, tagKeyOf(d)) : raw;
      });
      push(keys, date, g.Metrics);
    }
  }
  return rows;
}

export function currencyOf(page: Pick<GetCostAndUsageCommandOutput, 'ResultsByTime'>, costBasis: CostBasis): string | undefined {
  for (const r of page.ResultsByTime ?? []) {
    const u = r.Total?.[costBasis]?.Unit ?? r.Groups?.find((g) => g.Metrics?.[costBasis]?.Unit)?.Metrics?.[costBasis]?.Unit;
    if (u) return u;
  }
  return undefined;
}

/** Collapse a multi-period result into one total row per key (date = `date`). */
export function totalsByKey(rows: CostRow[], date: string): CostRow[] {
  const m = new Map<string, CostRow>();
  for (const r of rows) {
    const k = JSON.stringify(r.keys);
    const cur = m.get(k);
    if (cur) {
      cur.cost += r.cost;
      cur.usage = (cur.usage ?? 0) + (r.usage ?? 0);
    } else m.set(k, { keys: [...r.keys], date, cost: r.cost, usage: r.usage ?? 0 });
  }
  return [...m.values()].sort((a, b) => b.cost - a.cost);
}

// ── query cache ──

function normalizeQuery(q: CostQuery) {
  const filters: Record<string, string[]> = {};
  for (const k of Object.keys(q.filters ?? {}).sort()) {
    const v = (q.filters as Record<string, string[] | undefined>)[k];
    if (v && v.length) filters[k] = [...new Set(v)].sort();
  }
  return { start: q.start, end: q.end, granularity: q.granularity, groupBy: [...q.groupBy], filters };
}

/** Stable cache key for (account, cost basis, query). Filter key/value order does not matter; groupBy order does. */
export function cacheKey(accountId: string, costBasis: CostBasis, q: CostQuery): string {
  const payload = JSON.stringify({ v: 2, accountId, costBasis, q: normalizeQuery(q) });
  return createHash('sha256').update(payload).digest('hex').slice(0, 40);
}

/** 6 hours normally; 7 days when the whole period ended before today-3 (the bill for those days has settled). */
export function cacheTtlMs(q: Pick<CostQuery, 'end'>, today: string): number {
  const lastDay = addDays(q.end, -1);
  return lastDay < addDays(today, -3) ? SETTLED_TTL_MS : QUERY_TTL_MS;
}

export function isFresh(savedAt: number, ttlMs: number, now: number): boolean {
  return savedAt <= now && now - savedAt < ttlMs;
}
