// What-if modelling for a Savings Plan purchase.
//
// AWS's recommendation is a single number. This answers the questions that number hides:
// how much do I save at other commitment levels, how much of it would sit unused on a quiet
// day, how much can usage fall before the plan costs more than it saves, and how much am I
// locking in.
//
// How it works. A Savings Plan is a promise to spend C dollars per hour at discounted rates.
// With a discount d, C dollars of plan spend covers C / (1 - d) dollars of on-demand usage.
// For each day of history we take the eligible on-demand spend OD and compute:
//   covered   = min(OD, 24·C / (1 - d))        on-demand usage the plan absorbs
//   planCost  = 24·C                           paid whether used or not
//   saving    = covered - planCost             negative on days with too little usage
// Limits, stated in the UI: history is daily, while plans apply hour by hour, so a workload
// that swings a lot within a day will use a plan less fully than this shows; and the discount
// is an average taken from AWS's own recommendation, while the real rate differs by instance
// family and region.

import type { Snapshot } from './types';
import { diffDays, sum } from './util';

export interface PlanOption {
  termYears: 1 | 3;
  payment: 'No Upfront' | 'Partial Upfront' | 'All Upfront';
  /** average discount vs on-demand, 0..1 */
  discount: number;
  /** where the discount came from */
  source: 'aws' | 'typical';
}

export interface ModelInputs {
  /** eligible on-demand spend per day ($), oldest first */
  daily: number[];
  /** discount 0..1 */
  discount: number;
  /** commitment in $/hour */
  hourly: number;
  /** model usage falling by this fraction (0..0.9) */
  usageDrop?: number;
}

export interface ModelResult {
  hourly: number;
  /** $/month figures are 30.4-day months */
  monthlyPlanCost: number;
  monthlySavings: number;
  /** on-demand spend still uncovered */
  monthlyOnDemandLeft: number;
  /** commitment paid for but not used */
  monthlyUnused: number;
  /** share of the commitment that is used, 0..100 */
  utilizationPct: number;
  /** share of eligible usage covered, 0..100 */
  coveragePct: number;
  /** days in the history on which the plan would not have been fully used */
  daysNotFullyUsed: number;
  days: number;
}

const MONTH_DAYS = 30.4;

export function model({ daily, discount, hourly, usageDrop = 0 }: ModelInputs): ModelResult {
  const d = Math.min(0.95, Math.max(0, discount));
  const planDay = 24 * hourly;
  const capacity = planDay / (1 - d); // on-demand $ the plan can absorb per day
  let covered = 0;
  let total = 0;
  let unused = 0;
  let notFull = 0;
  for (const raw of daily) {
    const od = Math.max(0, raw) * (1 - usageDrop);
    const c = Math.min(od, capacity);
    covered += c;
    total += od;
    const used = c * (1 - d);
    unused += planDay - used;
    if (planDay - used > planDay * 0.005) notFull++;
  }
  const n = Math.max(1, daily.length);
  const perMonth = (x: number) => (x / n) * MONTH_DAYS;
  const planTotal = planDay * n;
  return {
    hourly,
    monthlyPlanCost: perMonth(planTotal),
    monthlySavings: perMonth(covered - planTotal),
    monthlyOnDemandLeft: perMonth(total - covered),
    monthlyUnused: perMonth(unused),
    utilizationPct: planTotal > 0 ? ((planTotal - unused) / planTotal) * 100 : 0,
    coveragePct: total > 0 ? (covered / total) * 100 : 0,
    daysNotFullyUsed: hourly > 0 ? notFull : 0,
    days: daily.length,
  };
}

/** Commitment ($/hour) that is fully used on a day with `od` dollars of on-demand usage */
export const hourlyFor = (od: number, discount: number) => (od * (1 - discount)) / 24;

export interface Presets {
  /** fully used even on the quietest day in the history */
  safe: number;
  /** the commitment with the highest savings over the history */
  best: number;
  /** AWS's own recommendation for this option, when it gave one */
  aws: number | null;
  /** the largest commitment worth plotting */
  max: number;
}

export function presets(daily: number[], discount: number, awsHourly: number | null): Presets {
  const sorted = [...daily].filter((x) => x > 0).sort((a, b) => a - b);
  if (!sorted.length) return { safe: 0, best: 0, aws: awsHourly, max: Math.max(1, awsHourly ?? 1) };
  const max = hourlyFor(sorted[sorted.length - 1], discount);
  // Savings as a function of commitment is concave and piecewise linear, with kinks at each
  // day's usage level, so the optimum is at one of those levels.
  let best = 0;
  let bestSaving = 0;
  for (const od of sorted) {
    const h = hourlyFor(od, discount);
    const s = model({ daily, discount, hourly: h }).monthlySavings;
    if (s > bestSaving + 1e-9) {
      bestSaving = s;
      best = h;
    }
  }
  return { safe: hourlyFor(sorted[0], discount), best, aws: awsHourly, max: Math.max(max, awsHourly ?? 0) * 1.08 };
}

