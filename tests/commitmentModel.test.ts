import { describe, expect, it } from 'vitest';
import { breakEvenDrop, curve, hourlyFor, model, optionKey, plannerData, presets } from '../src/core/commitmentModel';
import { demoSnapshot } from '../src/core/demo';

const TODAY = '2026-11-18';
const flat = new Array(30).fill(240); // $240/day = $10/hour of on-demand usage
const d = 0.25;

describe('commitment what-if model', () => {
  it('a plan sized exactly to steady usage is fully used and saves the discount', () => {
    const h = hourlyFor(240, d); // $7.50/hour of plan covers $10/hour on-demand
    expect(h).toBeCloseTo(7.5, 6);
    const r = model({ daily: flat, discount: d, hourly: h });
    expect(r.utilizationPct).toBeCloseTo(100, 6);
    expect(r.coveragePct).toBeCloseTo(100, 6);
    expect(r.monthlySavings).toBeCloseTo(240 * 0.25 * 30.4, 4);
    expect(r.monthlyUnused).toBeCloseTo(0, 6);
    expect(r.daysNotFullyUsed).toBe(0);
  });

  it('half the commitment covers half the usage; double wastes the excess', () => {
    const half = model({ daily: flat, discount: d, hourly: 3.75 });
    expect(half.coveragePct).toBeCloseTo(50, 6);
    expect(half.utilizationPct).toBeCloseTo(100, 6);
    expect(half.monthlySavings).toBeCloseTo(240 * 0.25 * 30.4 * 0.5, 4);
    const double = model({ daily: flat, discount: d, hourly: 15 });
    expect(double.utilizationPct).toBeCloseTo(50, 6);
    expect(double.monthlySavings).toBeLessThan(0);
    expect(double.daysNotFullyUsed).toBe(30);
  });

  it('no commitment saves nothing and costs nothing', () => {
    const r = model({ daily: flat, discount: d, hourly: 0 });
    expect(r.monthlySavings).toBe(0);
    expect(r.monthlyPlanCost).toBe(0);
    expect(r.coveragePct).toBe(0);
  });

  it('finds the safe and best levels on variable usage', () => {
    // Covering a higher usage level pays off only if usage reaches it on more than (1 - discount)
    // of days: here 25 of 30 days (83%) are at $240, above the 75% threshold for a 25% discount.
    const daily = [...new Array(25).fill(240), ...new Array(5).fill(120)];
    const p = presets(daily, d, 9);
    expect(p.safe).toBeCloseTo(hourlyFor(120, d), 6);
    expect(p.best).toBeCloseTo(hourlyFor(240, d), 6);
    expect(p.aws).toBe(9);
    const best = model({ daily, discount: d, hourly: p.best }).monthlySavings;
    for (const pt of curve(daily, d, p.max)) expect(pt.savings).toBeLessThanOrEqual(best + 1e-6);
  });

  it('stays at the lower level when the higher one is reached on too few days', () => {
    // 20 of 30 days (67%) at $240 is below the 75% threshold: the extra commitment loses money
    const daily = [...new Array(20).fill(240), ...new Array(10).fill(120)];
    expect(presets(daily, d, null).best).toBeCloseTo(hourlyFor(120, d), 6);
  });

  it('prefers the lower level when the peak is rare', () => {
    const daily = [...new Array(28).fill(120), 600, 600];
    expect(presets(daily, d, null).best).toBeCloseTo(hourlyFor(120, d), 6);
  });

  it('break-even drop equals the discount for a perfectly sized plan', () => {
    // a fully used plan stops paying off once usage falls by more than the discount
    expect(breakEvenDrop(flat, d, hourlyFor(240, d))).toBeCloseTo(d, 2);
    // a plan half the size survives a much bigger fall
    expect(breakEvenDrop(flat, d, hourlyFor(120, d))).toBeGreaterThan(0.6);
    // an oversized plan that already loses money has no margin
    expect(breakEvenDrop(flat, d, 15)).toBe(0);
  });

  it('a usage drop reduces savings', () => {
    const h = hourlyFor(240, d);
    expect(model({ daily: flat, discount: d, hourly: h, usageDrop: 0.2 }).monthlySavings).toBeLessThan(model({ daily: flat, discount: d, hourly: h }).monthlySavings);
  });

  it('reads the demo snapshot and takes its discount from the AWS recommendation', () => {
    const data = plannerData(demoSnapshot(TODAY));
    expect(data.usable).toBe(true);
    expect(data.options).toHaveLength(6);
    const opt = data.options.find((o) => o.termYears === 1 && o.payment === 'No Upfront')!;
    expect(opt.source).toBe('aws');
    expect(opt.discount).toBeGreaterThan(0.2);
    expect(opt.discount).toBeLessThan(0.35);
    expect(data.awsHourly[optionKey(opt)]).toBe(14.5);
    // options AWS did not recommend fall back to typical discounts
    expect(data.options.find((o) => o.termYears === 3 && o.payment === 'Partial Upfront')!.source).toBe('typical');
    expect(data.expiring.map((e) => e.daysLeft)).toEqual([19, 74]);
    expect(data.expiring[0].dailyOnDemand).toBeGreaterThan(300);
    expect(data.expiring[0].label).toContain('$9.80/hour');
  });

  it('is unusable without coverage history', () => {
    const snap = demoSnapshot(TODAY);
    snap.commitments.coverage = [];
    expect(plannerData(snap).usable).toBe(false);
  });
});
