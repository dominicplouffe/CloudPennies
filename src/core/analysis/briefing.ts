import type { Anomaly, Briefing, CommitmentSummary, Driver, Expiration, Insight, Snapshot, TagCoverage } from '../types';
import { describeUsage, shortService } from '../catalog';
import { addDays, addMonths, daysInMonth, diffDays, groupSum, joinList, median, money, monthName, monthStart, pct, pctChange, sum } from '../util';
import type { Ctx } from './context';

export function buildCommitmentSummary(snap: Snapshot): CommitmentSummary {
  const c = snap.commitments;
  const t = c.totals;
  const today = snap.meta.today;
  const cov = c.coverage.slice(-30);
  const covered = sum(cov.map((p) => p.covered));
  const onDemand = sum(cov.map((p) => p.onDemand));
  const coveragePct = covered + onDemand > 0 ? (covered / (covered + onDemand)) * 100 : 0;
  const committed = t.spCommitment + t.riAmortized;
  const utilizationPct = committed > 0 ? ((t.spUsed + t.riAmortized - t.riUnused) / committed) * 100 : 0;
  const odEquivalent = t.onDemandEquivalentCovered + t.onDemandEligible;
  const esrPct = odEquivalent > 0 ? (t.netSavings / odEquivalent) * 100 : 0;

  const expirations: Expiration[] = [];
  for (const sp of c.savingsPlans) {
    const daysLeft = diffDays(sp.end, today);
    if (daysLeft < 0 || daysLeft > 366) continue;
    expirations.push({
      id: sp.id,
      kind: 'Savings Plan',
      label: `${sp.type === 'EC2Instance' ? 'EC2 Instance' : sp.type} Savings Plan`,
      detail: `${money(sp.hourlyCommitment, { cents: true })}/hour · ${sp.termYears}-year · ${sp.paymentOption}${sp.instanceFamily ? ` · ${sp.instanceFamily} in ${sp.region}` : ''}`,
      end: sp.end,
      daysLeft,
      monthlyExposure: Math.max(0, sp.netSavings),
      monthlyCommitment: sp.hourlyCommitment * 730,
      utilizationPct: sp.utilizationPct,
    });
  }
  for (const ri of c.reservations) {
    const daysLeft = diffDays(ri.end, today);
    if (daysLeft < 0 || daysLeft > 366) continue;
    expirations.push({
      id: ri.id,
      kind: 'Reserved Instance',
      label: `${shortService(ri.service)} reservation`,
      detail: `${ri.count} × ${ri.instanceType}${ri.platform ? ` · ${ri.platform}` : ''} · ${ri.region}`,
      end: ri.end,
      daysLeft,
      monthlyExposure: Math.max(0, ri.netSavings),
      monthlyCommitment: ri.amortizedCost,
      utilizationPct: ri.utilizationPct,
    });
  }
  expirations.sort((a, b) => a.daysLeft - b.daysLeft);

  return {
    esrPct,
    coveragePct,
    utilizationPct,
    monthlyNetSavings: t.netSavings,
    monthlyOnDemandEligible: t.onDemandEligible || onDemand,
    monthlyWaste: Math.max(0, t.spCommitment - t.spUsed) + t.riUnused,
    expirations,
  };
}

export function buildTagCoverage(snap: Snapshot): TagCoverage | null {
  const p = snap.primaryTag;
  if (!p || !p.rows.length) return null;
  const m = groupSum(p.rows, (r) => r.keys[0] ?? '', (r) => r.cost);
  const total = sum([...m.values()]);
  const untagged = m.get('') ?? 0;
  return {
    key: p.key,
    untaggedCost: untagged,
    totalCost: total,
    untaggedPct: total > 0 ? (untagged / total) * 100 : 0,
    values: [...m.entries()].map(([value, cost]) => ({ value, cost })).sort((a, b) => b.cost - a.cost),
  };
}

