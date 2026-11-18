import { describe, expect, it } from 'vitest';
import { analyze } from '../src/core/analysis';
import { describeUsage, instanceFamily, shortService, stripRegion } from '../src/core/catalog';
import { demoQuery, buildCube, demoHistory, demoSnapshot } from '../src/core/demo';
import { appendHistory, diffAlerts, digestText, progress, summarize } from '../src/core/history';
import { diagnostics, isLastDayPartial, reconcile } from '../src/core/reconcile';
import { reportMarkdown } from '../src/core/exportReport';
import { investigationPrompt } from '../src/core/investigate';
import type { CostRow, Snapshot } from '../src/core/types';
import { DEFAULT_SETTINGS } from '../src/core/types';
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
    expect(analyze(snap, { ...DEFAULT_SETTINGS, anomalyMinImpact: 25 }).anomalies).toHaveLength(1);
    expect(analyze(snap, { ...DEFAULT_SETTINGS, anomalyMinImpact: 500 }).anomalies).toHaveLength(0);
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

describe('investigation prompt', () => {
  const snap = demoSnapshot(TODAY);
  const r = analyze(snap);
  const prompts = r.anomalies.map((a) => ({ a, p: investigationPrompt(a, snap) }));

  it('is generated for every anomaly and states the read-only rules up front', () => {
    expect(prompts.length).toBeGreaterThan(3);
    for (const { p } of prompts) {
      expect(p).toContain('**This is a read-only investigation.**');
      expect(p).toContain('**Never change anything.**');
      expect(p).toContain('**Do not fix the problem**');
      expect(p.indexOf('## Hard rules')).toBeLessThan(p.indexOf('## The anomaly'));
      expect(p).toContain('aws sts get-caller-identity');
      expect(p).toContain('**Commands run**');
    }
  });

  it('never tells the agent to run a mutating AWS command', () => {
    const MUTATING = /^(create|put|update|modify|delete|remove|terminate|stop|start|reboot|run|attach|detach|associate|disassociate|tag|untag|set|enable|disable|register|deregister|invoke|send|publish|purchase|cancel|restore|copy|import|apply|execute)(-|$)/;
    for (const { p } of prompts) {
      // everything outside the "Hard rules" section (which names forbidden verbs in order to forbid them)
      const body = p.slice(p.indexOf('## The anomaly'));
      for (const m of body.matchAll(/aws\s+([a-z0-9-]+)\s+([a-z0-9-]+)/g)) {
        expect(MUTATING.test(m[2]), `suggested command: aws ${m[1]} ${m[2]}`).toBe(false);
      }
    }
  });

  it('carries the facts of the anomaly and service-specific steps', () => {
    const logs = prompts.find(({ a }) => /Log ingestion/.test(a.title))!;
    expect(logs.p).toContain('DataProcessing-Bytes');
    expect(logs.p).toContain('IncomingBytes');
    expect(logs.p).toContain(logs.a.start);
    expect(logs.p).toContain('"Key":"SERVICE","Values":["AmazonCloudWatch"]');
    const nat = prompts.find(({ a }) => /NAT Gateway/.test(a.title))!;
    expect(nat.p).toContain('describe-nat-gateways');
    const bedrock = prompts.find(({ a }) => /Bedrock/.test(a.title))!;
    expect(bedrock.p).toContain('ModelId');
    const ext = prompts.find(({ a }) => /Extended Support/.test(a.title) && /Relational/.test(a.service))!;
    expect(ext.p).toContain('describe-db-instances');
  });
});

