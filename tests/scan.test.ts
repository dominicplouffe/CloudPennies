// Orchestration smoke test for the live scan: every AWS client is stubbed, no network access.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { BudgetsClient } from '@aws-sdk/client-budgets';
import { CostOptimizationHubClient } from '@aws-sdk/client-cost-optimization-hub';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { createLiveSource, loadCachedSnapshot } from '../electron/aws/source';
import { DEFAULT_SETTINGS, type ScanProgress } from '../src/core/types';

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const denied = (action: string) => Object.assign(new Error(`User: arn:aws:iam::1:user/x is not authorized to perform: ${action}`), { name: 'AccessDeniedException' });
const amount = (v: number) => ({ UnblendedCost: { Amount: String(v), Unit: 'USD' }, UsageQuantity: { Amount: '1', Unit: 'N/A' } });

let dir: string;
let ceCalls: Cmd[];

function stubCe() {
  ceCalls = [];
  vi.spyOn(CostExplorerClient.prototype, 'send').mockImplementation((async (cmd: Cmd) => {
    ceCalls.push(cmd);
    const i = cmd.input;
    switch (cmd.constructor.name) {
      case 'GetCostAndUsageCommand': {
        const keys = (i.GroupBy as { Key: string }[]).map((g) => g.Key);
        const group = (k: string[], v: number) => ({ Keys: k, Metrics: amount(v) });
        let groups = [group(keys.map((k) => `${k}-value`), 5)];
        if (keys.join() === 'SERVICE,REGION') {
          groups = [group(['Amazon Relational Database Service', 'eu-west-1'], 40), group(['Amazon Simple Storage Service', 'us-east-1'], 60), group(['AWS Support', 'global'], 9)];
        }
        if (keys.join() === 'team') groups = [group(['team$web'], 3), group(['team$'], 7)];
        // two pages for the big daily query to exercise pagination + request counting
        if (keys.join() === 'SERVICE,USAGE_TYPE' && !i.NextPageToken) {
          return { ResultsByTime: [{ TimePeriod: { Start: i.TimePeriod.Start }, Groups: groups }], NextPageToken: 'p2' };
        }
        return { ResultsByTime: [{ TimePeriod: { Start: i.TimePeriod.Start }, Groups: groups }] };
      }
      case 'GetDimensionValuesCommand':
        return { DimensionValues: [{ Value: '123456789012', Attributes: { description: 'Acme Prod' } }] };
      case 'GetTagsCommand':
        return { Tags: ['Name', 'team'] };
      case 'GetCostForecastCommand':
        return { Total: { Amount: '100' }, ForecastResultsByTime: [{ MeanValue: '100', PredictionIntervalLowerBound: '80', PredictionIntervalUpperBound: '130' }] };
      case 'GetAnomaliesCommand':
        throw denied('ce:GetAnomalies');
      case 'GetSavingsPlansUtilizationDetailsCommand':
        throw Object.assign(new Error('no data'), { name: 'DataUnavailableException' });
      case 'GetRightsizingRecommendationCommand':
        throw Object.assign(new Error('Rightsizing EC2 recommendation is an opt-in only feature.'), { name: 'AccessDeniedException' });
      default:
        return {};
    }
  }) as never);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
  stubCe();
  vi.spyOn(BudgetsClient.prototype, 'send').mockImplementation((async () => ({
    Budgets: [{ BudgetName: 'Monthly', BudgetLimit: { Amount: '1000', Unit: 'USD' }, CalculatedSpend: { ActualSpend: { Amount: '400', Unit: 'USD' } }, TimeUnit: 'MONTHLY', BudgetType: 'COST' }],
  })) as never);
  vi.spyOn(CostOptimizationHubClient.prototype, 'send').mockImplementation((async () => {
    throw Object.assign(new Error('Account is not enrolled in Cost Optimization Hub'), { name: 'AccessDeniedException' });
  }) as never);
  vi.spyOn(CloudWatchLogsClient.prototype, 'send').mockImplementation((async function (this: CloudWatchLogsClient) {
    return { logGroups: [{ logGroupName: '/aws/lambda/x', storedBytes: 10 }] };
  }) as never);
  vi.spyOn(CloudWatchClient.prototype, 'send').mockImplementation((async (cmd: Cmd) =>
    cmd.constructor.name === 'ListDashboardsCommand'
      ? { DashboardEntries: [{ DashboardName: 'ops' }, { DashboardName: 'old' }] }
      : { MetricAlarms: [{ StateValue: 'INSUFFICIENT_DATA' }, { StateValue: 'OK', AlarmActions: ['arn'] }] }) as never);
  vi.spyOn(CloudTrailClient.prototype, 'send').mockImplementation((async () => ({
    Events: [{ EventTime: new Date('2026-11-10T00:00:00Z'), CloudTrailEvent: JSON.stringify({ requestParameters: { dashboardName: 'ops' } }) }],
  })) as never);
  vi.spyOn(EC2Client.prototype, 'send').mockImplementation((async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'DescribeVolumesCommand':
        return { Volumes: [{ VolumeId: 'vol-1', Size: 100, VolumeType: 'gp2', Attachments: [] }, { VolumeId: 'vol-2', Size: 50, VolumeType: 'gp3', Attachments: [{}] }] };
      case 'DescribeInstancesCommand':
        return { Reservations: [{ Instances: [{ InstanceId: 'i-1', InstanceType: 't3.micro', BlockDeviceMappings: [{ Ebs: { VolumeId: 'vol-2' } }], StateTransitionReason: 'User initiated (2026-01-01 00:00:00 GMT)' }] }] };
      case 'DescribeSnapshotsCommand':
        throw denied('ec2:DescribeSnapshots');
      default:
        return { Addresses: [{ PublicIp: '1.2.3.4', AllocationId: 'eipalloc-1' }] };
    }
  }) as never);
  vi.spyOn(ElasticLoadBalancingV2Client.prototype, 'send').mockImplementation((async (cmd: Cmd) => {
    switch (cmd.constructor.name) {
      case 'DescribeLoadBalancersCommand':
        return { LoadBalancers: [{ LoadBalancerArn: 'lb1', LoadBalancerName: 'busy', Type: 'application' }, { LoadBalancerArn: 'lb2', LoadBalancerName: 'idle', Type: 'network' }] };
      case 'DescribeTargetGroupsCommand':
        return { TargetGroups: [{ TargetGroupArn: 'tg1', LoadBalancerArns: ['lb1'] }] };
      default:
        return { TargetHealthDescriptions: [{}, {}] };
    }
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const make = (deepScan: boolean) =>
  createLiveSource({
    credentials: { accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'x'.repeat(40) },
    settings: { ...DEFAULT_SETTINGS, deepScan },
    cacheDir: dir,
    identity: { accountId: '123456789012', arn: 'arn:aws:iam::123456789012:user/x' },
    now: () => new Date('2026-11-18T10:00:00Z'),
  });

describe('scan()', () => {
  it('produces a complete snapshot, isolates failures and counts CE requests', async () => {
    const progress: ScanProgress[] = [];
    const snap = await make(true).scan((p) => progress.push(p));

    expect(snap.meta).toMatchObject({ mode: 'live', today: '2026-11-18', dataThrough: '2026-11-17', accountId: '123456789012', accountLabel: 'Acme Prod', currency: 'USD', costBasis: 'UnblendedCost', deepScan: true });
    expect(snap.meta.ceRequests).toBe(ceCalls.length);
    expect(snap.meta.regionsScanned).toEqual(['us-east-1', 'eu-west-1']);

    // periods
    const cau = ceCalls.filter((c) => c.constructor.name === 'GetCostAndUsageCommand');
    const by = (k: string) => cau.find((c) => c.input.GroupBy.map((g: { Key: string }) => g.Key).join() === k)!.input;
    expect(by('SERVICE').TimePeriod).toEqual({ Start: '2025-11-01', End: '2026-11-18' });
    expect(by('SERVICE,USAGE_TYPE').TimePeriod).toEqual({ Start: '2026-08-20', End: '2026-11-18' });
    expect(by('RECORD_TYPE').TimePeriod).toEqual({ Start: '2026-09-01', End: '2026-11-18' });
    // credits excluded everywhere except the record-type series
    expect(by('RECORD_TYPE').Filter).toBeUndefined();
    for (const k of ['SERVICE', 'SERVICE,USAGE_TYPE', 'LINKED_ACCOUNT', 'REGION', 'SERVICE,REGION', 'team']) {
      expect(by(k).Filter).toEqual({ Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } } });
    }

    expect(snap.dailyByServiceUsage).toHaveLength(2); // two pages
    expect(snap.recentByServiceRegion).toHaveLength(3);
    expect(snap.tagKeys).toEqual(['Name', 'team']);
    expect(snap.primaryTag).toEqual({ key: 'team', rows: [{ keys: [''], date: '2026-10-19', cost: 7, usage: 1 }, { keys: ['web'], date: '2026-10-19', cost: 3, usage: 1 }] });
    expect(snap.forecast).toEqual({ remaining: 100, remainingLow: 80, remainingHigh: 130 });
    expect(snap.budgets).toEqual([{ name: 'Monthly', limit: 1000, actual: 400, timeUnit: 'MONTHLY', type: 'COST' }]);
    expect(snap.awsAnomalies).toEqual([]);
    expect(snap.commitments.savingsPlans).toEqual([]);
    expect(snap.hubRecommendations).toEqual([]);

    // only services with spend are asked about reservations (RDS yes; ElastiCache, Redshift... no)
    const riRec = ceCalls.filter((c) => c.constructor.name === 'GetReservationPurchaseRecommendationCommand').map((c) => c.input.Service);
    expect(riRec).toEqual(['Amazon Relational Database Service']);
    expect(ceCalls.filter((c) => c.constructor.name === 'GetSavingsPlansPurchaseRecommendationCommand')).toHaveLength(9);

    // warnings: helpful, de-duplicated (snapshots denied in both regions -> one warning)
    const w = Object.fromEntries(snap.meta.warnings.map((x) => [x.section, x]));
    expect(w.anomalies).toMatchObject({ missingPermission: 'ce:GetAnomalies' });
    expect(w.rightsizing.message).toMatch(/not enabled/);
    expect(w['cost-optimization-hub'].message).toMatch(/Cost Optimization Hub is not enabled/);
    expect(w.snapshots).toMatchObject({ missingPermission: 'ec2:DescribeSnapshots' });
    expect(snap.meta.warnings).toHaveLength(4);

    // resources
    const r = snap.resources!;
    expect(r.logGroups).toHaveLength(2);
    expect(r.logGroups[0]).toMatchObject({ name: '/aws/lambda/x', storedBytes: 10, retentionDays: null });
    expect(r.alarms).toEqual({ total: 4, insufficientData: 2, noActions: 2 });
    expect(r.dashboards.find((d) => d.name === 'ops')!.lastViewed).toBe('2026-11-10T00:00:00.000Z');
    expect(r.dashboards.find((d) => d.name === 'old')!.lastViewed).toBeNull();
    expect(r.volumes.filter((v) => !v.attached)).toHaveLength(2);
    expect(r.stoppedInstances[0]).toMatchObject({ id: 'i-1', ebsGb: 50, stoppedSince: '2026-01-01T00:00:00Z' });
    expect(r.addresses[0]).toMatchObject({ ip: '1.2.3.4', associated: false });
    expect(r.loadBalancers.filter((l) => l.region === 'us-east-1').map((l) => [l.name, l.targets])).toEqual([['busy', 2], ['idle', 0]]);
    expect(r.oldSnapshots).toEqual({ count: 0, totalGb: 0 });

    // progress + cache
    const last = progress.at(-1)!;
    expect(last.done).toBe(last.total);
    expect(progress.every((p) => p.done <= p.total && p.step.length > 0)).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, 'snapshot-123456789012.json'), 'utf8')).meta.accountId).toBe('123456789012');
    expect(await loadCachedSnapshot(dir, '123456789012')).toEqual(JSON.parse(JSON.stringify(snap)));
    expect(await loadCachedSnapshot(dir, '999')).toBeNull();
  });

  it('skips the resource scan when deepScan is off', async () => {
    const snap = await make(false).scan();
    expect(snap.resources).toBeNull();
    expect(snap.meta.regionsScanned).toEqual([]);
  });

  it('fails with a clear message when Cost Explorer itself is denied', async () => {
    vi.spyOn(CostExplorerClient.prototype, 'send').mockImplementation((async () => {
      throw denied('ce:GetCostAndUsage');
    }) as never);
    await expect(make(false).scan()).rejects.toThrow(/ce:GetCostAndUsage/);
  });
});

describe('query()', () => {
  it('caches results on disk', async () => {
    const src = make(false);
    const q = { start: '2026-10-01', end: '2026-11-01', granularity: 'MONTHLY' as const, groupBy: ['SERVICE' as const] };
    const a = await src.query(q);
    const n = ceCalls.length;
    expect(n).toBe(1);
    expect(a.rows).toEqual([{ keys: ['SERVICE-value'], date: '2026-10-01', cost: 5, usage: 1 }]);
    expect(await make(false).query({ ...q })).toEqual(a);
    expect(ceCalls.length).toBe(n);
    await src.query({ ...q, groupBy: ['REGION'] });
    expect(ceCalls.length).toBe(n + 1);
  });
});