function driversBetween(ctx: Ctx, cur: [number, number], prev: [number, number]): Driver[] {
  // [from, to) index ranges into ctx.dates
  const svc = new Map<string, Driver & { _parts: Map<string, { label: string; usageType: string; delta: number; uCur: number; uPrev: number; cCur: number; cPrev: number }> }>();
  for (const l of ctx.leaves) {
    let c = 0,
      p = 0,
      uc = 0,
      up = 0;
    for (let i = cur[0]; i < cur[1]; i++) {
      c += l.cost[i];
      uc += l.usage[i];
    }
    for (let i = prev[0]; i < prev[1]; i++) {
      p += l.cost[i];
      up += l.usage[i];
    }
    if (!c && !p) continue;
    let d = svc.get(l.service);
    if (!d) svc.set(l.service, (d = { service: l.service, current: 0, previous: 0, delta: 0, why: '', parts: [], _parts: new Map() }));
    d.current += c;
    d.previous += p;
    const label = describeUsage(l.service, l.usageType);
    const part = d._parts.get(label);
    if (part) {
      part.delta += c - p;
      part.uCur += uc;
      part.uPrev += up;
      part.cCur += c;
      part.cPrev += p;
    } else d._parts.set(label, { label, usageType: l.usageType, delta: c - p, uCur: uc, uPrev: up, cCur: c, cPrev: p });
  }
  const out: Driver[] = [];
  for (const d of svc.values()) {
    d.delta = d.current - d.previous;
    const sign = Math.sign(d.delta) || 1;
    const parts = [...d._parts.values()].filter((p) => Math.sign(p.delta) === sign && Math.abs(p.delta) > 0.5).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
    const top = parts.slice(0, 2);
    const phrases = top.map((p) => {
      let reason = '';
      if (p.cPrev < 0.5) reason = 'new';
      else if (p.cCur < 0.5) reason = 'gone';
      else if (p.uPrev > 0 && p.uCur > 0) {
        const usageChg = pctChange(p.uCur, p.uPrev);
        const rateChg = pctChange(p.cCur / p.uCur, p.cPrev / p.uPrev);
        if (Math.abs(rateChg) > 8 && Math.abs(rateChg) > Math.abs(usageChg)) reason = `effective rate ${pct(rateChg, 0, true)}`;
        else if (Math.abs(usageChg) >= 3) reason = `usage ${pct(usageChg, 0, true)}`;
      }
      return `${p.label} (${money(p.delta, { sign: true })}${reason ? `, ${reason}` : ''})`;
    });
    d.why = phrases.length ? `${d.previous < 1 ? 'New this period: ' : 'Mostly '}${joinList(phrases)}.` : '';
    d.parts = parts.slice(0, 6).map((p) => ({ label: p.label, usageType: p.usageType, delta: p.delta }));
    const { _parts, ...clean } = d;
    out.push(clean);
  }
  return out;
}

