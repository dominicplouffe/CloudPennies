import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis';
import { describeUsage, instanceFamily, shortService, stripRegion } from '../src/core/catalog';
import { demoQuery, buildCube, demoSnapshot } from '../src/core/demo';
import { reportMarkdown } from '../src/core/exportReport';
import type { CostRow, Snapshot } from '../src/core/types';
import { addDays, dateRange, sum } from '../src/core/util';

const TODAY = '2026-11-18';

function emptySnapshot(rows: CostRow[], today = TODAY): Snapshot {
  return {
    meta: { mode: 'live', generatedAt: today + 'T00:00:00Z', today, dataThrough: addDays(today, -1), accountId: '1', accountLabel: 'test', currency: 'USD', costBasis: 'UnblendedCost', ceRequests: 0, deepScan: false, regionsScanned: [], warnings: [] },
    accounts: [],
    monthlyByService: [],
    dailyByServiceUsage: rows,
    dailyByAccount: [],
    dailyByRegion: [],
    recentByServiceRegion: [],
    monthlyByRecordType: [],
    tagKeys: [],
    primaryTag: null,
    forecast: null,
    budgets: [],
    awsAnomalies: [],
    commitments: { savingsPlans: [], reservations: [], coverage: [], coverageByService: [], totals: { spCommitment: 0, spUsed: 0, riAmortized: 0, riUnused: 0, netSavings: 0, onDemandEquivalentCovered: 0, onDemandEligible: 0 }, spRecommendations: [], riRecommendations: [] },
    rightsizing: [],
    hubRecommendations: [],
    resources: null,
  };
}

/** 90 days of a single usage type; `fn(daysAgo)` gives the cost (1 = yesterday) */
function series(service: string, usageType: string, fn: (ago: number, date: string) => number): CostRow[] {
  return dateRange(addDays(TODAY, -90), TODAY).map((date, i) => ({ keys: [service, usageType], date, cost: fn(90 - i, date), usage: 1 }));
}
const wobble = (ago: number) => 1 + ((ago * 7919) % 13) / 100 - 0.06;

describe('catalog', () => {
  it('strips region prefixes', () => {
    expect(stripRegion('USW2-BoxUsage:m5.large')).toBe('BoxUsage:m5.large');
    expect(stripRegion('EU-DataTransfer-Out-Bytes')).toBe('DataTransfer-Out-Bytes');
    expect(stripRegion('USE1-USW2-AWS-Out-Bytes')).toBe('AWS-Out-Bytes');
    expect(stripRegion('CW:MetricMonitorUsage')).toBe('CW:MetricMonitorUsage');
  });
  it('describes usage types in plain language, by service', () => {
    expect(describeUsage('AmazonCloudWatch', 'USE1-TimedStorage-ByteHrs')).toBe('Log storage');
    expect(describeUsage('Amazon Simple Storage Service', 'TimedStorage-ByteHrs')).toBe('S3 Standard storage');
    expect(describeUsage('EC2 - Other', 'APS2-NatGateway-Bytes')).toBe('NAT Gateway data processing');
    expect(describeUsage('Amazon Elastic Compute Cloud - Compute', 'BoxUsage:c5.xlarge')).toBe('On-Demand c5.xlarge instances');
    expect(describeUsage('Whatever', 'Totally-Unknown')).toBe('Totally-Unknown');
  });
  it('knows instance families and service names', () => {
    expect(instanceFamily('db.r5.2xlarge')).toBe('r5');
    expect(instanceFamily('cache.m6g.large')).toBe('m6g');
    expect(shortService('Amazon Relational Database Service')).toBe('RDS');
    expect(shortService('Amazon Made Up Service')).toBe('Made Up Service');
  });
});

