// Live AWS data source: on-demand Cost Explorer queries (disk-cached) and the full account scan.
import {
  CostExplorerClient,
  GetAnomaliesCommand,
  GetCostAndUsageCommand,
  GetCostForecastCommand,
  GetDimensionValuesCommand,
  GetReservationCoverageCommand,
  GetReservationPurchaseRecommendationCommand,
  GetReservationUtilizationCommand,
  GetRightsizingRecommendationCommand,
  GetSavingsPlansCoverageCommand,
  GetSavingsPlansPurchaseRecommendationCommand,
  GetSavingsPlansUtilizationDetailsCommand,
  GetTagsCommand,
  SupportedSavingsPlansType,
  type Expression,
  type GetSavingsPlansCoverageCommandOutput,
  type PaymentOption,
  type ReservationPurchaseRecommendation,
  type SavingsPlansPurchaseRecommendation,
  type SavingsPlansPurchaseRecommendationDetail,
  type TermInYears,
} from '@aws-sdk/client-cost-explorer';
import { BudgetsClient, DescribeBudgetsCommand } from '@aws-sdk/client-budgets';
import { CostOptimizationHubClient, ListRecommendationsCommand } from '@aws-sdk/client-cost-optimization-hub';
import type {
  AccountInfo,
  AwsAnomaly,
  Budget,
  Commitments,
  CostBasis,
  CostQuery,
  CostResult,
  CostRow,
  CoveragePoint,
  Forecast,
  HubRec,
  Reservation,
  ReservationRecommendation,
  ResourceFindings,
  RightsizingRec,
  SavingsPlan,
  SavingsPlanRecommendation,
  ScanProgress,
  Settings,
  Snapshot,
} from '../../src/core/types';
import { pruneCache, readCache, readJsonFile, snapshotFile, writeCache, writeJsonFile } from './cache';
import {
  buildCostAndUsageRequest,
  cacheKey,
  cacheTtlMs,
  currencyOf,
  excludeCreditsExpression,
  isFresh,
  mapCostAndUsage,
  SETTLED_TTL_MS,
  totalsByKey,
} from './ce';
import { addDays, addMonths, diffDays, monthStart, num, todayIso } from './dates';
import { classifyError, isDataUnavailable, isValidation, WarningSink } from './errors';
import {
  combineCoverage,
  commitmentTotals,
  coverageByService,
  mapAnomaly,
  mapBudget,
  mapHubRec,
  mapReservation,
  mapRightsizing,
  mapRiRecommendations,
  mapSavingsPlan,
  mapSpRecommendation,
  orderTagKeys,
  pickPrimaryTagKey,
  selectRegions,
  type RiCoverageDay,
  type SpServiceCoverage,
} from './mappers';
import { pool } from './pool';
import { emptyFindings, mergeFindings, scanRegion, type Creds } from './resources';

export interface LiveSourceOptions {
  credentials: Creds;
  settings: Settings;
  /** directory for the query cache and snapshot files */
  cacheDir: string;
  identity: { accountId: string; arn?: string };
  /** injectable clock (tests) */
  now?: () => Date;
}

export interface LiveSource {
  query(q: CostQuery): Promise<CostResult>;
  scan(onProgress?: (p: ScanProgress) => void): Promise<Snapshot>;
}

const BILLING_REGION = 'us-east-1';
const MAX_PAGES = 200;
const HUB_CAP = 500;
const EC2_SERVICE = 'Amazon Elastic Compute Cloud - Compute';

/**
 * Services that sell reservations.
 *  - `cost`: SERVICE name in cost data and in the SERVICE filter of the RI utilization/coverage APIs
 *  - `rec`:  Service name accepted by GetReservationPurchaseRecommendation (absent = not requested;
 *            EC2 purchase advice comes from the Savings Plans recommendations instead)
 */
