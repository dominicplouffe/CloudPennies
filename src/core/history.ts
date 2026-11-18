// Pure functions for tracking a report over time: what to remember from each scan,
// what changed since the previous one (alerts), and what has been achieved (progress).
// Used by the main process (scheduled scans, notifications) and by the UI.

import type { Alert, HistoryEntry, Report, Snapshot } from './types';
import { diffDays, money } from './util';

export function summarize(snap: Snapshot, r: Report): HistoryEntry {
  return {
    at: snap.meta.generatedAt,
    today: snap.meta.today,
    last30: r.briefing.last30,
    mtd: r.briefing.mtd,
    projected: r.briefing.projected,
    insights: Object.fromEntries(r.insights.map((i) => [i.id, { title: i.title, savings: i.monthlySavings, category: i.category }])),
    anomalies: Object.fromEntries(r.anomalies.map((a) => [a.id, { title: a.title, ongoing: a.ongoing, impact: a.impact, start: a.start }])),
    expirations: Object.fromEntries(r.commitments.expirations.map((e) => [e.id, { label: e.label, daysLeft: e.daysLeft, exposure: e.monthlyExposure }])),
    esrPct: r.commitments.esrPct,
    coveragePct: r.commitments.coveragePct,
  };
}

/** Keep one entry per calendar day (the latest), so manual re-scans do not bloat the history. */
export function appendHistory(history: HistoryEntry[], entry: HistoryEntry, max = 800): HistoryEntry[] {
  const out = history.filter((h) => h.today !== entry.today);
  out.push(entry);
  out.sort((a, b) => a.at.localeCompare(b.at));
  return out.slice(-max);
}

const EXPIRY_THRESHOLDS = [60, 30, 14, 7, 3, 1];

/**
 * What is new in `cur` compared with the previous scan. With no previous scan nothing is
 * reported (the first scan would otherwise fire a notification for everything).
 */
export function diffAlerts(prev: HistoryEntry | null, cur: HistoryEntry): Alert[] {
  if (!prev) return [];
  const alerts: Alert[] = [];

  for (const [id, a] of Object.entries(cur.anomalies)) {
    if (!a.ongoing || prev.anomalies[id]) continue;
    // an anomaly can get a new id when its cause list changes; do not re-alert for the same title+start
    if (Object.values(prev.anomalies).some((p) => p.title === a.title && p.start === a.start)) continue;
    alerts.push({ kind: 'anomaly', title: a.title, body: `${money(a.impact)} of unexpected spend so far and still running.`, page: 'anomalies', focusId: id });
  }

  for (const [id, e] of Object.entries(cur.expirations)) {
    const before = prev.expirations[id]?.daysLeft ?? Infinity;
    const crossed = EXPIRY_THRESHOLDS.find((t) => e.daysLeft <= t && before > t);
    if (crossed === undefined) continue;
    alerts.push({
      kind: 'expiry',
      title: `${e.label} expires in ${e.daysLeft} day${e.daysLeft === 1 ? '' : 's'}`,
      body: `${money(e.exposure)}/month of discounts lapse unless it is renewed.`,
      page: 'commitments',
      focusId: 'expiring-' + id,
    });
  }

  const fresh = Object.entries(cur.insights)
    .filter(([id, i]) => !prev.insights[id] && i.savings >= 50 && !id.startsWith('expiring-'))
    .sort((a, b) => b[1].savings - a[1].savings);
  if (fresh.length === 1) alerts.push({ kind: 'savings', title: fresh[0][1].title, body: `New opportunity worth about ${money(fresh[0][1].savings)}/month.`, page: 'savings', focusId: fresh[0][0] });
  else if (fresh.length > 1)
    alerts.push({ kind: 'savings', title: `${fresh.length} new savings opportunities`, body: `Worth about ${money(fresh.reduce((a, [, i]) => a + i.savings, 0))}/month together. Largest: ${fresh[0][1].title}.`, page: 'savings' });

  return alerts;
}

