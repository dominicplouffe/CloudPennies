// "Can I trust these numbers?" — self-checks on a snapshot, plus what the user needs to
// compare CloudPennies against the AWS console.
//
// The scan fetches the same spend several times, sliced differently (by service, by usage
// type, by account, by region). Those totals must agree. When they do not, something in the
// collection is wrong and the user should know before acting on any figure.

import type { CostRow, Snapshot } from './types';
import { addDays, addMonths, daysInMonth, diffDays, median, money, monthName, monthStart, sum } from './util';

export interface Check {
  id: string;
  label: string;
  status: 'pass' | 'warn' | 'fail' | 'info';
  detail: string;
}

export interface Reconciliation {
  checks: Check[];
  /** the figures to compare with Cost Explorer */
  compare: { label: string; value: number; start: string; endInclusive: string }[];
  /** opens Cost Explorer on the previous full month with the same filters CloudPennies uses */
  consoleUrl: string;
  /** true when the most recent day looks incomplete (AWS billing data lags by up to a day) */
  lastDayPartial: boolean;
}

const total = (rows: CostRow[], from: string, toExclusive: string) => sum(rows.filter((r) => r.date >= from && r.date < toExclusive).map((r) => r.cost));

const AGGREGATE: Record<string, string> = {
  UnblendedCost: 'unBlendedCost',
  NetUnblendedCost: 'netUnblendedCost',
  AmortizedCost: 'amortizedCost',
  NetAmortizedCost: 'netAmortizedCost',
};

