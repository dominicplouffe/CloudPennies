// Pure: column-name resolution across the three CUR naming styles, value coercion and the cost-basis rule.
import type { CostBasis } from '../../../src/core/types';

/** The columns CloudPennies reads, under one canonical name each. */
export type Field =
  | 'usageStart'
  | 'billingPeriodStart'
  | 'account'
  | 'productCode'
  | 'productName'
  | 'productMap'
  | 'usageType'
  | 'operation'
  | 'resourceId'
  | 'lineItemType'
  | 'region'
  | 'usageAmount'
  | 'unblended'
  | 'netUnblended'
  | 'spEffective'
  | 'netSpEffective'
  | 'spTotalCommitment'
  | 'spUsedCommitment'
  | 'riEffective'
  | 'netRiEffective'
  | 'riUnusedUpfront'
  | 'netRiUnusedUpfront'
  | 'riUnusedRecurring'
  | 'netRiUnusedRecurring'
  | 'reservationArn';

/** Candidate column names per field, in order of preference, in normalized (snake_case) form. */
const CANDIDATES: Record<Field, string[]> = {
  usageStart: ['line_item_usage_start_date'],
  billingPeriodStart: ['bill_billing_period_start_date'],
  account: ['line_item_usage_account_id', 'bill_payer_account_id'],
  productCode: ['line_item_product_code', 'product_servicecode'],
  productName: ['product_product_name'],
  productMap: ['product'],
  usageType: ['line_item_usage_type'],
  operation: ['line_item_operation'],
  resourceId: ['line_item_resource_id'],
  lineItemType: ['line_item_line_item_type'],
  region: ['product_region_code', 'product_region'],
  usageAmount: ['line_item_usage_amount'],
  unblended: ['line_item_unblended_cost'],
  netUnblended: ['line_item_net_unblended_cost'],
  spEffective: ['savings_plan_savings_plan_effective_cost'],
  netSpEffective: ['savings_plan_net_savings_plan_effective_cost'],
  spTotalCommitment: ['savings_plan_total_commitment_to_date'],
  spUsedCommitment: ['savings_plan_used_commitment'],
  riEffective: ['reservation_effective_cost'],
  netRiEffective: ['reservation_net_effective_cost'],
  riUnusedUpfront: ['reservation_unused_amortized_upfront_fee_for_billing_period'],
  netRiUnusedUpfront: ['reservation_net_unused_amortized_upfront_fee_for_billing_period'],
  riUnusedRecurring: ['reservation_unused_recurring_fee'],
  netRiUnusedRecurring: ['reservation_net_unused_recurring_fee'],
  reservationArn: ['reservation_reservation_a_r_n', 'reservation_reservation_arn'],
};

export const FIELDS = Object.keys(CANDIDATES) as Field[];

/** Without these a file cannot be turned into costs at all. */
export const REQUIRED_FIELDS: Field[] = ['usageStart', 'lineItemType', 'unblended'];

const camelToSnake = (s: string): string =>
  s
    .replace(/([A-Z])/g, '_$1')
    .replace(/^_/, '')
    .toLowerCase();

/**
 * One spelling for every style:
 *   'lineItem/UsageStartDate'  -> 'line_item_usage_start_date'   (legacy CSV)
 *   'reservation/ReservationARN' -> 'reservation_reservation_a_r_n' (the way AWS itself converts it for Parquet)
 *   'Line_Item_Usage_Start_Date' -> 'line_item_usage_start_date'   (CUR 2.0 / legacy Parquet, any case)
 */