const RI_SERVICES: { cost: string; rec?: string; label: string }[] = [
  { cost: EC2_SERVICE, label: 'EC2' },
  { cost: 'Amazon Relational Database Service', rec: 'Amazon Relational Database Service', label: 'RDS' },
  { cost: 'Amazon ElastiCache', rec: 'Amazon ElastiCache', label: 'ElastiCache' },
  { cost: 'Amazon OpenSearch Service', rec: 'Amazon OpenSearch Service', label: 'OpenSearch' },
  { cost: 'Amazon Redshift', rec: 'Amazon Redshift', label: 'Redshift' },
  { cost: 'Amazon MemoryDB', rec: 'Amazon MemoryDB Service', label: 'MemoryDB' },
  { cost: 'Amazon DynamoDB', rec: 'Amazon DynamoDB Service', label: 'DynamoDB' },
];
/** DynamoDB reserved capacity has no utilization/coverage report in Cost Explorer */
const RI_UTILIZATION_SERVICES = RI_SERVICES.filter((s) => s.label !== 'DynamoDB');

const FORECAST_METRIC: Record<CostBasis, 'UNBLENDED_COST' | 'NET_UNBLENDED_COST' | 'AMORTIZED_COST' | 'NET_AMORTIZED_COST'> = {
  UnblendedCost: 'UNBLENDED_COST',
  NetUnblendedCost: 'NET_UNBLENDED_COST',
  AmortizedCost: 'AMORTIZED_COST',
  NetAmortizedCost: 'NET_AMORTIZED_COST',
};

const emptyCommitments = (): Commitments => ({
  savingsPlans: [],
  reservations: [],
  coverage: [],
  coverageByService: [],
  totals: { spCommitment: 0, spUsed: 0, riAmortized: 0, riUnused: 0, netSavings: 0, onDemandEquivalentCovered: 0, onDemandEligible: 0 },
  spRecommendations: [],
  riRecommendations: [],
});

