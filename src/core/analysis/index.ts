import type { Report, Settings, Snapshot } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { isLastDayPartial } from '../reconcile';
import { addDays, sum } from '../util';
import { detectAnomalies } from './anomalies';
import { buildBriefing, buildCommitmentSummary, buildTagCoverage } from './briefing';
import { buildContext } from './context';
import { buildInsights } from './insights';

export function analyze(snap: Snapshot, settings: Settings = DEFAULT_SETTINGS): Report {
  // AWS billing data lags by up to a day. If the newest day is clearly incomplete, analyze
  // through the day before it — otherwise month-to-date, trends and "is it still running?"
  // would all be skewed by half a day of data.
  if (isLastDayPartial(snap)) {
    const through = addDays(snap.meta.dataThrough, -1);
    const keep = (rows: Snapshot['dailyByAccount']) => rows.filter((r) => r.date <= through);
    snap = { ...snap, meta: { ...snap.meta, dataThrough: through }, dailyByServiceUsage: keep(snap.dailyByServiceUsage), dailyByAccount: keep(snap.dailyByAccount), dailyByRegion: keep(snap.dailyByRegion) };
  }
  const ctx = buildContext(snap, settings);
  const anomalies = detectAnomalies(ctx);
  const commitments = buildCommitmentSummary(snap);
  const tagCoverage = buildTagCoverage(snap);
  const insights = buildInsights(ctx, anomalies, commitments, tagCoverage);
  const totalMonthlySavings = sum(insights.map((i) => i.monthlySavings));
  const briefing = buildBriefing(ctx, anomalies, insights, totalMonthlySavings, commitments);
  return { briefing, insights, anomalies, commitments, tagCoverage, totalMonthlySavings, budgets: snap.budgets };
}