describe('reconciliation', () => {
  it('passes on consistent data and offers figures to compare', () => {
    const snap = demoSnapshot(TODAY);
    const r = reconcile(snap);
    expect(r.checks.find((c) => c.id === 'slices')?.status).toBe('pass');
    expect(r.checks.some((c) => c.status === 'fail')).toBe(false);
    expect(r.compare.length).toBe(2);
    expect(r.consoleUrl).toContain('startDate=2026-10-01');
    expect(r.consoleUrl).toContain('endDate=2026-10-31');
  });

  it('fails when the same month totals differently by account', () => {
    const snap = demoSnapshot(TODAY);
    snap.dailyByAccount = snap.dailyByAccount.map((x) => ({ ...x, cost: x.cost * 1.2 }));
    const c = reconcile(snap).checks.find((x) => x.id === 'slices')!;
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('by account');
  });

  it('flags an AWS forecast that disagrees with the run rate', () => {
    const snap = demoSnapshot(TODAY);
    snap.forecast = { remaining: 500000 };
    expect(reconcile(snap).checks.find((x) => x.id === 'forecast')?.status).toBe('warn');
  });

  it('detects an incomplete last day on live data and leaves it out of the analysis', () => {
    const rows = series('S', 'u', (ago) => (ago === 1 ? 120 : 1000) * wobble(ago));
    const snap = emptySnapshot(rows);
    expect(isLastDayPartial(snap)).toBe(true);
    const r = analyze(snap);
    expect(r.briefing.dataThrough).toBe(addDays(TODAY, -2));
    expect(r.anomalies).toHaveLength(0);
    // a full last day is kept
    expect(isLastDayPartial(emptySnapshot(series('S', 'u', (ago) => 1000 * wobble(ago))))).toBe(false);
  });

  it('compares the Cost and Usage Report with Cost Explorer month by month', () => {
    const snap = demoSnapshot(TODAY);
    const ok = reconcile(snap).checks.filter((c) => c.id.startsWith('cur-'));
    expect(ok.length).toBe(2); // two complete months imported
    expect(ok.every((c) => c.status === 'pass')).toBe(true);
    snap.meta.cur!.months[1].cost *= 0.8;
    expect(reconcile(snap).checks.filter((c) => c.id.startsWith('cur-') && c.status === 'warn')).toHaveLength(1);
  });

  it('diagnostics carry totals but no account ids or resource names', () => {
    const snap = demoSnapshot(TODAY);
    const d = diagnostics(snap);
    expect(() => JSON.parse(d)).not.toThrow();
    for (const a of snap.accounts) expect(d).not.toContain(a.id);
    expect(d).not.toContain('/ecs/checkout-api');
    expect(d).not.toContain('vol-0');
  });
});

describe('history, alerts and progress', () => {
  const snap = demoSnapshot(TODAY);
  const r = analyze(snap);
  const cur = summarize(snap, r);

  it('says nothing on the very first scan', () => {
    expect(diffAlerts(null, cur)).toHaveLength(0);
  });

  it('alerts on a new ongoing anomaly, once', () => {
    const prev = { ...cur, anomalies: {} };
    const alerts = diffAlerts(prev, cur).filter((a) => a.kind === 'anomaly');
    expect(alerts.length).toBe(Object.values(cur.anomalies).filter((a) => a.ongoing).length);
    expect(diffAlerts(cur, cur)).toHaveLength(0);
  });

  it('alerts when a commitment crosses an expiry threshold, not every day', () => {
    const id = Object.keys(cur.expirations)[0]; // 19 days left
    const at = (daysLeft: number) => ({ ...cur, expirations: { [id]: { ...cur.expirations[id], daysLeft } } });
    expect(diffAlerts(at(31), at(30)).filter((a) => a.kind === 'expiry')).toHaveLength(1);
    expect(diffAlerts(at(30), at(29)).filter((a) => a.kind === 'expiry')).toHaveLength(0);
    expect(diffAlerts(at(15), at(14)).filter((a) => a.kind === 'expiry')).toHaveLength(1);
    // first time we ever see it, already inside a threshold
    expect(diffAlerts({ ...cur, expirations: {} }, at(19)).filter((a) => a.kind === 'expiry')).toHaveLength(1);
  });

  it('groups several new opportunities into one alert', () => {
    const prev = { ...cur, insights: {} };
    const a = diffAlerts(prev, cur).filter((x) => x.kind === 'savings');
    expect(a).toHaveLength(1);
    expect(a[0].title).toMatch(/new savings opportunities/);
  });

  it('keeps one history entry per day', () => {
    const h = appendHistory(appendHistory([], cur), { ...cur, at: cur.at.replace('T', 'T') + '' });
    expect(h).toHaveLength(1);
    const next = { ...cur, today: addDays(TODAY, 1), at: addDays(TODAY, 1) + 'T09:00:00Z' };
    expect(appendHistory(h, next)).toHaveLength(2);
  });

  it('counts opportunities that disappeared as resolved savings', () => {
    const history = demoHistory(TODAY, r);
    const p = progress(history, r);
    expect(p.scans).toBe(8);
    expect(p.resolved.map((x) => x.id)).toContain('demo-dev-nightly');
    expect(p.realizedMonthly).toBe(412 + 690 + 530 + 340 + 1180);
    expect(p.anomaliesCleared).toBe(1);
    // still-open opportunities are not counted
    expect(p.resolved.some((x) => x.id === 'sp-buy-Compute')).toBe(false);
  });

  it('writes a digest', () => {
    const t = digestText(snap, r, progress(demoHistory(TODAY, r), r));
    expect(t).toContain('Top opportunities');
    expect(t).toContain('Resolved since');
  });
});