export function createLiveSource(opts: LiveSourceOptions): LiveSource {
  const { credentials, settings, cacheDir, identity } = opts;
  const now = opts.now ?? (() => new Date());
  const costBasis = settings.costBasis;
  const clientCfg = { region: BILLING_REGION, credentials, maxAttempts: 6, retryMode: 'adaptive' as const };
  const ce = new CostExplorerClient(clientCfg);

  /** Fetch every page of a GetCostAndUsage query. `count` is called once per (paid) request. */
  async function fetchCosts(
    q: CostQuery,
    today: string,
    count: () => void,
    o: { includeCredits?: boolean } = {},
  ): Promise<{ rows: CostRow[]; currency?: string }> {
    const req = buildCostAndUsageRequest(q, costBasis, today, o);
    if (!req) return { rows: [] };
    const rows: CostRow[] = [];
    let currency: string | undefined;
    let NextPageToken: string | undefined;
    let pages = 0;
    do {
      count();
      const page = await ce.send(new GetCostAndUsageCommand({ ...req, NextPageToken }));
      rows.push(...mapCostAndUsage(page, q.groupBy, costBasis));
      currency ??= currencyOf(page, costBasis);
      NextPageToken = page.NextPageToken;
    } while (NextPageToken && ++pages < MAX_PAGES);
    return { rows, currency };
  }

  const inflight = new Map<string, Promise<CostResult>>();

  async function query(q: CostQuery): Promise<CostResult> {
    const today = todayIso(now());
    const key = 'q-' + cacheKey(identity.accountId, costBasis, q);
    const ttl = cacheTtlMs(q, today);
    const hit = await readCache<CostResult>(cacheDir, key);
    if (hit && isFresh(hit.savedAt, ttl, now().getTime())) return hit.value;
    const running = inflight.get(key);
    if (running) return running;
    const p = (async () => {
      const { rows } = await fetchCosts(q, today, () => undefined);
      const result: CostResult = { rows };
      await writeCache(cacheDir, key, result, now().getTime());
      return result;
    })().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  async function scan(onProgress?: (p: ScanProgress) => void): Promise<Snapshot> {
    const startedAt = now();
    const today = todayIso(startedAt);
    const dataThrough = addDays(today, -1);
    const d30 = addDays(today, -30);
    const d90 = addDays(today, -90);
    const warnings = new WarningSink();
    let ceRequests = 0;
    const paid = () => {
      ceRequests++;
    };
    /** every Cost Explorer request goes through here so that it is counted ($0.01 each, pages included) */
    const ceSend = ((cmd: Parameters<typeof ce.send>[0]) => {
      paid();
      return ce.send(cmd);
    }) as typeof ce.send;

    // ── progress ──
    let done = 0;
    let total = 0;
    const report = (step: string) => {
      try {
        onProgress?.({ step, done, total });
      } catch {
        /* a broken listener must not break the scan */
      }
    };
    /** Run one section: progress + error isolation. Returns `fallback` (and records a warning) on failure. */
    const section = async <T>(id: string, step: string, action: string | undefined, fallback: T, fn: () => Promise<T>): Promise<T> => {
      report(step);
      try {
        return await fn();
      } catch (e) {
        warnings.add(classifyError(id, e, action));
        return fallback;
      } finally {
        done++;
        report(step);
      }
    };

    // ── phase 1: cost series ──
    let currency = 'USD';
    const costs = (id: string, step: string, q: CostQuery, o: { includeCredits?: boolean; totals?: boolean } = {}) => () =>
      section<CostRow[]>(id, step, 'ce:GetCostAndUsage', [], async () => {
        const r = await fetchCosts(q, today, paid, o);
        if (r.currency) currency = r.currency;
        return o.totals ? totalsByKey(r.rows, q.start) : r.rows;
      });

    const thisMonth = monthStart(dataThrough);
    const phase1 = [
      costs('costs', 'Reading 13 months of spend by service', { start: addMonths(thisMonth, -12), end: today, granularity: 'MONTHLY', groupBy: ['SERVICE'] }),
      costs('costs-daily', 'Reading 90 days of daily usage detail', { start: d90, end: today, granularity: 'DAILY', groupBy: ['SERVICE', 'USAGE_TYPE'] }),
      costs('costs-accounts', 'Reading daily spend by account', { start: d90, end: today, granularity: 'DAILY', groupBy: ['LINKED_ACCOUNT'] }),
      costs('costs-regions', 'Reading daily spend by region', { start: d90, end: today, granularity: 'DAILY', groupBy: ['REGION'] }),
      costs('costs-service-region', 'Mapping services to regions', { start: d30, end: today, granularity: 'MONTHLY', groupBy: ['SERVICE', 'REGION'] }, { totals: true }),
      // unfiltered on purpose: this is where credits and refunds are reported
      costs('costs-record-types', 'Reading credits, refunds and tax', { start: addMonths(thisMonth, -2), end: today, granularity: 'MONTHLY', groupBy: ['RECORD_TYPE'] }, { includeCredits: true }),
    ];

    // ── phase 2: everything else that only needs billing permissions ──
    const accountsTask = () =>
      section<AccountInfo[]>('accounts', 'Listing accounts', 'ce:GetDimensionValues', [], async () => {
        const out: AccountInfo[] = [];
        let NextPageToken: string | undefined;
        let pages = 0;
        do {
          const r = await ceSend(
            new GetDimensionValuesCommand({
              TimePeriod: { Start: addMonths(thisMonth, -12), End: today },
              Dimension: 'LINKED_ACCOUNT',
              Context: 'COST_AND_USAGE',
              NextPageToken,
            }),
          );
          for (const v of r.DimensionValues ?? []) {
            if (v.Value) out.push({ id: v.Value, name: v.Attributes?.description || v.Attributes?.Description || v.Value });
          }
          NextPageToken = r.NextPageToken;
        } while (NextPageToken && ++pages < 20);
        return out;
      });

    const tagsTask = () =>
      section<{ tagKeys: string[]; primaryTag: Snapshot['primaryTag'] }>('tags', 'Checking cost allocation tags', 'ce:GetTags', { tagKeys: [], primaryTag: null }, async () => {
        const r = await ceSend(new GetTagsCommand({ TimePeriod: { Start: d30, End: today } }));
        const tagKeys = orderTagKeys(r.Tags ?? [], 20);
        const key = pickPrimaryTagKey(tagKeys);
        if (!key) return { tagKeys, primaryTag: null };
        try {
          const { rows } = await fetchCosts({ start: d30, end: today, granularity: 'MONTHLY', groupBy: [`TAG:${key}`] }, today, paid);
          return { tagKeys, primaryTag: { key, rows: totalsByKey(rows, d30) } };
        } catch (e) {
          warnings.add(classifyError('tags', e, 'ce:GetCostAndUsage'));
          return { tagKeys, primaryTag: null };
        }
      });

    const forecastTask = () =>
      section<Forecast | null>('forecast', 'Asking AWS for a month-end forecast', 'ce:GetCostForecast', null, async () => {
        const end = addMonths(today, 1);
        if (diffDays(end, today) <= 1) return null; // last day of the month: nothing left to forecast
        try {
          const r = await ceSend(
            new GetCostForecastCommand({
              TimePeriod: { Start: today, End: end },
              Metric: FORECAST_METRIC[costBasis],
              // DAILY, not MONTHLY: a monthly forecast for a month already in progress is ambiguous
              // (is the figure the rest of the month, or the whole month?). Summing days from
              // today to month-end can only mean "what is still to come".
              Granularity: 'DAILY',
              PredictionIntervalLevel: 80,
              Filter: excludeCreditsExpression(),
            }),
          );
          const periods = (r.ForecastResultsByTime ?? []).filter((p) => {
            const d = p.TimePeriod?.Start?.slice(0, 10);
            return !d || (d >= today && d < end);
          });
          if (!periods.length && r.Total?.Amount === undefined) return null;
          const f: Forecast = { remaining: periods.length ? periods.reduce((a, p) => a + num(p.MeanValue), 0) : num(r.Total?.Amount) };
          if (periods.length && periods.every((p) => p.PredictionIntervalLowerBound !== undefined && p.PredictionIntervalUpperBound !== undefined)) {
            f.remainingLow = periods.reduce((a, p) => a + num(p.PredictionIntervalLowerBound), 0);
            f.remainingHigh = periods.reduce((a, p) => a + num(p.PredictionIntervalUpperBound), 0);
          }
          return f;
        } catch (e) {
          if (isDataUnavailable(e)) return null; // not enough history yet; the app falls back to a run-rate projection
          throw e;
        }
      });

    const budgetsTask = () =>
      section<Budget[]>('budgets', 'Reading budgets', 'budgets:ViewBudget', [], async () => {
        const client = new BudgetsClient(clientCfg);
        try {
          const out: Budget[] = [];
          let NextToken: string | undefined;
          let pages = 0;
          do {
            const r = await client.send(new DescribeBudgetsCommand({ AccountId: identity.accountId, MaxResults: 100, NextToken }));
            out.push(...(r.Budgets ?? []).map(mapBudget));
            NextToken = r.NextToken;
          } while (NextToken && ++pages < 20);
          return out;
        } finally {
          client.destroy();
        }
      });

    const anomaliesTask = () =>
      section<AwsAnomaly[]>('anomalies', 'Collecting AWS-detected anomalies', 'ce:GetAnomalies', [], async () => {
        const out: AwsAnomaly[] = [];
        let NextPageToken: string | undefined;
        let pages = 0;
        do {
          const r = await ceSend(new GetAnomaliesCommand({ DateInterval: { StartDate: d90, EndDate: today }, MaxResults: 100, NextPageToken }));
          out.push(...(r.Anomalies ?? []).map(mapAnomaly));
          NextPageToken = r.NextPageToken;
        } while (NextPageToken && ++pages < 20);
        return out;
      });

    const rightsizingTask = () =>
      section<RightsizingRec[]>('rightsizing', 'Collecting EC2 rightsizing recommendations', 'ce:GetRightsizingRecommendation', [], async () => {
        const out: RightsizingRec[] = [];
        let NextPageToken: string | undefined;
        let pages = 0;
        do {
          const r = await ceSend(
            new GetRightsizingRecommendationCommand({
              Service: 'AmazonEC2',
              Configuration: { RecommendationTarget: 'SAME_INSTANCE_FAMILY', BenefitsConsidered: true },
              PageSize: 100,
              NextPageToken,
            }),
          );
          for (const rec of r.RightsizingRecommendations ?? []) {
            const m = mapRightsizing(rec);
            if (m) out.push(m);
          }
          NextPageToken = r.NextPageToken;
        } while (NextPageToken && ++pages < 20);
        return out;
      });

    const hubTask = () =>
      section<HubRec[]>('cost-optimization-hub', 'Collecting Cost Optimization Hub recommendations', 'cost-optimization-hub:ListRecommendations', [], async () => {
        const client = new CostOptimizationHubClient(clientCfg);
        try {
          const out: HubRec[] = [];
          let nextToken: string | undefined;
          do {
            const r = await client.send(new ListRecommendationsCommand({ maxResults: 100, nextToken }));
            for (const item of r.items ?? []) out.push(mapHubRec(item, out.length));
            nextToken = r.nextToken;
          } while (nextToken && out.length < HUB_CAP);
          return out.slice(0, HUB_CAP);
        } finally {
          client.destroy();
        }
      });

    // ── commitments (several independent sub-sections) ──
    const serviceFilter = (service: string): Expression => ({ Dimensions: { Key: 'SERVICE', Values: [service] } });

    const spUtilizationTask = () =>
      section<SavingsPlan[]>('savings-plans', 'Checking Savings Plans utilization', 'ce:GetSavingsPlansUtilizationDetails', [], async () => {
        const out: SavingsPlan[] = [];
        let NextToken: string | undefined;
        let pages = 0;
        try {
          do {
            const r = await ceSend(new GetSavingsPlansUtilizationDetailsCommand({ TimePeriod: { Start: d30, End: today }, NextToken }));
            out.push(...(r.SavingsPlansUtilizationDetails ?? []).map((d) => mapSavingsPlan(d, 30)));
            NextToken = r.NextToken;
          } while (NextToken && ++pages < 20);
        } catch (e) {
          if (!isDataUnavailable(e)) throw e; // DataUnavailable simply means the account owns no Savings Plans
        }
        return out;
      });

    interface RiUtil {
      reservations: Reservation[];
      rates: Map<string, number>;
    }
    const riUtilizationTask = (services: string[]) => () =>
      section<RiUtil>('reservations', 'Checking reservation utilization', 'ce:GetReservationUtilization', { reservations: [], rates: new Map() }, async () => {
        const res: RiUtil = { reservations: [], rates: new Map() };
        for (const service of services) {
          let NextPageToken: string | undefined;
          let pages = 0;
          let odValue = 0;
          let usedHours = 0;
          try {
            do {
              const r = await ceSend(
                new GetReservationUtilizationCommand({
                  TimePeriod: { Start: d30, End: today },
                  GroupBy: [{ Type: 'DIMENSION', Key: 'SUBSCRIPTION_ID' }],
                  Filter: serviceFilter(service),
                  NextPageToken,
                }),
              );
              for (const t of r.UtilizationsByTime ?? []) {
                for (const g of t.Groups ?? []) {
                  res.reservations.push(mapReservation(g, service));
                  odValue += num(g.Utilization?.OnDemandCostOfRIHoursUsed);
                  usedHours += num(g.Utilization?.TotalActualHours);
                }
              }
              NextPageToken = r.NextPageToken;
            } while (NextPageToken && ++pages < 20);
          } catch (e) {
            if (!isDataUnavailable(e)) throw e; // no reservations for this service
          }
          // average on-demand value of one reserved hour, used to price RI-covered hours in the coverage series
          if (usedHours > 0 && odValue > 0) res.rates.set(service, odValue / usedHours);
        }
        return res;
      });

    interface SpCov {
      daily: CoveragePoint[];
      byService: SpServiceCoverage[];
    }
    const spCoverageTask = () =>
      section<SpCov>('savings-plans-coverage', 'Measuring Savings Plans coverage', 'ce:GetSavingsPlansCoverage', { daily: [], byService: [] }, async () => {
        const res: SpCov = { daily: [], byService: [] };
        try {
          let NextToken: string | undefined;
          let pages = 0;
          do {
            const r = await ceSend(new GetSavingsPlansCoverageCommand({ TimePeriod: { Start: d90, End: today }, Granularity: 'DAILY', NextToken }));
            for (const c of r.SavingsPlansCoverages ?? []) {
              const date = c.TimePeriod?.Start?.slice(0, 10);
              if (date) res.daily.push({ date, covered: num(c.Coverage?.SpendCoveredBySavingsPlans), onDemand: num(c.Coverage?.OnDemandCost) });
            }
            NextToken = r.NextToken;
          } while (NextToken && ++pages < 20);

          const by = new Map<string, SpServiceCoverage>();
          let groupToken: string | undefined;
          pages = 0;
          do {
            const r: GetSavingsPlansCoverageCommandOutput = await ceSend(
              new GetSavingsPlansCoverageCommand({
                TimePeriod: { Start: d30, End: today },
                Granularity: 'MONTHLY',
                GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
                NextToken: groupToken,
              }),
            );
            for (const c of r.SavingsPlansCoverages ?? []) {
              const service = c.Attributes?.SERVICE ?? c.Attributes?.service ?? Object.values(c.Attributes ?? {})[0];
              if (!service) continue;
              const t = by.get(service) ?? { service, covered: 0, onDemand: 0 };
              t.covered += num(c.Coverage?.SpendCoveredBySavingsPlans);
              t.onDemand += num(c.Coverage?.OnDemandCost);
              by.set(service, t);
            }
            groupToken = r.NextToken;
          } while (groupToken && ++pages < 20);
          res.byService = [...by.values()];
        } catch (e) {
          if (!isDataUnavailable(e)) throw e; // no SP-eligible usage at all
        }
        return res;
      });

    const riCoverageTask = (services: string[]) => () =>
      section<RiCoverageDay[]>('reservation-coverage', 'Measuring reservation coverage', 'ce:GetReservationCoverage', [], async () => {
        const out: RiCoverageDay[] = [];
        for (const service of services) {
          let NextPageToken: string | undefined;
          let pages = 0;
          try {
            do {
              const r = await ceSend(
                new GetReservationCoverageCommand({ TimePeriod: { Start: d90, End: today }, Granularity: 'DAILY', Filter: serviceFilter(service), NextPageToken }),
              );
              for (const c of r.CoveragesByTime ?? []) {
                const date = c.TimePeriod?.Start?.slice(0, 10);
                const h = c.Total?.CoverageHours;
                if (!date || !c.Total) continue;
                const day: RiCoverageDay = {
                  service,
                  date,
                  reservedHours: num(h?.ReservedHours),
                  onDemandHours: num(h?.OnDemandHours),
                  totalHours: num(h?.TotalRunningHours),
                  onDemandCost: num(c.Total.CoverageCost?.OnDemandCost),
                };
                if (day.totalHours > 0 || day.onDemandCost > 0 || day.reservedHours > 0) out.push(day);
              }
              NextPageToken = r.NextPageToken;
            } while (NextPageToken && ++pages < 20);
          } catch (e) {
            if (!isDataUnavailable(e)) throw e;
          }
        }
        return out;
      });

    const SP_TYPES = Object.values(SupportedSavingsPlansType) as SupportedSavingsPlansType[];
    const spRecCombos: { type: SupportedSavingsPlansType; term: TermInYears; payment: PaymentOption }[] = [];
    for (const type of ['COMPUTE_SP', 'EC2_INSTANCE_SP', 'SAGEMAKER_SP', 'DATABASE_SP'] as SupportedSavingsPlansType[]) {
      if (!SP_TYPES.includes(type)) continue; // older SDKs do not know Database Savings Plans
      for (const term of ['ONE_YEAR', 'THREE_YEARS'] as TermInYears[]) spRecCombos.push({ type, term, payment: 'NO_UPFRONT' });
      if (type === 'COMPUTE_SP') spRecCombos.push({ type, term: 'ONE_YEAR', payment: 'ALL_UPFRONT' });
    }
    const spRecsTask = () =>
      section<SavingsPlanRecommendation[]>('savings-plans-recommendations', 'Pricing Savings Plans options', 'ce:GetSavingsPlansPurchaseRecommendation', [], async () => {
        const results = await pool(
          spRecCombos.map((c) => async (): Promise<SavingsPlanRecommendation | null> => {
            try {
              let rec: SavingsPlansPurchaseRecommendation | undefined;
              const details: SavingsPlansPurchaseRecommendationDetail[] = [];
              let NextPageToken: string | undefined;
              let pages = 0;
              do {
                const r = await ceSend(
                  new GetSavingsPlansPurchaseRecommendationCommand({
                    SavingsPlansType: c.type,
                    TermInYears: c.term,
                    PaymentOption: c.payment,
                    LookbackPeriodInDays: 'THIRTY_DAYS',
                    AccountScope: 'PAYER',
                    PageSize: 100,
                    NextPageToken,
                  }),
                );
                rec ??= r.SavingsPlansPurchaseRecommendation;
                details.push(...(r.SavingsPlansPurchaseRecommendation?.SavingsPlansPurchaseRecommendationDetails ?? []));
                NextPageToken = r.NextPageToken;
              } while (NextPageToken && ++pages < 5);
              return mapSpRecommendation(rec, details, { type: c.type, term: c.term, payment: c.payment, lookback: 'THIRTY_DAYS' });
            } catch (e) {
              // a plan type that is not offered to this account/partition is not worth a warning
              if (!isValidation(e) && !isDataUnavailable(e)) warnings.add(classifyError('savings-plans-recommendations', e, 'ce:GetSavingsPlansPurchaseRecommendation'));
              return null;
            }
          }),
          2,
        );
        return results.filter((r): r is SavingsPlanRecommendation => r !== null);
      });

    const riRecsTask = (services: { cost: string; rec: string }[]) => () =>
      section<ReservationRecommendation[]>('reservation-recommendations', 'Pricing reservation options', 'ce:GetReservationPurchaseRecommendation', [], async () => {
        const fetchAll = async (service: string, payment: PaymentOption): Promise<ReservationPurchaseRecommendation[]> => {
          const recs: ReservationPurchaseRecommendation[] = [];
          let NextPageToken: string | undefined;
          let pages = 0;
          do {
            const r = await ceSend(
              new GetReservationPurchaseRecommendationCommand({
                Service: service,
                TermInYears: 'ONE_YEAR',
                PaymentOption: payment,
                LookbackPeriodInDays: 'THIRTY_DAYS',
                AccountScope: 'PAYER',
                PageSize: 100,
                NextPageToken,
              }),
            );
            recs.push(...(r.Recommendations ?? []));
            NextPageToken = r.NextPageToken;
          } while (NextPageToken && ++pages < 10);
          return recs;
        };
        const results = await pool(
          services.map((s) => async (): Promise<ReservationRecommendation[]> => {
            try {
              let recs: ReservationPurchaseRecommendation[];
              try {
                recs = await fetchAll(s.rec, 'NO_UPFRONT');
              } catch (e) {
                if (!isValidation(e)) throw e;
                recs = await fetchAll(s.rec, 'PARTIAL_UPFRONT'); // some services do not sell No Upfront reservations
              }
              return mapRiRecommendations(s.cost, recs);
            } catch (e) {
              if (!isValidation(e) && !isDataUnavailable(e)) warnings.add(classifyError('reservation-recommendations', e, 'ce:GetReservationPurchaseRecommendation'));
              return [];
            }
          }),
          2,
        );
        return results.flat().sort((a, b) => b.estimatedMonthlySavings - a.estimatedMonthlySavings);
      });

    // ── run ──
    const PHASE2_STEPS = 13;
    total = phase1.length + PHASE2_STEPS + (settings.deepScan ? 1 : 0);
    report('Connecting to Cost Explorer');

    const [monthlyByService, dailyByServiceUsage, dailyByAccount, dailyByRegion, recentByServiceRegion, monthlyByRecordType] = await pool(phase1, 3);

    // Without any cost data there is nothing to analyse: fail the scan with the reason instead of
    // returning (and caching) an empty snapshot.
    if (!monthlyByService.length && !dailyByServiceUsage.length) {
      const w = warnings.list.find((x) => x.section.startsWith('costs'));
      if (w) {
        throw new Error(
          w.missingPermission
            ? `These credentials cannot read Cost Explorer (${w.message}). Attach the CloudPennies billing policy and try again.`
            : `Could not read cost data. ${w.message}`,
        );
      }
    }

    // Only ask the reservation APIs about services the account actually pays for (each call costs $0.01).
    // If the cost data could not be read, ask about all of them.
    const spend = new Map<string, number>();
    for (const r of recentByServiceRegion) spend.set(r.keys[0], (spend.get(r.keys[0]) ?? 0) + Math.abs(r.cost));
    const used = (s: { cost: string }) => recentByServiceRegion.length === 0 || (spend.get(s.cost) ?? 0) > 0;
    const riUtilServices = RI_UTILIZATION_SERVICES.filter(used).map((s) => s.cost);
    const riRecServices = RI_SERVICES.filter((s): s is { cost: string; rec: string; label: string } => !!s.rec && used(s));

    const phase2 = await pool<unknown>(
      [
        accountsTask,
        tagsTask,
        forecastTask,
        budgetsTask,
        anomaliesTask,
        spUtilizationTask,
        riUtilizationTask(riUtilServices),
        spCoverageTask,
        riCoverageTask(riUtilServices),
        spRecsTask,
        riRecsTask(riRecServices),
        rightsizingTask,
        hubTask,
      ],
      3,
    );
    const accounts = phase2[0] as AccountInfo[];
    const tags = phase2[1] as { tagKeys: string[]; primaryTag: Snapshot['primaryTag'] };
    const forecast = phase2[2] as Forecast | null;
    const budgets = phase2[3] as Budget[];
    const awsAnomalies = phase2[4] as AwsAnomaly[];
    const savingsPlans = phase2[5] as SavingsPlan[];
    const riUtil = phase2[6] as RiUtil;
    const spCov = phase2[7] as SpCov;
    const riCov = phase2[8] as RiCoverageDay[];
    const spRecommendations = phase2[9] as SavingsPlanRecommendation[];
    const riRecommendations = phase2[10] as ReservationRecommendation[];
    const rightsizing = phase2[11] as RightsizingRec[];
    const hubRecommendations = phase2[12] as HubRec[];

    const commitments = emptyCommitments();
    commitments.savingsPlans = savingsPlans;
    commitments.reservations = riUtil.reservations;
    const spServices = new Set(spCov.byService.filter((s) => s.covered + s.onDemand > 0).map((s) => s.service));
    if (spCov.daily.length) spServices.add(EC2_SERVICE); // EC2 is always Savings Plans eligible
    commitments.coverage = combineCoverage(spCov.daily, riCov, riUtil.rates, spServices);
    commitments.coverageByService = coverageByService(spCov.byService, riCov.filter((d) => d.date >= d30));
    commitments.totals = commitmentTotals(savingsPlans, riUtil.reservations, commitments.coverage, d30);
    commitments.spRecommendations = spRecommendations;
    commitments.riRecommendations = riRecommendations;

    // ── phase 3: optional resource scan ──
    let resources: ResourceFindings | null = null;
    let regionsScanned: string[] = [];
    if (settings.deepScan) {
      regionsScanned = selectRegions(recentByServiceRegion, { minSpend: 1, cap: 12 });
      total += Math.max(0, regionsScanned.length - 1);
      resources = emptyFindings();
      if (!regionsScanned.length) {
        done++;
        report('No regions with spend to inspect');
      }
      const parts = await pool(
        regionsScanned.map((region) => () =>
          section<ResourceFindings>('resources', `Inspecting resources in ${region}`, undefined, emptyFindings(), () =>
            scanRegion(region, credentials, warnings, startedAt),
          ),
        ),
        3,
      );
      for (const p of parts) mergeFindings(resources, p);
    }

    const self = accounts.find((a) => a.id === identity.accountId);
    const snapshot: Snapshot = {
      meta: {
        mode: 'live',
        generatedAt: now().toISOString(),
        today,
        dataThrough,
        accountId: identity.accountId,
        accountLabel: self && self.name !== self.id ? self.name : `Account ${identity.accountId}`,
        ...(identity.arn ? { identityArn: identity.arn } : {}),
        currency,
        costBasis,
        ceRequests,
        deepScan: settings.deepScan,
        regionsScanned,
        warnings: warnings.list,
      },
      accounts,
      monthlyByService,
      dailyByServiceUsage,
      dailyByAccount,
      dailyByRegion,
      recentByServiceRegion,
      monthlyByRecordType,
      tagKeys: tags.tagKeys,
      primaryTag: tags.primaryTag,
      forecast,
      budgets,
      awsAnomalies,
      commitments,
      rightsizing,
      hubRecommendations,
      resources,
    };

    done = total;
    report('Saving results');
    try {
      await writeJsonFile(snapshotFile(cacheDir, identity.accountId), snapshot);
    } catch {
      /* the snapshot is still returned even if it cannot be cached */
    }
    void pruneCache(cacheDir, SETTLED_TTL_MS);
    report('Done');
    return snapshot;
  }

  return { query, scan };
}

/** Last cached scan for an account, if any (and if it still matches the current Snapshot shape). */
export async function loadCachedSnapshot(cacheDir: string, accountId: string): Promise<Snapshot | null> {
  const s = await readJsonFile<Snapshot>(snapshotFile(cacheDir, accountId));
  if (!s || typeof s !== 'object' || !s.meta || s.meta.accountId !== accountId || !Array.isArray(s.monthlyByService) || !s.commitments) return null;
  return s;
}