export function normalizeColumnName(name: string): string {
  const n = String(name ?? '').trim();
  const snake = n.includes('/') ? n.split('/').map(camelToSnake).join('_') : n.toLowerCase();
  return snake
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

export type ColumnMap = Partial<Record<Field, string>>;

/** Map each field to the actual column name found in a file's header/schema; fields with no column are absent. */
export function resolveColumns(names: readonly string[]): ColumnMap {
  const byNormal = new Map<string, string>();
  for (const n of names) {
    const k = normalizeColumnName(n);
    if (k && !byNormal.has(k)) byNormal.set(k, n);
  }
  const map: ColumnMap = {};
  for (const f of FIELDS) {
    for (const c of CANDIDATES[f]) {
      const actual = byNormal.get(c);
      if (actual !== undefined) {
        map[f] = actual;
        break;
      }
    }
  }
  // the `product` map is only worth decoding when there is no flat product-name column
  if (map.productName) delete map.productMap;
  return map;
}

export const missingRequired = (map: ColumnMap): Field[] => REQUIRED_FIELDS.filter((f) => !map[f]);

/** Human names of the required columns, for error messages. */
export const requiredColumnNames = (fields: Field[]): string => fields.map((f) => CANDIDATES[f][0]).join(', ');

// ── value coercion ──

export function toNumber(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'bigint') return Number(v);
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function toText(v: unknown): string {
  if (v === null || v === undefined) return '';
  return typeof v === 'string' ? v : String(v);
}

const isoDay = (ms: number): string | undefined => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString().slice(0, 10);
};

/** Date objects, ISO strings ('2026-11-03T00:00:00Z', '2026-11-03 00:00:00') and epoch numbers (s, ms, µs, ns) -> 'YYYY-MM-DD' (UTC). */
export function toDay(v: unknown): string | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  if (v instanceof Date) return isoDay(v.getTime());
  if (typeof v === 'bigint') return toDay(Number(v));
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return undefined;
    const a = Math.abs(v);
    if (a < 1e11) return isoDay(v * 1000); // seconds
    if (a < 1e14) return isoDay(v); // milliseconds
    if (a < 1e17) return isoDay(v / 1000); // microseconds
    return isoDay(v / 1e6); // nanoseconds
  }
  const s = String(v).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  if (/^-?\d+(\.\d+)?$/.test(s)) return toDay(Number(s));
  const t = Date.parse(s);
  return Number.isNaN(t) ? undefined : isoDay(t);
}

/** `product['product_name']` from the CUR 2.0 `product` map, however the reader hands it over. */
export function productNameFromMap(v: unknown): string {
  if (!v) return '';
  let o: unknown = v;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return '';
    try {
      o = JSON.parse(s);
    } catch {
      return '';
    }
  }
  const KEYS = ['product_name', 'productname', 'ProductName'];
  if (o instanceof Map) {
    for (const k of KEYS) if (typeof o.get(k) === 'string') return o.get(k) as string;
    return '';
  }
  if (Array.isArray(o)) {
    for (const e of o) {
      if (Array.isArray(e) && KEYS.includes(String(e[0]))) return toText(e[1]);
      if (e && typeof e === 'object' && KEYS.includes(String((e as { key?: unknown }).key))) return toText((e as { value?: unknown }).value);
    }
    return '';
  }
  if (typeof o === 'object' && o !== null) {
    const r = o as Record<string, unknown>;
    for (const k of KEYS) if (typeof r[k] === 'string') return r[k] as string;
  }
  return '';
}

// ── cost basis ──

/** Line item types left out everywhere, like RECORD_TYPE Credit/Refund in the Cost Explorer queries. */
export const EXCLUDED_LINE_ITEM_TYPES = new Set(['credit', 'refund']);

export interface CostInputs {
  lineItemType: string;
  unblended?: number;
  netUnblended?: number;
  spEffective?: number;
  netSpEffective?: number;
  spTotalCommitment?: number;
  spUsedCommitment?: number;
  riEffective?: number;
  netRiEffective?: number;
  riUnusedUpfront?: number;
  netRiUnusedUpfront?: number;
  riUnusedRecurring?: number;
  netRiUnusedRecurring?: number;
  reservationArn?: string;
}

/**
 * Cost of one line item in the given cost basis; null when the line is excluded (Credit, Refund).
 *
 * The amortized bases follow AWS's published amortized-cost query for the Cost and Usage Report
 * (the "Amortized cost" CASE expression in the CUR query library / Savings Plans and Reserved
 * Instances documentation):
 *
 *   SavingsPlanCoveredUsage  -> savings_plan_savings_plan_effective_cost
 *   SavingsPlanRecurringFee  -> savings_plan_total_commitment_to_date - savings_plan_used_commitment
 *   SavingsPlanNegation      -> 0
 *   SavingsPlanUpfrontFee    -> 0
 *   DiscountedUsage          -> reservation_effective_cost
 *   RIFee                    -> reservation_unused_amortized_upfront_fee_for_billing_period + reservation_unused_recurring_fee
 *   Fee with a reservation ARN (the upfront purchase) -> 0
 *   everything else          -> line_item_unblended_cost
 *
 * NetAmortizedCost uses the `net_` variant of each column when the report has it (they only exist on
 * accounts with discounts) and the plain column otherwise. NetUnblendedCost likewise falls back to
 * the unblended cost.
 */
