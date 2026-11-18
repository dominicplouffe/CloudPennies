// Anomaly detection on daily (service, usage type) series.
//
// For each leaf series we keep a rolling 28-day robust baseline (median + MAD).
// A day is anomalous when it exceeds the baseline by more than the noise band.
// Anomalous days do not pollute the baseline — unless the new level persists
// for 14 days, in which case we call it a "shift" (stepped up and stayed up)
// and accept the new level as normal going forward.
//
// "Ongoing" tolerates one trailing day, because the most recent day of AWS billing
// data is usually still incomplete.
//
// Leaf events of the same service that overlap in time are merged into one
// anomaly whose "causes" are the usage types involved.

import type { Anomaly, AnomalyCause, Level } from '../types';
import { describeUsage, shortService } from '../catalog';
import { addDays, diffDays, fmtDate, hash, joinList, mad, mean, median, money } from '../util';
import type { Ctx, Leaf } from './context';

const WINDOW = 28;
const WARMUP = 14;
const SHIFT_DAYS = 14;

interface LeafEvent {
  leaf: Leaf;
  kind: 'spike' | 'shift' | 'new';
  s: number; // start index
  e: number; // end index (inclusive)
  baseline: number; // expected daily before the event
  level: number; // actual daily average during the event
  impact: number;
  ongoing: boolean;
}

function detectLeaf(leaf: Leaf, n: number, minDaily: number): LeafEvent[] {
  const x = leaf.cost;
  const events: LeafEvent[] = [];
  let firstNonZero = -1;
  for (let i = 0; i < n; i++)
    if (x[i] > 0.01) {
      firstNonZero = i;
      break;
    }
  if (firstNonZero < 0) return events;

  const clean: number[] = [];
  let open: { s: number; baseline: number; last: number } | null = null;

  const close = (kind: 'spike' | 'shift', endIdx: number) => {
    if (!open) return;
    let impact = 0;
    for (let i = open.s; i <= endIdx; i++) impact += x[i] - open.baseline;
    const level = mean(Array.from(x.subarray(open.s, endIdx + 1)));
    events.push({ leaf, kind, s: open.s, e: endIdx, baseline: open.baseline, level, impact, ongoing: endIdx >= n - 2 });
    open = null;
  };

  for (let t = 0; t < n; t++) {
    if (t < WARMUP || clean.length < WARMUP) {
      clean.push(x[t]);
      continue;
    }
    const win = clean.slice(-WINDOW);
    const med = median(win);
    const sd = 1.4826 * mad(win, med);
    const threshold = Math.max(3.5 * sd, 0.25 * med, minDaily);
    let flagged = x[t] - med > threshold;

    // recurring monthly charge (support fee, RI fee on the 1st...): a similar value 28-31 days earlier
    if (flagged && !open) {
      for (let k = 28; k <= 31; k++) {
        const p = x[t - k];
        if (p !== undefined && p > med + threshold && Math.abs(p - x[t]) / x[t] < 0.4) {
          flagged = false;
          break;
        }
      }
    }

    if (flagged) {
      if (!open) open = { s: t, baseline: med, last: t };
      open.last = t;
      if (t - open.s + 1 >= SHIFT_DAYS) {
        // persisted: accept the new level as the baseline from here on
        const s: number = open.s;
        const baseline: number = open.baseline;
        clean.length = 0;
        for (let i = s; i <= t; i++) clean.push(x[i]);
        const shiftLevel = mean(clean);
        // how long did it stay up?
        let endIdx = t;
        for (let i = t + 1; i < n; i++) {
          if (x[i] > baseline + 0.5 * (shiftLevel - baseline)) endIdx = i;
          else if (i - endIdx > 2) break;
        }
        open = { s, baseline, last: endIdx };
        close('shift', endIdx);
        continue;
      }
      clean.push(med); // winsorize
    } else {
      if (open && t - open.last > 1) close('spike', open.last);
      clean.push(x[t]);
    }
  }
  if (open) close('spike', (open as { last: number }).last);
  return events;
}

function severity(impact: number, runRate: number, last30: number): Level {
  const v = Math.max(impact, runRate);
  if (v >= Math.max(1000, last30 * 0.02)) return 'high';
  if (v >= Math.max(200, last30 * 0.005)) return 'medium';
  return 'low';
}

