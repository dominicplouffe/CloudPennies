// Pure mappers from AWS API shapes to the CloudPennies Snapshot model. No I/O here, so everything is unit-testable.
import type {
  Anomaly as CeAnomaly,
  ReservationPurchaseRecommendation,
  ReservationPurchaseRecommendationDetail,
  ReservationUtilizationGroup,
  RightsizingRecommendation,
  SavingsPlansPurchaseRecommendation,
  SavingsPlansPurchaseRecommendationDetail,
  SavingsPlansUtilizationDetail,
} from '@aws-sdk/client-cost-explorer';
import type { Budget as AwsBudget } from '@aws-sdk/client-budgets';
import type { Recommendation as HubRecommendation } from '@aws-sdk/client-cost-optimization-hub';
import type {
  AwsAnomaly,
  Budget,
  Commitments,
  CostRow,
  CoveragePoint,
  HubRec,
  Reservation,
  ReservationRecommendation,
  RightsizingRec,
  SavingsPlan,
  SavingsPlanRecommendation,
  ServiceCoverage,
} from '../../src/core/types';
import { diffDays, num, toIsoDate } from './dates';

/** case-insensitive attribute lookup (CE is inconsistent: `EndDateTime` for SPs, `endDateTime` for RIs) */
export function attr(a: Record<string, string> | undefined, ...names: string[]): string | undefined {
  if (!a) return undefined;
  for (const n of names) if (a[n] !== undefined && a[n] !== '') return a[n];
  const lower = new Map(Object.entries(a).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) {
    const v = lower.get(n.toLowerCase());
    if (v !== undefined && v !== '') return v;
  }
  return undefined;
}

const PAYMENT_LABEL: Record<string, string> = {
  NO_UPFRONT: 'No Upfront',
  PARTIAL_UPFRONT: 'Partial Upfront',
  ALL_UPFRONT: 'All Upfront',
  LIGHT_UTILIZATION: 'Light Utilization',
  MEDIUM_UTILIZATION: 'Medium Utilization',
  HEAVY_UTILIZATION: 'Heavy Utilization',
};
export function paymentLabel(v: string | undefined): string {
  if (!v) return 'Unknown';
  const k = v.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return PAYMENT_LABEL[k] ?? v;
}

/** 'ComputeSavingsPlans' | 'COMPUTE_SP' | 'EC2 Instance Savings Plans' ... -> 'Compute' | 'EC2Instance' | 'SageMaker' | 'Database' */
export function spTypeLabel(v: string | undefined): string {
  const s = (v ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (s.startsWith('ec2')) return 'EC2Instance';
  if (s.startsWith('sagemaker')) return 'SageMaker';
  if (s.startsWith('database')) return 'Database';
  if (s.startsWith('compute')) return 'Compute';
  return v ? v.replace(/SavingsPlans?$/i, '').trim() || v : 'Compute';
}

function termYears(term: string | undefined, start: string | undefined, end: string | undefined): number | undefined {
  const m = /(\d+)/.exec(term ?? '');
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 5) return n; // "1yr", "3yr", "ONE_YEAR" handled below
    if (n >= 31_000_000) return Math.round(n / 31_536_000); // duration in seconds
  }
  if (/three/i.test(term ?? '')) return 3;
  if (/one/i.test(term ?? '')) return 1;
  if (start && end) return diffDays(end, start) > 730 ? 3 : 1;
  return undefined;
}

// ── Savings Plans ──

export function mapSavingsPlan(d: SavingsPlansUtilizationDetail, windowDays: number): SavingsPlan {
  const a = d.Attributes;
  const start = toIsoDate(attr(a, 'StartDateTime')) ?? '';
  const end = toIsoDate(attr(a, 'EndDateTime')) ?? '';
  const total = num(d.Utilization?.TotalCommitment);
  const used = num(d.Utilization?.UsedCommitment);
  const unused = d.Utilization?.UnusedCommitment !== undefined ? num(d.Utilization.UnusedCommitment) : Math.max(0, total - used);
  const hourlyAttr = attr(a, 'HourlyCommitment');
  const sp: SavingsPlan = {
    id: d.SavingsPlanArn ?? attr(a, 'SavingsPlanARN', 'SavingsPlanArn') ?? 'unknown',
    type: spTypeLabel(attr(a, 'SavingsPlansType', 'SavingsPlanType')),
    paymentOption: paymentLabel(attr(a, 'PaymentOption')),
    termYears: termYears(attr(a, 'PurchaseTerm', 'TermDurationInSeconds'), start, end) ?? 1,
    // fall back to the average commitment per hour over the window when the attribute is missing
    hourlyCommitment: hourlyAttr !== undefined ? num(hourlyAttr) : total / Math.max(1, windowDays * 24),
    start,
    end,
    utilizationPct: d.Utilization?.UtilizationPercentage !== undefined ? num(d.Utilization.UtilizationPercentage) : total > 0 ? (used / total) * 100 : 0,
    usedCommitment: used,
    unusedCommitment: unused,
    netSavings: num(d.Savings?.NetSavings),
  };
  const region = attr(a, 'Region');
  const family = attr(a, 'InstanceFamily');
  if (region) sp.region = region;
  if (family) sp.instanceFamily = family;
  return sp;
}