describe('anomaly detection', () => {
  it('stays quiet on steady spend with weekly noise', () => {
    const r = analyze(emptySnapshot(series('S', 'u', (ago) => 100 * wobble(ago))));
    expect(r.anomalies).toHaveLength(0);
  });

  it('finds a resolved spike and measures its excess', () => {
    const r = analyze(emptySnapshot(series('S', 'u', (ago) => (ago <= 20 && ago >= 18 ? 400 : 100) * wobble(ago))));
    expect(r.anomalies).toHaveLength(1);
    const a = r.anomalies[0];
    expect(a.kind).toBe('spike');
    expect(a.ongoing).toBe(false);
    expect(a.start).toBe(addDays(TODAY, -20));
    expect(a.end).toBe(addDays(TODAY, -18));
    expect(a.impact).toBeGreaterThan(800);
    expect(a.impact).toBeLessThan(1000);
  });

  it('flags an ongoing spike and projects a run rate', () => {
    const r = analyze(emptySnapshot(series('S', 'u', (ago) => (ago <= 5 ? 300 : 100) * wobble(ago))));
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0].ongoing).toBe(true);
    expect(r.anomalies[0].monthlyRunRate).toBeGreaterThan(5000);
  });

  it('classifies a persistent increase as a step change', () => {
    const r = analyze(emptySnapshot(series('S', 'u', (ago) => (ago <= 40 ? 200 : 100) * wobble(ago))));
    expect(r.anomalies).toHaveLength(1);
    expect(r.anomalies[0].kind).toBe('shift');
    expect(r.anomalies[0].ongoing).toBe(true);
  });

  it('ignores charges that recur monthly', () => {
    const r = analyze(emptySnapshot(series('Support', 'Dollar', (_ago, date) => (date.endsWith('-01') ? 5000 : 0)).concat(series('S', 'u', (ago) => 100 * wobble(ago)))));
    expect(r.anomalies.filter((a) => a.service === 'Support')).toHaveLength(0);
  });

  it('reports a brand-new service as new spend', () => {
    const r = analyze(emptySnapshot([...series('S', 'u', (ago) => 100 * wobble(ago)), ...series('Amazon Bedrock', 'Tokens', (ago) => (ago <= 12 ? 40 : 0))]));
    const a = r.anomalies.find((x) => x.service === 'Amazon Bedrock');
    expect(a?.kind).toBe('new');
  });

  it('respects the minimum-impact setting', () => {
    const snap = emptySnapshot(series('S', 'u', (ago) => (ago === 10 ? 160 : 100) * wobble(ago)));
    expect(analyze(snap, { costBasis: 'UnblendedCost', deepScan: false, anomalyMinImpact: 25, theme: 'system' }).anomalies).toHaveLength(1);
    expect(analyze(snap, { costBasis: 'UnblendedCost', deepScan: false, anomalyMinImpact: 500, theme: 'system' }).anomalies).toHaveLength(0);
  });
});

describe('month-end projection', () => {
  const steady = () => emptySnapshot(series('S', 'u', (ago) => 1000 * wobble(ago)));
  // TODAY is Nov 18: 17 days of data in November, 13 days still to come
  it('adds a plausible AWS forecast of the remaining days to month-to-date', () => {
    const snap = steady();
    snap.forecast = { remaining: 12000 };
    const b = analyze(snap).briefing;
    expect(b.projectionSource).toBe('aws');
    expect(b.projected).toBeCloseTo(b.mtd + 12000, 6);
    expect(b.forecastRejected).toBeUndefined();
  });
  it('rejects a forecast that cannot be the remaining days and falls back to the run rate', () => {
    const snap = steady();
    snap.forecast = { remaining: 30000 }; // looks like a whole-month figure, not 13 days at ~$1,000
    const b = analyze(snap).briefing;
    expect(b.projectionSource).toBe('run-rate');
    expect(b.forecastRejected?.awsRemaining).toBe(30000);
    expect(b.projectedRemaining).toBeGreaterThan(12000);
    expect(b.projectedRemaining).toBeLessThan(14000);
    expect(b.projected).toBeLessThan(b.mtd * 2);
  });
  it('uses the run rate when AWS gives no forecast', () => {
    const b = analyze(steady()).briefing;
    expect(b.projectionSource).toBe('run-rate');
    expect(b.projected).toBeCloseTo(b.mtd + b.projectedRemaining, 6);
  });
});