export interface Progress {
  /** opportunities that were open in an earlier scan and are gone now */
  resolved: { id: string; title: string; savings: number; lastSeen: string; category: string }[];
  /** sum of the last-seen savings of resolved opportunities ($/month) */
  realizedMonthly: number;
  firstScan: string | null;
  scans: number;
  /** per scan: open savings and trailing-30-day spend, for the trend chart */
  trend: { date: string; openSavings: number; last30: number }[];
  /** anomalies that were ongoing earlier and are no longer */
  anomaliesCleared: number;
}

/**
 * Compare the scan history with the current report. An opportunity counts as resolved when it
 * appeared in a past scan and is absent from the current one. Time-boxed items (expiring
 * commitments) and zero-dollar items are not counted as savings.
 */
export function progress(history: HistoryEntry[], current: Report): Progress {
  const open = new Set(current.insights.map((i) => i.id));
  const seen = new Map<string, { title: string; savings: number; lastSeen: string; category: string }>();
  for (const h of history) for (const [id, i] of Object.entries(h.insights)) seen.set(id, { title: i.title, savings: i.savings, lastSeen: h.today, category: i.category });
  const resolved = [...seen.entries()]
    .filter(([id, i]) => !open.has(id) && i.savings > 0 && !id.startsWith('expiring-'))
    .map(([id, i]) => ({ id, ...i }))
    .sort((a, b) => b.savings - a.savings);

  const everOngoing = new Set<string>();
  for (const h of history) for (const [id, a] of Object.entries(h.anomalies)) if (a.ongoing) everOngoing.add(id);
  const stillOngoing = new Set(current.anomalies.filter((a) => a.ongoing).map((a) => a.id));
  const anomaliesCleared = [...everOngoing].filter((id) => !stillOngoing.has(id)).length;

  return {
    resolved,
    realizedMonthly: resolved.reduce((a, r) => a + r.savings, 0),
    firstScan: history[0]?.today ?? null,
    scans: history.length,
    trend: history.map((h) => ({ date: h.today, openSavings: Object.values(h.insights).reduce((a, i) => a + i.savings, 0), last30: h.last30 })),
    anomaliesCleared,
  };
}

/** A short plain-text digest for Slack or email */
export function digestText(snap: Snapshot, r: Report, p: Progress | null): string {
  const b = r.briefing;
  const L: string[] = [];
  L.push(`*CloudPennies — ${snap.meta.accountLabel}*`);
  L.push(b.headline);
  L.push(`Projected ${b.monthLabel}: ${money(b.projected)} (${b.prevMonthLabel}: ${money(b.prevMonthTotal)})`);
  const ongoing = r.anomalies.filter((a) => a.ongoing);
  if (ongoing.length) L.push(`\n*${ongoing.length} anomal${ongoing.length === 1 ? 'y' : 'ies'} still running*\n` + ongoing.slice(0, 5).map((a) => `• ${a.title} — ${money(a.impact)} so far`).join('\n'));
  const soon = r.commitments.expirations.filter((e) => e.daysLeft <= 60);
  if (soon.length) L.push(`\n*Commitments expiring within 60 days*\n` + soon.map((e) => `• ${e.label} in ${e.daysLeft} days — ${money(e.monthlyExposure)}/month at risk`).join('\n'));
  const top = r.insights.filter((i) => i.monthlySavings > 0).slice(0, 5);
  if (top.length) L.push(`\n*Top opportunities (${money(r.totalMonthlySavings)}/month in total)*\n` + top.map((i) => `• ${i.title} — ${money(i.monthlySavings)}/month`).join('\n'));
  if (p && p.realizedMonthly > 0) L.push(`\nResolved since ${p.firstScan}: ${p.resolved.length} opportunities worth ${money(p.realizedMonthly)}/month.`);
  return L.join('\n');
}

export const daysSince = (iso: string, today: string) => diffDays(today, iso.slice(0, 10));