// ── Reservations ──

export function mapReservation(g: ReservationUtilizationGroup, fallbackService: string): Reservation {
  const a = g.Attributes;
  const u = g.Utilization ?? {};
  const purchased = num(u.PurchasedHours);
  const unusedHours = num(u.UnusedHours);
  const amortized = u.AmortizedUpfrontFee !== undefined || u.AmortizedRecurringFee !== undefined
    ? num(u.AmortizedUpfrontFee) + num(u.AmortizedRecurringFee)
    : num(u.TotalAmortizedFee);
  const start = toIsoDate(attr(a, 'startDateTime'));
  const end = toIsoDate(attr(a, 'endDateTime')) ?? '';
  const r: Reservation = {
    id: g.Value ?? attr(a, 'subscriptionId', 'reservationARN', 'leaseId') ?? 'unknown',
    service: attr(a, 'service') ?? fallbackService,
    instanceType: attr(a, 'instanceType', 'nodeType', 'instanceClass') ?? 'unknown',
    region: attr(a, 'region') ?? '',
    count: num(attr(a, 'numberOfInstances')) || 1,
    end,
    utilizationPct: u.UtilizationPercentage !== undefined ? num(u.UtilizationPercentage) : purchased > 0 ? ((purchased - unusedHours) / purchased) * 100 : 0,
    unusedHours,
    amortizedCost: amortized,
    // estimate: the share of the amortized fee matching the unused share of purchased hours
    unusedCost: purchased > 0 ? amortized * Math.min(1, unusedHours / purchased) : 0,
    netSavings: num(u.NetRISavings),
  };
  const platform = attr(a, 'platform', 'databaseEngine', 'cacheEngine', 'productDescription');
  const offering = attr(a, 'offeringType', 'paymentOption');
  const ty = termYears(attr(a, 'termLength', 'duration'), start, end || undefined);
  if (platform) r.platform = platform;
  if (offering) r.offeringType = paymentLabel(offering);
  if (ty) r.termYears = ty;
  if (start) r.start = start;
  return r;
}

// ── Coverage ──

export interface RiCoverageDay {
  service: string;
  date: string;
  reservedHours: number;
  onDemandHours: number;
  totalHours: number;
  /** on-demand cost of the hours NOT covered by a reservation */
  onDemandCost: number;
}
export interface SpServiceCoverage {
  service: string;
  covered: number;
  onDemand: number;
}

/**
 * Combine Savings Plans coverage and per-service RI coverage into one daily series.
 *
 * Assumptions (Cost Explorer does not offer a combined view):
 *  - SP coverage: `SpendCoveredBySavingsPlans` is already valued at on-demand rates and `OnDemandCost`
 *    is the SP-eligible spend left uncovered (usage covered by RIs is not part of SP-eligible spend).
 *  - RI coverage is reported in hours plus the on-demand cost of the uncovered hours. The on-demand value of
 *    the covered hours is estimated as reservedHours × a per-service rate: preferably
 *    OnDemandCostOfRIHoursUsed / TotalActualHours from RI utilization (`riRates`), otherwise that day's
 *    OnDemandCost / OnDemandHours (covered and uncovered usage assumed to be the same mix).
 *  - For services that are also SP-eligible (`spServices`, e.g. EC2), the RI report counts SP-covered hours as
 *    "on demand". To avoid double counting, their uncovered spend is taken from the SP report only.
 */