export function lineItemCost(basis: CostBasis, v: CostInputs): number | null {
  const type = v.lineItemType.trim().toLowerCase();
  if (EXCLUDED_LINE_ITEM_TYPES.has(type)) return null;
  const unblended = v.unblended ?? 0;
  if (basis === 'UnblendedCost') return unblended;
  const netUnblended = v.netUnblended ?? unblended;
  if (basis === 'NetUnblendedCost') return netUnblended;

  const net = basis === 'NetAmortizedCost';
  const pick = (netValue: number | undefined, plain: number | undefined): number => (net ? (netValue ?? plain ?? 0) : (plain ?? 0));
  switch (type) {
    case 'savingsplancoveredusage':
      return pick(v.netSpEffective, v.spEffective);
    case 'savingsplanrecurringfee':
      return (v.spTotalCommitment ?? 0) - (v.spUsedCommitment ?? 0);
    case 'savingsplannegation':
    case 'savingsplanupfrontfee':
      return 0;
    case 'discountedusage':
      return pick(v.netRiEffective, v.riEffective);
    case 'rifee':
      return pick(v.netRiUnusedUpfront, v.riUnusedUpfront) + pick(v.netRiUnusedRecurring, v.riUnusedRecurring);
    case 'fee':
      if ((v.reservationArn ?? '').trim()) return 0;
      return net ? netUnblended : unblended;
    default:
      return net ? netUnblended : unblended;
  }
}

// ── rows ──

/** One report line, normalized. */
export interface LineItem {
  /** usage day, YYYY-MM-DD (UTC) */
  day: string;
  account: string;
  productCode: string;
  productName: string;
  usageType: string;
  operation: string;
  region: string;
  resourceId: string;
  lineItemType: string;
  cost: number;
  usage: number;
}

/**
 * Normalize one row. `get` returns the raw value of a field (undefined when the file has no such column).
 * Returns null for excluded lines (Credit/Refund) and for lines with no usable date.
 */
export function toLineItem(get: (f: Field) => unknown, basis: CostBasis): LineItem | null {
  const lineItemType = toText(get('lineItemType')).trim();
  const cost = lineItemCost(basis, {
    lineItemType,
    unblended: toNumber(get('unblended')),
    netUnblended: toNumber(get('netUnblended')),
    spEffective: toNumber(get('spEffective')),
    netSpEffective: toNumber(get('netSpEffective')),
    spTotalCommitment: toNumber(get('spTotalCommitment')),
    spUsedCommitment: toNumber(get('spUsedCommitment')),
    riEffective: toNumber(get('riEffective')),
    netRiEffective: toNumber(get('netRiEffective')),
    riUnusedUpfront: toNumber(get('riUnusedUpfront')),
    netRiUnusedUpfront: toNumber(get('netRiUnusedUpfront')),
    riUnusedRecurring: toNumber(get('riUnusedRecurring')),
    netRiUnusedRecurring: toNumber(get('netRiUnusedRecurring')),
    reservationArn: toText(get('reservationArn')),
  });
  if (cost === null) return null;
  const day = toDay(get('usageStart')) ?? toDay(get('billingPeriodStart'));
  if (!day) return null;
  return {
    day,
    account: toText(get('account')).trim(),
    productCode: toText(get('productCode')).trim(),
    productName: toText(get('productName')).trim() || productNameFromMap(get('productMap')),
    usageType: toText(get('usageType')).trim(),
    operation: toText(get('operation')).trim(),
    region: toText(get('region')).trim(),
    resourceId: toText(get('resourceId')).trim(),
    lineItemType,
    cost,
    usage: toNumber(get('usageAmount')) ?? 0,
  };
}