describe('insights from billing data alone', () => {
  it('finds extended support, idle IPs, gp2 and NAT without any resource access', () => {
    const rows = [
      ...series('Amazon Relational Database Service', 'USE1-ExtendedSupport:Yr1-Yr2:MySQL5.7', () => 20),
      ...series('Amazon Virtual Private Cloud', 'PublicIPv4:IdleAddress', () => 3),
      ...series('EC2 - Other', 'EBS:VolumeUsage.gp2', () => 50),
      ...series('EC2 - Other', 'NatGateway-Bytes', () => 30),
    ];
    const ids = analyze(emptySnapshot(rows)).insights.map((i) => i.id);
    expect(ids).toContain('ext-support-Amazon Relational Database Service');
    expect(ids).toContain('idle-ipv4');
    expect(ids).toContain('gp2-gp3');
    expect(ids).toContain('nat-bytes');
  });
  it('gp2 savings are 20% of gp2 spend', () => {
    const r = analyze(emptySnapshot(series('EC2 - Other', 'EBS:VolumeUsage.gp2', () => 50)));
    expect(r.insights.find((i) => i.id === 'gp2-gp3')!.monthlySavings).toBeCloseTo(300, 0);
  });
  it('produces nothing for an empty account', () => {
    const r = analyze(emptySnapshot([]));
    expect(r.insights).toHaveLength(0);
    expect(r.anomalies).toHaveLength(0);
    expect(r.briefing.mtd).toBe(0);
  });
});

describe('demo account', () => {
  const snap = demoSnapshot(TODAY);
  const r = analyze(snap);

  it('demo cube answers queries consistently', () => {
    const cube = buildCube(TODAY);
    const all = sum(demoQuery(cube, { start: addDays(TODAY, -30), end: TODAY, granularity: 'DAILY', groupBy: [] }).rows.map((x) => x.cost));
    const bySvc = sum(demoQuery(cube, { start: addDays(TODAY, -30), end: TODAY, granularity: 'MONTHLY', groupBy: ['SERVICE'] }).rows.map((x) => x.cost));
    expect(bySvc).toBeCloseTo(all, 4);
    const filtered = demoQuery(cube, { start: addDays(TODAY, -30), end: TODAY, granularity: 'DAILY', groupBy: ['USAGE_TYPE'], filters: { SERVICE: ['AmazonCloudWatch'] } }).rows;
    expect(filtered.length).toBeGreaterThan(0);
    expect(sum(filtered.map((x) => x.cost))).toBeLessThan(all);
  });

  it('tells the planted stories', () => {
    expect(r.anomalies.some((a) => /Log ingestion/.test(a.title) && a.ongoing)).toBe(true);
    expect(r.anomalies.some((a) => /NAT Gateway/.test(a.title) && !a.ongoing)).toBe(true);
    expect(r.anomalies.some((a) => a.kind === 'new' && /Bedrock/.test(a.title))).toBe(true);
    expect(r.insights.some((i) => i.id === 'cw-dashboards')).toBe(true);
    expect(r.insights.some((i) => i.id === 'cw-log-retention')).toBe(true);
    expect(r.insights.some((i) => i.id === 'sp-buy-Compute')).toBe(true);
    expect(r.commitments.expirations[0].daysLeft).toBe(19);
  });

  it('does not double-count what the Hub already reports', () => {
    expect(r.insights.some((i) => i.id === 'gp2-gp3')).toBe(false);
    expect(r.insights.filter((i) => /Savings Plan:/.test(i.title))).toHaveLength(1);
  });

  it('totals add up and urgent items sort first', () => {
    expect(r.totalMonthlySavings).toBeCloseTo(sum(r.insights.map((i) => i.monthlySavings)), 6);
    const firstCalm = r.insights.findIndex((i) => !i.urgent);
    expect(r.insights.slice(firstCalm).every((i) => !i.urgent)).toBe(true);
    expect(r.briefing.projected).toBeGreaterThan(r.briefing.mtd);
  });

  it('exports a markdown briefing', () => {
    const md = reportMarkdown(snap, r);
    expect(md).toContain('# CloudPennies briefing');
    expect(md).toContain('## Savings opportunities');
  });

  it('works on the first of the month', () => {
    const first = analyze(demoSnapshot('2026-12-01'));
    expect(first.briefing.monthLabel).toBe('November');
    expect(first.briefing.mtd).toBeGreaterThan(50000);
  });
});