/** daily totals of the 90-day series, as [date, cost] sorted by date */
export function dailyTotals(snap: Snapshot): [string, number][] {
  const m = new Map<string, number>();
  for (const r of snap.dailyByServiceUsage) m.set(r.date, (m.get(r.date) ?? 0) + r.cost);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Is the last day of data clearly incomplete compared with the days before it? */
export function isLastDayPartial(snap: Snapshot): boolean {
  if (snap.meta.mode !== 'live') return false;
  const days = dailyTotals(snap);
  if (days.length < 10) return false;
  const [lastDate, last] = days[days.length - 1];
  if (lastDate !== snap.meta.dataThrough) return false;
  const typical = median(days.slice(-8, -1).map(([, c]) => c));
  return typical > 1 && last < typical * 0.6;
}

export function reconcile(snap: Snapshot): Reconciliation {
  const checks: Check[] = [];
  const through = snap.meta.dataThrough;
  const thisMonth = monthStart(through);
  const prevMonth = addMonths(thisMonth, -1);
  const prevName = monthName(prevMonth);
  const tol = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, Math.max(Math.abs(a), Math.abs(b)) * 0.005);
  const pctOff = (a: number, b: number) => (b ? `${(((a - b) / b) * 100).toFixed(1)}%` : 'n/a');

  // 1. The previous full month, four ways
  const byUsage = total(snap.dailyByServiceUsage, prevMonth, thisMonth);
  const byAccount = total(snap.dailyByAccount, prevMonth, thisMonth);
  const byRegion = total(snap.dailyByRegion, prevMonth, thisMonth);
  const byMonth = sum(snap.monthlyByService.filter((r) => r.date.slice(0, 7) === prevMonth.slice(0, 7)).map((r) => r.cost));
  const firstDaily = dailyTotals(snap)[0]?.[0];
  const dailyCoversPrev = !!firstDaily && firstDaily <= prevMonth;

  if (!snap.dailyByServiceUsage.length) {
    checks.push({ id: 'data', label: 'Cost data', status: 'fail', detail: 'The scan returned no daily cost data. Check that Cost Explorer is enabled and the key has ce:GetCostAndUsage.' });
  } else if (dailyCoversPrev && byMonth > 0) {
    const slices: [string, number][] = [['by usage type', byUsage]];
    if (snap.dailyByAccount.length) slices.push(['by account', byAccount]);
    if (snap.dailyByRegion.length) slices.push(['by region', byRegion]);
    const bad = slices.filter(([, v]) => !tol(v, byMonth));
    checks.push({
      id: 'slices',
      label: `${prevName} adds up the same every way it is sliced`,
      status: bad.length ? 'fail' : 'pass',
      detail: bad.length
        ? `${prevName} is ${money(byMonth)} by service, but ${bad.map(([n, v]) => `${money(v)} ${n} (${pctOff(v, byMonth)})`).join(' and ')}. The totals should match; treat figures with caution and send the diagnostics to the developer.`
        : `${money(byMonth)} whether summed by service, usage type${snap.dailyByAccount.length ? ', account' : ''}${snap.dailyByRegion.length ? ' or region' : ''}.`,
    });
  }

  // 2. Charge types: usage + fees + tax should equal the total (credits/refunds are excluded everywhere)
  const recPrev = snap.monthlyByRecordType.filter((r) => r.date.slice(0, 7) === prevMonth.slice(0, 7));
  if (recPrev.length && byMonth > 0) {
    const gross = sum(recPrev.filter((r) => !/^(credit|refund)$/i.test(r.keys[0] ?? '')).map((r) => r.cost));
    const credits = sum(recPrev.filter((r) => /^(credit|refund)$/i.test(r.keys[0] ?? '')).map((r) => r.cost));
    checks.push({
      id: 'record-types',
      label: 'Charge types add up to the total',
      status: tol(gross, byMonth) ? 'pass' : 'warn',
      detail: tol(gross, byMonth)
        ? `${prevName}: ${money(gross)} before credits${credits < -0.5 ? `, ${money(-credits)} of credits and refunds applied on top (so the invoice was about ${money(gross + credits)})` : ''}.`
        : `${prevName} by charge type is ${money(gross)} but by service is ${money(byMonth)} (${pctOff(gross, byMonth)}).`,
    });
  }

  // 3. Freshness
  const lastDayPartial = isLastDayPartial(snap);
  const age = diffDays(snap.meta.today, through);
  checks.push({
    id: 'fresh',
    label: 'Data is current',
    status: lastDayPartial ? 'info' : age > 2 ? 'warn' : 'pass',
    detail: lastDayPartial
      ? `AWS has not finished reporting ${through} yet, so that day is left out of trends and month-to-date. This is normal: billing data settles about a day behind.`
      : `Cost data runs through ${through}. AWS can still revise the most recent 24–48 hours.`,
  });

  // 4. Forecast sanity
  if (snap.forecast) {
    const days = dailyTotals(snap);
    const run = median(days.slice(-7).map(([, c]) => c));
    const remainingDays = daysInMonth(thisMonth) - (diffDays(through, thisMonth) + 1);
    const expected = run * remainingDays;
    const ok = expected <= 0 || (snap.forecast.remaining <= expected * 2 && snap.forecast.remaining >= expected * 0.4);
    checks.push({
      id: 'forecast',
      label: "AWS's forecast is consistent with recent spending",
      status: ok ? 'pass' : 'warn',
      detail: ok
        ? `AWS expects ${money(snap.forecast.remaining)} more this month; the recent daily rate implies about ${money(expected)}.`
        : `AWS forecasts ${money(snap.forecast.remaining)} for the rest of the month but the recent daily rate implies about ${money(expected)}. CloudPennies is using the daily rate for its projection.`,
    });
  }

  // 5. What the scan could not read
  if (snap.meta.warnings.length)
    checks.push({ id: 'warnings', label: 'Parts of the scan were skipped', status: 'info', detail: `${snap.meta.warnings.length} section${snap.meta.warnings.length === 1 ? '' : 's'} could not be read (${[...new Set(snap.meta.warnings.map((w) => w.section))].join(', ')}). Findings that depend on them are missing, but the cost figures are unaffected.` });

  const mtdEnd = lastDayPartial ? addDays(through, -1) : through;
  const compare = [
    ...(byMonth > 0 ? [{ label: `${prevName} (full month)`, value: byMonth, start: prevMonth, endInclusive: addDays(thisMonth, -1) }] : []),
    { label: `${monthName(thisMonth)} 1 – ${Number(mtdEnd.slice(8))}`, value: total(snap.dailyByServiceUsage, thisMonth, addDays(mtdEnd, 1)), start: thisMonth, endInclusive: mtdEnd },
  ];

  const filter = encodeURIComponent(
    JSON.stringify([{ dimension: { id: 'RecordTypeV2', displayValue: 'Charge type' }, operator: 'EXCLUDES', values: [{ value: 'Refund', displayValue: 'Refund' }, { value: 'Credit', displayValue: 'Credit' }] }]),
  );
  const consoleUrl = `https://us-east-1.console.aws.amazon.com/costmanagement/home#/cost-explorer?chartStyle=STACK&costAggregate=${AGGREGATE[snap.meta.costBasis] ?? 'unBlendedCost'}&startDate=${prevMonth}&endDate=${addDays(thisMonth, -1)}&granularity=Monthly&groupBy=%5B%22Service%22%5D&historicalRelativeRange=CUSTOM&excludeForecasting=true&filter=${filter}`;

  return { checks, compare, consoleUrl, lastDayPartial };
}