export function buildBriefing(ctx: Ctx, anomalies: Anomaly[], insights: Insight[], totalSavings: number, commitments: CommitmentSummary): Briefing {
  const { snap, dates, n, total } = ctx;
  const through = snap.meta.dataThrough;
  const focus = monthStart(through);
  const prevMonth = addMonths(focus, -1);
  const dayCount = diffDays(through, focus) + 1;
  const idx = new Map(dates.map((d, i) => [d, i]));

  const rangeSum = (from: string, days: number) => {
    let s = 0;
    for (let k = 0; k < days; k++) {
      const i = idx.get(addDays(from, k));
      if (i !== undefined) s += total[i];
    }
    return s;
  };
  const mtd = rangeSum(focus, dayCount);
  const prevMtd = rangeSum(prevMonth, Math.min(dayCount, daysInMonth(prevMonth)));

  const monthly = groupSum(snap.monthlyByService, (r) => r.date.slice(0, 7), (r) => r.cost);
  const monthlyTotals = [...monthly.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, cost]) => ({ date: m + '-01', cost, partial: m === focus.slice(0, 7) }));
  const prevMonthTotal = monthly.get(prevMonth.slice(0, 7)) ?? rangeSum(prevMonth, daysInMonth(prevMonth));

  const dim = daysInMonth(focus);
  const remainingDays = dim - dayCount;
  const last7 = Array.from(total.subarray(Math.max(0, n - 7)));
  const prev7 = Array.from(total.subarray(Math.max(0, n - 14), Math.max(0, n - 7)));
  // median is robust to once-a-month lump charges
  const dailyRun = median(last7);
  let projected: number;
  let projectedLow: number | undefined;
  let projectedHigh: number | undefined;
  let projectionSource: Briefing['projectionSource'] = 'run-rate';
  const runRateRemaining = dailyRun * remainingDays;
  // Trust AWS's forecast only when it is in the same universe as what the account actually
  // spends per day. A forecast more than double (or under 40% of) the run rate is not a
  // forecast of the remaining days — showing it would be worse than showing the run rate.
  const awsRemaining = snap.forecast?.remaining;
  const plausible = awsRemaining !== undefined && (runRateRemaining <= 0 || (awsRemaining <= runRateRemaining * 2 && awsRemaining >= runRateRemaining * 0.4));
  const forecastRejected = awsRemaining !== undefined && remainingDays > 0 && !plausible ? { awsRemaining, runRateRemaining } : undefined;
  if (snap.forecast && remainingDays > 0 && plausible) {
    projected = mtd + snap.forecast.remaining;
    projectedLow = snap.forecast.remainingLow !== undefined ? mtd + snap.forecast.remainingLow : undefined;
    projectedHigh = snap.forecast.remainingHigh !== undefined ? mtd + snap.forecast.remainingHigh : undefined;
    projectionSource = 'aws';
  } else {
    projected = mtd + runRateRemaining;
  }

  // What are we comparing? Early in the month MTD is too thin, so use trailing 30 days.
  let cur: [number, number];
  let prev: [number, number];
  let compare: Briefing['compare'];
  const focusIdx = idx.get(focus);
  const prevIdx = idx.get(prevMonth);
  if (dayCount >= 10 && focusIdx !== undefined && prevIdx !== undefined) {
    const len = Math.min(dayCount, daysInMonth(prevMonth));
    cur = [focusIdx, focusIdx + dayCount];
    prev = [prevIdx, prevIdx + len];
    compare = { label: `${monthName(focus)} 1–${dayCount}`, prevLabel: `${monthName(prevMonth)} 1–${len}`, current: mtd, previous: prevMtd };
  } else {
    const len = Math.min(30, Math.floor(n / 2));
    cur = [n - len, n];
    prev = [n - 2 * len, n - len];
    compare = { label: `last ${len} days`, prevLabel: `the ${len} days before`, current: sum(Array.from(total.subarray(cur[0], cur[1]))), previous: sum(Array.from(total.subarray(prev[0], prev[1]))) };
  }
  const all = driversBetween(ctx, cur, prev);
  const minMove = Math.max(20, compare.current * 0.002);
  const drivers = all.filter((d) => d.delta > minMove).sort((a, b) => b.delta - a.delta).slice(0, 6);
  const decreases = all.filter((d) => d.delta < -minMove).sort((a, b) => a.delta - b.delta).slice(0, 4);

  const cur30 = new Map<string, number>();
  const prev30 = new Map<string, number>();
  for (const l of ctx.leaves) {
    cur30.set(l.service, (cur30.get(l.service) ?? 0) + l.cost30);
    prev30.set(l.service, (prev30.get(l.service) ?? 0) + l.prev30);
  }
  const topServices = [...cur30.entries()]
    .map(([service, cost]) => ({ service, cost, prev: prev30.get(service) ?? 0, share: ctx.last30 > 0 ? cost / ctx.last30 : 0 }))
    .sort((a, b) => b.cost - a.cost);

  const rec = (type: RegExp) => sum(snap.monthlyByRecordType.filter((r) => r.date.slice(0, 7) === focus.slice(0, 7) && type.test(r.keys[0] ?? '')).map((r) => r.cost));
  const creditsThisMonth = rec(/credit|refund/i);
  const taxThisMonth = rec(/^tax$/i);

  // Once-a-month lump charges (support plan, upfront fees) would dwarf the daily trend line.
  const lump = new Float64Array(n);
  const lumpBySvc = new Map<string, number>();
  if (n >= 45)
    for (const l of ctx.leaves) {
      let nonZero = 0;
      let last = 0;
      for (let i = 0; i < n; i++)
        if (l.cost[i] > 0.01) {
          nonZero++;
          last = l.cost[i];
        }
      if (nonZero === 0 || nonZero > Math.ceil(n / 28) + 1 || last < 50) continue;
      for (let i = 0; i < n; i++) lump[i] += l.cost[i];
      lumpBySvc.set(l.service, (lumpBySvc.get(l.service) ?? 0) + last);
    }
  const monthlyCharges = [...lumpBySvc.entries()].map(([service, amount]) => ({ label: shortService(service), amount })).sort((a, b) => b.amount - a.amount);

  // ── The story ──
  const chg = pctChange(compare.current, compare.previous);
  const dir = chg > 1.5 ? 'up' : chg < -1.5 ? 'down' : 'flat';
  const m = monthName(focus);
  const headline =
    dir === 'flat'
      ? `Spend is steady: ${money(mtd)} so far in ${m}.`
      : `Spend is ${dir} ${pct(Math.abs(chg))}: ${money(mtd)} so far in ${m}.`;

  const story: string[] = [];
  const projVsPrev = pctChange(projected, prevMonthTotal);
  let p1 = `You have spent ${money(mtd)} in the first ${dayCount} day${dayCount === 1 ? '' : 's'} of ${m}`;
  if (compare.previous > 0) p1 += dir === 'flat' ? `, about the same as ${compare.prevLabel}` : Math.abs(compare.current - mtd) < 1 ? ` — ${pct(Math.abs(chg))} ${chg > 0 ? 'more' : 'less'} than ${compare.prevLabel}` : ` — the ${compare.label} came to ${money(compare.current)}, ${pct(Math.abs(chg))} ${chg > 0 ? 'more' : 'less'} than ${compare.prevLabel}`;
  p1 += '.';
  if (remainingDays > 0) p1 += ` At this pace ${m} will close near ${money(projected)}${prevMonthTotal > 0 ? `, ${Math.abs(projVsPrev) < 1.5 ? 'in line with' : `${pct(Math.abs(projVsPrev))} ${projVsPrev > 0 ? 'above' : 'below'}`} ${monthName(prevMonth)}'s ${money(prevMonthTotal)}` : ''}.`;
  story.push(p1);

  if (drivers.length) {
    const top = drivers.slice(0, 3);
    const explained = sum(top.map((d) => d.delta));
    const net = compare.current - compare.previous;
    story.push(
      `${top.length === 1 ? 'One service explains' : `${top.length === 2 ? 'Two' : 'Three'} services explain`} ${net > 0 && explained <= net * 1.02 ? `${pct((explained / net) * 100)} of the increase` : `${money(explained)} of new spend`}: ${joinList(top.map((d) => `${shortService(d.service)} (${money(d.delta, { sign: true })})`))}.${decreases.length ? ` ${shortService(decreases[0].service)} moved the other way (${money(decreases[0].delta)}).` : ''}`,
    );
  }
  const ongoing = anomalies.filter((a) => a.ongoing && diffDays(through, a.start) <= 35);
  if (ongoing.length) {
    const rr = sum(ongoing.map((a) => a.monthlyRunRate));
    story.push(`${ongoing.length === 1 ? 'One anomaly is' : `${ongoing.length} anomalies are`} still running from the last month${rr > 0 ? ` and adding roughly ${money(rr)}/month` : ''}: ${joinList(ongoing.slice(0, 3).map(phrase))}.`);
  }
  const urgentExp = commitments.expirations.filter((e) => e.daysLeft <= 60);
  if (totalSavings > 0 || urgentExp.length) {
    let p = totalSavings > 0 ? `There is about ${money(totalSavings)}/month on the table across ${insights.filter((i) => i.monthlySavings > 0).length} opportunities.` : '';
    if (urgentExp.length) {
      const e = urgentExp[0];
      p += ` ${urgentExp.length === 1 ? 'One commitment expires' : `${urgentExp.length} commitments expire`} within 60 days — the first in ${e.daysLeft} day${e.daysLeft === 1 ? '' : 's'}, putting ${money(sum(urgentExp.map((x) => x.monthlyExposure)))}/month of discounts at risk.`;
    }
    story.push(p.trim());
  }

  return {
    monthLabel: m,
    prevMonthLabel: monthName(prevMonth),
    mtd,
    prevMtd,
    compare,
    prevMonthTotal,
    projected,
    projectedLow,
    projectedHigh,
    projectionSource,
    projectedRemaining: projected - mtd,
    forecastRejected,
    dailyAvg7: sum(last7) / Math.max(1, last7.length),
    dailyAvgPrev7: sum(prev7) / Math.max(1, prev7.length),
    last30: ctx.last30,
    headline,
    story,
    drivers,
    decreases,
    dailyTotals: dates.map((date, i) => ({ date, cost: total[i] - lump[i] })),
    monthlyCharges,
    monthlyTotals,
    topServices,
    creditsThisMonth,
    taxThisMonth,
  };
}

/** an anomaly as a mid-sentence phrase */
function phrase(a: Anomaly): string {
  const what = a.causes[0]?.label ?? shortService(a.service);
  const lower = /^[A-Z][a-z]/.test(what) ? what[0].toLowerCase() + what.slice(1) : what;
  if (a.kind === 'new') return `new ${shortService(a.service)} spend`;
  if (a.kind === 'shift') return a.expectedDaily < 0.5 ? `a new charge for ${lower}` : `${lower} stepping up`;
  return `${lower} spiking`;
}