export function detectAnomalies(ctx: Ctx): Anomaly[] {
  const { n, dates, leaves, settings, last30 } = ctx;
  if (n < WARMUP + 7) return [];
  const minImpact = settings.anomalyMinImpact;
  const minDaily = Math.max(1, minImpact / 10);

  // Services that are entirely new within the window get a single "new" anomaly.
  const byService = new Map<string, Leaf[]>();
  for (const l of leaves) {
    if (!byService.has(l.service)) byService.set(l.service, []);
    byService.get(l.service)!.push(l);
  }

  const out: Anomaly[] = [];

  for (const [service, ls] of byService) {
    const tot = new Float64Array(n);
    for (const l of ls) for (let i = 0; i < n; i++) tot[i] += l.cost[i];
    let first = -1;
    for (let i = 0; i < n; i++)
      if (tot[i] > 0.01) {
        first = i;
        break;
      }
    if (first < 0) continue;
    const sinceTotal = Array.from(tot.subarray(first)).reduce((a, b) => a + b, 0);
    const recent = mean(Array.from(tot.subarray(Math.max(first, n - 7))));
    const stillActive = recent > 0.5;

    let events: LeafEvent[];
    if (first >= WARMUP && sinceTotal >= minImpact * 2 && stillActive) {
      // brand-new service
      events = ls
        .filter((l) => l.cost30 > 0 || l.prev30 > 0)
        .map((l) => {
          const impact = Array.from(l.cost.subarray(first)).reduce((a, b) => a + b, 0);
          return { leaf: l, kind: 'new' as const, s: first, e: n - 1, baseline: 0, level: impact / (n - first), impact, ongoing: true };
        })
        .filter((e) => e.impact > 0);
      if (events.length) out.push(build(ctx, service, events, tot, recent));
      continue;
    }

    events = ls.flatMap((l) => detectLeaf(l, n, minDaily)).filter((e) => e.impact >= minImpact * 0.4);
    // merge overlapping leaf events of the same service
    events.sort((a, b) => a.s - b.s);
    const groups: LeafEvent[][] = [];
    for (const ev of events) {
      const g = groups.find((g) => g.some((o) => ev.s <= o.e + 1 && ev.e >= o.s - 1 && (o.kind === 'shift') === (ev.kind === 'shift')));
      if (g) g.push(ev);
      else groups.push([ev]);
    }
    for (const g of groups) {
      const impact = g.reduce((a, e) => a + e.impact, 0);
      if (impact < minImpact) continue;
      out.push(build(ctx, service, g, tot, recent));
    }
  }

  // AWS Cost Anomaly Detection findings we did not catch ourselves
  for (const a of ctx.snap.awsAnomalies) {
    if (Math.abs(a.impact) < minImpact) continue;
    const aEnd = a.end ?? a.start;
    const dup = out.some((o) => (!a.service || o.service === a.service) && a.start <= addDays(o.end, 2) && aEnd >= addDays(o.start, -2));
    if (dup) continue;
    const service = a.service ?? 'Unknown service';
    const days = Math.max(1, diffDays(aEnd, a.start) + 1);
    const ongoing = diffDays(ctx.snap.meta.dataThrough, aEnd) <= 1;
    out.push({
      id: 'aws-' + a.id,
      kind: 'spike',
      service,
      title: `${shortService(service)} cost anomaly`,
      summary: `AWS Cost Anomaly Detection flagged ${money(a.impact)} of unexpected ${shortService(service)} spend starting ${fmtDate(a.start)}${a.usageType ? `, mostly ${describeUsage(service, a.usageType)}` : ''}${a.region ? ` in ${a.region}` : ''}.`,
      start: a.start,
      end: aEnd,
      ongoing,
      impact: a.impact,
      monthlyRunRate: ongoing ? (a.impact / days) * 30 : 0,
      expectedDaily: (a.expected ?? 0) / days,
      actualDaily: (a.actual ?? a.impact) / days,
      severity: severity(a.impact, 0, last30),
      causes: a.usageType ? [{ dim: 'USAGE_TYPE', key: a.usageType, label: describeUsage(service, a.usageType), impact: a.impact }] : [],
      series: [],
      source: 'AWS',
      thread: { label: shortService(service), filters: a.service ? { SERVICE: [a.service] } : {}, groupBy: 'USAGE_TYPE' },
    });
  }

  const sevRank = { high: 0, medium: 1, low: 2 };
  out.sort((a, b) => Number(b.ongoing) - Number(a.ongoing) || sevRank[a.severity] - sevRank[b.severity] || b.impact - a.impact);
  return out;

  function build(ctx: Ctx, service: string, g: LeafEvent[], _tot: Float64Array, _recent: number): Anomaly {
    const s = Math.min(...g.map((e) => e.s));
    const e = Math.max(...g.map((e) => e.e));
    const kind = g[0].kind;
    const ongoing = g.some((x) => x.ongoing);
    const impact = g.reduce((a, x) => a + x.impact, 0);
    const baseline = g.reduce((a, x) => a + x.baseline, 0);
    const days = e - s + 1;
    const involved = [...new Set(g.map((x) => x.leaf))];

    // merge causes by human label
    const causeMap = new Map<string, AnomalyCause>();
    for (const ev of g) {
      const label = describeUsage(service, ev.leaf.usageType);
      const c = causeMap.get(label);
      if (c) c.impact += ev.impact;
      else causeMap.set(label, { dim: 'USAGE_TYPE', key: ev.leaf.usageType, label, impact: ev.impact });
    }
    const causes = [...causeMap.values()].sort((a, b) => b.impact - a.impact);

    // chart series: the involved usage types, last 60 days
    const from = Math.max(0, n - 60);
    const series = [];
    let actualSum = 0;
    for (let i = from; i < n; i++) {
      let cost = 0;
      for (const l of involved) cost += l.cost[i];
      const inWindow = i >= s && i <= e;
      if (inWindow) actualSum += cost;
      series.push({ date: dates[i], cost, expected: inWindow ? baseline : cost });
    }
    const recentLevel = mean(involved.length ? Array.from({ length: Math.min(3, e - s + 1) }, (_, k) => involved.reduce((a, l) => a + l.cost[e - k], 0)) : [0]);
    const actualDaily = kind === 'new' ? recentLevel : impact / days + baseline;
    const monthlyRunRate = ongoing ? Math.max(0, recentLevel - baseline) * 30 : 0;

    const svc = shortService(service);
    const what = causes.length ? joinList(causes.slice(0, 2).map((c) => c.label)) : svc;
    const start = dates[s];
    const end = dates[e];
    let title: string;
    let summary: string;
    if (kind === 'new') {
      title = `New spend: ${svc}`;
      summary = `${svc} first appeared on your bill on ${fmtDate(start)} and is now running at about ${money(recentLevel)}/day (${money(recentLevel * 30)}/month). ${money(impact)} so far${causes.length ? `, mostly ${what}` : ''}.`;
    } else if (kind === 'shift' && baseline < 0.5) {
      title = `New charge: ${what}`;
      summary = `${what} is a new line on your ${svc} bill. It started on ${fmtDate(start)} at about ${money(actualDaily)}/day${ongoing ? ' and is still running' : ` and ran until ${fmtDate(end)}`} — ${money(impact)} so far${ongoing ? `, about ${money(monthlyRunRate)}/month going forward` : ''}.`;
    } else if (kind === 'shift') {
      title = `${what} stepped up${ongoing ? ' and stayed up' : ''}`;
      summary = `${what} in ${svc} went from about ${money(baseline)}/day to ${money(actualDaily)}/day on ${fmtDate(start)}${ongoing ? ' and has not come back down' : ` and stayed there until ${fmtDate(end)}`}. That is ${money(impact)} extra so far${ongoing ? `, or about ${money(monthlyRunRate)} every month if nothing changes` : ''}.`;
    } else {
      title = `${what} ${ongoing ? 'is spiking' : 'spiked'}`;
      summary = ongoing
        ? `${what} in ${svc} jumped from about ${money(baseline)}/day to ${money(actualDaily)}/day on ${fmtDate(start)} and is still elevated. That is ${money(impact)} extra so far — about ${money(monthlyRunRate)}/month if it continues.`
        : `${what} in ${svc} ran at ${money(actualDaily)}/day instead of the usual ${money(baseline)}/day ${days === 1 ? `on ${fmtDate(start)}` : `from ${fmtDate(start)} to ${fmtDate(end)}`}, then returned to normal. Total extra cost: ${money(impact)}.`;
    }

    return {
      id: 'an-' + hash(service + '|' + start + '|' + kind + '|' + causes.map((c) => c.key).join(',')),
      kind,
      service,
      title,
      summary,
      start,
      end,
      ongoing,
      impact,
      monthlyRunRate,
      expectedDaily: baseline,
      actualDaily,
      severity: severity(impact, monthlyRunRate, last30),
      causes,
      series,
      source: 'CloudPennies',
      thread: { label: svc, filters: { SERVICE: [service] }, groupBy: 'USAGE_TYPE' },
    };
  }
}