/** A redacted summary safe to paste into a bug report: totals and counts, no resource names or ids. */
export function diagnostics(snap: Snapshot): string {
  const r = reconcile(snap);
  const days = dailyTotals(snap);
  const c = snap.commitments;
  const out = {
    app: 'CloudPennies',
    mode: snap.meta.mode,
    generatedAt: snap.meta.generatedAt,
    today: snap.meta.today,
    dataThrough: snap.meta.dataThrough,
    costBasis: snap.meta.costBasis,
    currency: snap.meta.currency,
    ceRequests: snap.meta.ceRequests,
    accounts: snap.accounts.length,
    accountsScanned: snap.meta.accountsScanned?.length ?? null,
    regionsScanned: snap.meta.regionsScanned.length,
    rows: {
      monthlyByService: snap.monthlyByService.length,
      dailyByServiceUsage: snap.dailyByServiceUsage.length,
      dailyByAccount: snap.dailyByAccount.length,
      dailyByRegion: snap.dailyByRegion.length,
      recordTypes: [...new Set(snap.monthlyByRecordType.map((x) => x.keys[0]))],
    },
    monthlyTotals: Object.fromEntries(
      [...snap.monthlyByService.reduce((m, x) => m.set(x.date.slice(0, 7), (m.get(x.date.slice(0, 7)) ?? 0) + x.cost), new Map<string, number>())].sort().map(([k, v]) => [k, Math.round(v)]),
    ),
    last10Days: days.slice(-10).map(([d, v]) => [d, Math.round(v)]),
    forecast: snap.forecast ? { remaining: Math.round(snap.forecast.remaining) } : null,
    budgets: snap.budgets.length,
    awsAnomalies: snap.awsAnomalies.length,
    commitments: {
      savingsPlans: c.savingsPlans.length,
      reservations: c.reservations.length,
      coveragePoints: c.coverage.length,
      coverageByService: c.coverageByService.length,
      spRecommendations: c.spRecommendations.length,
      riRecommendations: c.riRecommendations.length,
      totals: Object.fromEntries(Object.entries(c.totals).map(([k, v]) => [k, Math.round(v)])),
    },
    rightsizing: snap.rightsizing.length,
    hubRecommendations: snap.hubRecommendations.length,
    resources: snap.resources
      ? {
          logGroups: snap.resources.logGroups.length,
          dashboards: snap.resources.dashboards.length,
          dashboardsWithViewData: snap.resources.dashboards.filter((d) => d.lastViewed !== undefined).length,
          alarms: snap.resources.alarms,
          volumes: snap.resources.volumes.length,
          addresses: snap.resources.addresses.length,
          loadBalancers: snap.resources.loadBalancers.length,
          stoppedInstances: snap.resources.stoppedInstances.length,
        }
      : null,
    warnings: snap.meta.warnings.map((w) => ({ section: w.section, message: w.message.replace(/\b\d{12}\b/g, '<account>'), missingPermission: w.missingPermission })),
    checks: r.checks.map((x) => ({ id: x.id, status: x.status, detail: x.detail })),
  };
  return JSON.stringify(out, null, 2);
}