/** Savings at evenly spaced commitment levels, for the curve */
export function curve(daily: number[], discount: number, maxHourly: number, steps = 60): { hourly: number; savings: number; utilizationPct: number }[] {
  const out = [];
  for (let i = 0; i <= steps; i++) {
    const hourly = (maxHourly * i) / steps;
    const r = model({ daily, discount, hourly });
    out.push({ hourly, savings: r.monthlySavings, utilizationPct: r.utilizationPct });
  }
  return out;
}

/**
 * How far usage can fall (as a fraction) before the plan saves nothing compared with paying
 * on-demand. 1 means it never breaks even badly within the range tested (usage could vanish
 * almost entirely); a small number means the plan is fragile.
 */
export function breakEvenDrop(daily: number[], discount: number, hourly: number): number {
  if (hourly <= 0) return 1;
  if (model({ daily, discount, hourly }).monthlySavings <= 0) return 0;
  let lo = 0;
  let hi = 0.99;
  if (model({ daily, discount, hourly, usageDrop: hi }).monthlySavings > 0) return 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (model({ daily, discount, hourly, usageDrop: mid }).monthlySavings > 0) lo = mid;
    else hi = mid;
  }
  return lo;
}

const TYPICAL: Record<string, number> = {
  '1|No Upfront': 0.27,
  '1|Partial Upfront': 0.29,
  '1|All Upfront': 0.31,
  '3|No Upfront': 0.45,
  '3|Partial Upfront': 0.48,
  '3|All Upfront': 0.5,
};

export interface PlannerData {
  /** eligible on-demand compute spend per day, oldest first */
  daily: number[];
  dates: string[];
  /** on-demand spend per month the plan could address */
  monthlyEligible: number;
  options: PlanOption[];
  /** AWS's recommended hourly commitment per option key (`${term}|${payment}`) */
  awsHourly: Record<string, number>;
  /** existing Compute/EC2 plans that end within a year: their coverage will come back as on-demand */
  expiring: { id: string; label: string; daysLeft: number; hourly: number; dailyOnDemand: number }[];
  /** false when there is not enough history to model anything */
  usable: boolean;
}

export const optionKey = (o: Pick<PlanOption, 'termYears' | 'payment'>) => `${o.termYears}|${o.payment}`;

/** Pull what the planner needs out of a snapshot. */
export function plannerData(snap: Snapshot): PlannerData {
  const c = snap.commitments;
  const cov = c.coverage;
  // The daily coverage series mixes Savings Plan and reservation-eligible spend. Scale it so
  // the last 30 days equal the spend Savings Plans can actually address.
  const last30 = sum(cov.slice(-30).map((p) => p.onDemand));
  const spEligible30 = sum(c.coverageByService.filter((s) => s.kind === 'SP').map((s) => s.onDemandCost));
  const recEligible = c.spRecommendations.find((r) => r.type === 'Compute')?.currentMonthlyOnDemand ?? 0;
  const eligible30 = spEligible30 > 0 ? spEligible30 : recEligible > 0 ? recEligible : last30;
  const scale = last30 > 0 ? eligible30 / last30 : 0;
  const daily = cov.map((p) => Math.max(0, p.onDemand) * scale);

  const options: PlanOption[] = [];
  const awsHourly: Record<string, number> = {};
  for (const termYears of [1, 3] as const)
    for (const payment of ['No Upfront', 'Partial Upfront', 'All Upfront'] as const) {
      const key = `${termYears}|${payment}`;
      const rec = c.spRecommendations.find((r) => r.type === 'Compute' && r.termYears === termYears && r.paymentOption.toLowerCase() === payment.toLowerCase());
      if (rec && rec.estimatedSavingsPct > 0) {
        // AWS reports savings as a share of the on-demand spend the plan would cover. Derive
        // the discount from its own numbers so the model agrees with it at the recommended level.
        const planMonthly = rec.hourlyCommitment * 730;
        const coveredOd = planMonthly + rec.estimatedMonthlySavings;
        const discount = coveredOd > 0 ? rec.estimatedMonthlySavings / coveredOd : rec.estimatedSavingsPct / 100;
        options.push({ termYears, payment, discount: Math.min(0.72, Math.max(0.05, discount)), source: 'aws' });
        awsHourly[key] = rec.hourlyCommitment;
      } else options.push({ termYears, payment, discount: TYPICAL[key], source: 'typical' });
    }

  const expiring = c.savingsPlans
    .filter((sp) => /compute|ec2/i.test(sp.type))
    .map((sp) => ({ sp, daysLeft: diffDays(sp.end, snap.meta.today) }))
    .filter((x) => x.daysLeft >= 0 && x.daysLeft <= 365)
    .map(({ sp, daysLeft }) => ({
      id: sp.id,
      label: `${sp.type === 'EC2Instance' ? 'EC2 Instance' : sp.type} Savings Plan (\$${sp.hourlyCommitment.toFixed(2)}/hour)`,
      daysLeft,
      hourly: sp.hourlyCommitment,
      // what it covers today, valued at on-demand rates, per day
      dailyOnDemand: Math.max(0, sp.usedCommitment + sp.netSavings) / 30,
    }));

  return { daily, dates: cov.map((p) => p.date), monthlyEligible: (sum(daily) / Math.max(1, daily.length)) * MONTH_DAYS, options, awsHourly, expiring, usable: daily.length >= 14 && sum(daily) > 1 };
}