export function combineCoverage(
  spDaily: CoveragePoint[],
  riDaily: RiCoverageDay[],
  riRates: Map<string, number>,
  spServices: Set<string>,
): CoveragePoint[] {
  const m = new Map<string, CoveragePoint>();
  const at = (date: string) => {
    let p = m.get(date);
    if (!p) m.set(date, (p = { date, covered: 0, onDemand: 0 }));
    return p;
  };
  for (const p of spDaily) {
    const t = at(p.date);
    t.covered += p.covered;
    t.onDemand += p.onDemand;
  }
  for (const d of riDaily) {
    const t = at(d.date);
    t.covered += riCoveredValue(d, riRates);
    if (!spServices.has(d.service)) t.onDemand += d.onDemandCost;
  }
  return [...m.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function riCoveredValue(d: RiCoverageDay, riRates: Map<string, number>): number {
  const rate = riRates.get(d.service) ?? (d.onDemandHours > 0 ? d.onDemandCost / d.onDemandHours : 0);
  return d.reservedHours * rate;
}

/** Per-service coverage over the lookback window (rows of `riDaily` must already be limited to that window). */
export function coverageByService(sp: SpServiceCoverage[], riDaily: RiCoverageDay[]): ServiceCoverage[] {
  const out: ServiceCoverage[] = [];
  const spServices = new Set<string>();
  for (const s of sp) {
    const total = s.covered + s.onDemand;
    if (total <= 0) continue;
    spServices.add(s.service);
    out.push({ service: s.service, kind: 'SP', coveragePct: (s.covered / total) * 100, onDemandCost: s.onDemand });
  }
  const ri = new Map<string, { reserved: number; total: number; od: number }>();
  for (const d of riDaily) {
    const t = ri.get(d.service) ?? { reserved: 0, total: 0, od: 0 };
    t.reserved += d.reservedHours;
    t.total += d.totalHours || d.reservedHours + d.onDemandHours;
    t.od += d.onDemandCost;
    ri.set(d.service, t);
  }
  for (const [service, t] of ri) {
    if (t.total <= 0) continue;
    const overlap = spServices.has(service);
    // For SP-eligible services the uncovered spend is already on the SP row; only list the RI row when RIs exist.
    if (overlap && t.reserved <= 0) continue;
    out.push({ service, kind: 'RI', coveragePct: (t.reserved / t.total) * 100, onDemandCost: overlap ? 0 : t.od });
  }
  return out.sort((a, b) => b.onDemandCost - a.onDemandCost);
}

export function commitmentTotals(
  savingsPlans: SavingsPlan[],
  reservations: Reservation[],
  coverage: CoveragePoint[],
  windowStart: string,
): Commitments['totals'] {
  const recent = coverage.filter((p) => p.date >= windowStart);
  const s = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  return {
    spCommitment: s(savingsPlans.map((p) => p.usedCommitment + p.unusedCommitment)),
    spUsed: s(savingsPlans.map((p) => p.usedCommitment)),
    riAmortized: s(reservations.map((r) => r.amortizedCost)),
    riUnused: s(reservations.map((r) => r.unusedCost)),
    netSavings: s(savingsPlans.map((p) => p.netSavings)) + s(reservations.map((r) => r.netSavings)),
    onDemandEquivalentCovered: s(recent.map((p) => p.covered)),
    onDemandEligible: s(recent.map((p) => p.onDemand)),
  };
}

// ── Purchase recommendations ──

const LOOKBACK_DAYS: Record<string, number> = { SEVEN_DAYS: 7, THIRTY_DAYS: 30, SIXTY_DAYS: 60 };
export const lookbackDays = (v: string | undefined): number => LOOKBACK_DAYS[v ?? ''] ?? 30;

/** One summary recommendation per (type, term, payment) request; null when AWS recommends nothing. */
export function mapSpRecommendation(
  rec: SavingsPlansPurchaseRecommendation | undefined,
  details: SavingsPlansPurchaseRecommendationDetail[],
  req: { type: string; term: string; payment: string; lookback: string },
): SavingsPlanRecommendation | null {
  const s = rec?.SavingsPlansPurchaseRecommendationSummary;
  const hourly = s?.HourlyCommitmentToPurchase !== undefined ? num(s.HourlyCommitmentToPurchase) : details.reduce((a, d) => a + num(d.HourlyCommitmentToPurchase), 0);
  if (!(hourly > 0)) return null;
  const days = lookbackDays(rec?.LookbackPeriodInDays ?? req.lookback);
  const monthly = 30.4375 / days;
  const savings = s?.EstimatedMonthlySavingsAmount !== undefined
    ? num(s.EstimatedMonthlySavingsAmount)
    : details.reduce((a, d) => a + num(d.EstimatedMonthlySavingsAmount), 0);
  // CurrentOnDemandSpend covers the lookback period; scale it to an average month.
  const onDemand = (s?.CurrentOnDemandSpend !== undefined ? num(s.CurrentOnDemandSpend) : details.reduce((a, d) => a + num(d.EstimatedOnDemandCostWithCurrentCommitment), 0)) * monthly;
  const out: SavingsPlanRecommendation = {
    type: spTypeLabel(rec?.SavingsPlansType ?? req.type),
    termYears: (rec?.TermInYears ?? req.term) === 'THREE_YEARS' ? 3 : 1,
    paymentOption: paymentLabel(rec?.PaymentOption ?? req.payment),
    lookbackDays: days,
    hourlyCommitment: hourly,
    upfrontCost: details.reduce((a, d) => a + num(d.UpfrontCost), 0),
    estimatedMonthlySavings: savings,
    estimatedSavingsPct: num(s?.EstimatedSavingsPercentage),
    currentMonthlyOnDemand: onDemand,
  };
  const w = details.reduce((a, d) => a + num(d.HourlyCommitmentToPurchase), 0);
  if (w > 0 && details.some((d) => d.EstimatedAverageUtilization !== undefined)) {
    out.estimatedUtilizationPct = details.reduce((a, d) => a + num(d.EstimatedAverageUtilization) * num(d.HourlyCommitmentToPurchase), 0) / w;
  }
  return out;
}

function riInstance(d: ReservationPurchaseRecommendationDetail): { instanceType: string; region: string; platform?: string; flex: boolean } {
  const i = d.InstanceDetails;
  const join = (...xs: (string | undefined)[]) => xs.filter(Boolean).join(' ') || undefined;
  if (i?.RDSInstanceDetails) {
    const x = i.RDSInstanceDetails;
    return { instanceType: x.InstanceType ?? x.Family ?? 'unknown', region: x.Region ?? '', platform: join(x.DatabaseEngine, x.DatabaseEdition, x.DeploymentOption), flex: !!x.SizeFlexEligible };
  }
  if (i?.ElastiCacheInstanceDetails) {
    const x = i.ElastiCacheInstanceDetails;
    return { instanceType: x.NodeType ?? x.Family ?? 'unknown', region: x.Region ?? '', platform: x.ProductDescription, flex: !!x.SizeFlexEligible };
  }
  if (i?.ESInstanceDetails) {
    const x = i.ESInstanceDetails;
    return { instanceType: [x.InstanceClass, x.InstanceSize].filter(Boolean).join('.') || 'unknown', region: x.Region ?? '', flex: !!x.SizeFlexEligible };
  }
  if (i?.RedshiftInstanceDetails) {
    const x = i.RedshiftInstanceDetails;
    return { instanceType: x.NodeType ?? x.Family ?? 'unknown', region: x.Region ?? '', flex: !!x.SizeFlexEligible };
  }
  if (i?.MemoryDBInstanceDetails) {
    const x = i.MemoryDBInstanceDetails;
    return { instanceType: x.NodeType ?? x.Family ?? 'unknown', region: x.Region ?? '', flex: !!x.SizeFlexEligible };
  }
  if (i?.EC2InstanceDetails) {
    const x = i.EC2InstanceDetails;
    return { instanceType: x.InstanceType ?? x.Family ?? 'unknown', region: x.Region ?? '', platform: join(x.Platform, x.Tenancy), flex: !!x.SizeFlexEligible };
  }
  const c = d.ReservedCapacityDetails?.DynamoDBCapacityDetails;
  if (c) return { instanceType: c.CapacityUnits ?? 'Reserved capacity', region: c.Region ?? '', flex: false };
  return { instanceType: 'unknown', region: '', flex: false };
}

export function mapRiRecommendations(service: string, recs: ReservationPurchaseRecommendation[]): ReservationRecommendation[] {
  const out: ReservationRecommendation[] = [];
  for (const rec of recs) {
    for (const d of rec.RecommendationDetails ?? []) {
      const inst = riInstance(d);
      const count = num(d.RecommendedNumberOfInstancesToPurchase) || num(d.RecommendedNumberOfCapacityUnitsToPurchase) || num(d.RecommendedNormalizedUnitsToPurchase);
      const savings = num(d.EstimatedMonthlySavingsAmount);
      if (count <= 0 && savings <= 0) continue;
      const r: ReservationRecommendation = {
        service,
        instanceType: inst.instanceType,
        region: inst.region,
        count,
        termYears: rec.TermInYears === 'THREE_YEARS' ? 3 : 1,
        paymentOption: paymentLabel(rec.PaymentOption),
        lookbackDays: lookbackDays(rec.LookbackPeriodInDays),
        upfrontCost: num(d.UpfrontCost),
        recurringMonthlyCost: num(d.RecurringStandardMonthlyCost),
        estimatedMonthlySavings: savings,
        estimatedSavingsPct: num(d.EstimatedMonthlySavingsPercentage),
      };
      if (inst.platform) r.platform = inst.platform;
      if (d.EstimatedBreakEvenInMonths !== undefined) r.breakEvenMonths = num(d.EstimatedBreakEvenInMonths);
      if (d.AccountId) r.account = d.AccountId;
      out.push(r);
    }
  }
  return out.sort((a, b) => b.estimatedMonthlySavings - a.estimatedMonthlySavings);
}

// ── Rightsizing / Hub / anomalies / budgets ──

export function mapRightsizing(r: RightsizingRecommendation): RightsizingRec | null {
  const cur = r.CurrentInstance;
  if (!cur?.ResourceId) return null;
  const details = cur.ResourceDetails?.EC2ResourceDetails;
  const terminate = r.RightsizingType === 'TERMINATE';
  const out: RightsizingRec = {
    resourceId: cur.ResourceId,
    currentType: details?.InstanceType ?? 'unknown',
    action: terminate ? 'TERMINATE' : 'MODIFY',
    currentMonthlyCost: num(cur.MonthlyCost),
    monthlySavings: 0,
  };
  if (terminate) {
    out.monthlySavings = num(r.TerminateRecommendationDetail?.EstimatedMonthlySavings);
  } else {
    const targets = r.ModifyRecommendationDetail?.TargetInstances ?? [];
    const best = targets.find((t) => t.DefaultTargetInstance) ?? [...targets].sort((a, b) => num(b.EstimatedMonthlySavings) - num(a.EstimatedMonthlySavings))[0];
    if (!best) return null;
    out.monthlySavings = num(best.EstimatedMonthlySavings);
    const tt = best.ResourceDetails?.EC2ResourceDetails?.InstanceType;
    if (tt) out.targetType = tt;
  }
  if (cur.InstanceName) out.name = cur.InstanceName;
  if (r.AccountId) out.account = r.AccountId;
  if (details?.Region) out.region = details.Region;
  const cpu = cur.ResourceUtilization?.EC2ResourceUtilization?.MaxCpuUtilizationPercentage;
  if (cpu !== undefined && cpu !== '') out.maxCpuPct = num(cpu);
  return out;
}

export function mapHubRec(r: HubRecommendation, index = 0): HubRec {
  const out: HubRec = {
    id: r.recommendationId ?? `hub-${index}`,
    resourceType: r.currentResourceType ?? r.recommendedResourceType ?? 'Unknown',
    actionType: r.actionType ?? 'Unknown',
    monthlySavings: r.estimatedMonthlySavings ?? 0,
  };
  if (r.resourceId) out.resourceId = r.resourceId;
  if (r.currentResourceSummary) out.currentSummary = r.currentResourceSummary;
  if (r.recommendedResourceSummary) out.recommendedSummary = r.recommendedResourceSummary;
  if (r.estimatedSavingsPercentage !== undefined) out.savingsPct = r.estimatedSavingsPercentage;
  if (r.estimatedMonthlyCost !== undefined) out.currentMonthlyCost = r.estimatedMonthlyCost;
  if (r.implementationEffort) out.effort = r.implementationEffort;
  if (r.restartNeeded !== undefined) out.restartNeeded = r.restartNeeded;
  if (r.rollbackPossible !== undefined) out.rollbackPossible = r.rollbackPossible;
  if (r.region) out.region = r.region;
  if (r.accountId) out.account = r.accountId;
  return out;
}

export function mapAnomaly(a: CeAnomaly): AwsAnomaly {
  const rc = a.RootCauses?.[0];
  const out: AwsAnomaly = {
    id: a.AnomalyId ?? 'unknown',
    start: toIsoDate(a.AnomalyStartDate) ?? '',
    impact: a.Impact?.TotalImpact ?? a.Impact?.MaxImpact ?? 0,
  };
  const end = toIsoDate(a.AnomalyEndDate);
  if (end) out.end = end;
  if (rc?.Service) out.service = rc.Service;
  if (rc?.Region) out.region = rc.Region;
  if (rc?.LinkedAccount) out.account = rc.LinkedAccount;
  if (rc?.UsageType) out.usageType = rc.UsageType;
  if (a.Impact?.TotalExpectedSpend !== undefined) out.expected = a.Impact.TotalExpectedSpend;
  if (a.Impact?.TotalActualSpend !== undefined) out.actual = a.Impact.TotalActualSpend;
  if (a.Feedback) out.feedback = a.Feedback;
  return out;
}

export function mapBudget(b: AwsBudget): Budget {
  const out: Budget = {
    name: b.BudgetName ?? 'Budget',
    limit: num(b.BudgetLimit?.Amount),
    actual: num(b.CalculatedSpend?.ActualSpend?.Amount),
    timeUnit: b.TimeUnit ?? 'MONTHLY',
    type: b.BudgetType ?? 'COST',
  };
  const f = b.CalculatedSpend?.ForecastedSpend?.Amount;
  if (f !== undefined) out.forecast = num(f);
  return out;
}

// ── Tags ──

const TAG_PREFERENCE: string[][] = [
  ['team'],
  ['owner'],
  ['project'],
  ['application', 'app'],
  ['service'],
  ['cost-center', 'costcenter', 'cost_center'],
  ['environment', 'env'],
];

/** User-defined keys first, AWS-generated (`aws:`) keys last; capped. */
export function orderTagKeys(keys: string[], cap = 20): string[] {
  const uniq = [...new Set(keys.filter((k) => k !== ''))];
  const user = uniq.filter((k) => !k.toLowerCase().startsWith('aws:'));
  const aws = uniq.filter((k) => k.toLowerCase().startsWith('aws:'));
  return [...user, ...aws].slice(0, cap);
}

export function pickPrimaryTagKey(keys: string[]): string | null {
  if (!keys.length) return null;
  for (const names of TAG_PREFERENCE) {
    for (const n of names) {
      const hit = keys.find((k) => k.toLowerCase() === n);
      if (hit) return hit;
    }
  }
  return keys[0];
}

// ── Deep-scan helpers ──

const NOT_A_REGION = new Set(['', 'global', 'noregion', 'no region']);

/** Regions with more than `minSpend` in the window, biggest first, capped. Rows are keyed [SERVICE, REGION]. */
export function selectRegions(recentByServiceRegion: CostRow[], opts: { minSpend?: number; cap?: number } = {}): string[] {
  const { minSpend = 1, cap = 12 } = opts;
  const spend = new Map<string, number>();
  for (const r of recentByServiceRegion) {
    const region = (r.keys[1] ?? '').trim();
    if (NOT_A_REGION.has(region.toLowerCase())) continue;
    if (!/^[a-z]{2,}(-[a-z]+)+-\d+$/.test(region)) continue; // real region codes only (us-east-1, us-gov-west-1...)
    spend.set(region, (spend.get(region) ?? 0) + r.cost);
  }
  return [...spend.entries()]
    .filter(([, v]) => v > minSpend)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, cap)
    .map(([k]) => k);
}

/** `requestParameters.dashboardName` from a CloudTrail event's raw JSON */
export function parseDashboardName(cloudTrailEvent: string | undefined): string | undefined {
  if (!cloudTrailEvent) return undefined;
  try {
    const name = (JSON.parse(cloudTrailEvent) as { requestParameters?: { dashboardName?: unknown } }).requestParameters?.dashboardName;
    return typeof name === 'string' && name ? name : undefined;
  } catch {
    return undefined;
  }
}

/** "User initiated (2024-01-15 10:30:00 GMT)" -> "2024-01-15T10:30:00Z" */
export function parseStoppedSince(reason: string | undefined): string | undefined {
  const m = /\((\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s*(?:GMT|UTC)?\)/.exec(reason ?? '');
  return m ? `${m[1]}T${m[2]}Z` : undefined;
}

export const nameTag = (tags: { Key?: string; Value?: string }[] | undefined): string | undefined =>
  tags?.find((t) => t.Key === 'Name')?.Value || undefined;
