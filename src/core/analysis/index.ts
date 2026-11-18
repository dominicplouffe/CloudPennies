import type { Report, Settings, Snapshot } from '../types';
import { DEFAULT_SETTINGS } from '../types';
import { sum } from '../util';
import { detectAnomalies } from './anomalies';
import { buildBriefing, buildCommitmentSummary, buildTagCoverage } from './briefing';
import { buildContext } from './context';
import { buildInsights } from './insights';

export function analyze(snap: Snapshot, settings: Settings = DEFAULT_SETTINGS): Report {
  const ctx = buildContext(snap, settings);
  const anomalies = detectAnomalies(ctx);
  const commitments = buildCommitmentSummary(snap);
  const tagCoverage = buildTagCoverage(snap);
  const insights = buildInsights(ctx, anomalies, commitments, tagCoverage);
  const totalMonthlySavings = sum(insights.map((i) => i.monthlySavings));
  const briefing = buildBriefing(ctx, anomalies, insights, totalMonthlySavings, commitments);
  return { briefing, insights, anomalies, commitments, tagCoverage, totalMonthlySavings, budgets: snap.budgets };
}
