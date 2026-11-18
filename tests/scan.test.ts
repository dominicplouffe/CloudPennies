// Orchestration smoke test for the live scan: every AWS client is stubbed, no network access.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CostExplorerClient } from '@aws-sdk/client-cost-explorer';
import { STSClient } from '@aws-sdk/client-sts';
import { BudgetsClient } from '@aws-sdk/client-budgets';
import { CostOptimizationHubClient } from '@aws-sdk/client-cost-optimization-hub';
import { CloudWatchLogsClient } from '@aws-sdk/client-cloudwatch-logs';
import { CloudWatchClient } from '@aws-sdk/client-cloudwatch';
import { CloudTrailClient } from '@aws-sdk/client-cloudtrail';
import { EC2Client } from '@aws-sdk/client-ec2';
import { ElasticLoadBalancingV2Client } from '@aws-sdk/client-elastic-load-balancing-v2';
import { createLiveSource, loadCachedSnapshot } from '../electron/aws/source';
import { RESOURCE_LEVEL_DISABLED_MESSAGE } from '../electron/aws/errors';
import { DEFAULT_SETTINGS, type CostQuery, type ScanProgress, type Settings } from '../src/core/types';

type Cmd = { constructor: { name: string }; input: Record<string, any> };
const denied = (action: string) => Object.assign(new Error(`User: arn:aws:iam::1:user/x is not authorized to perform: ${action}`), { name: 'AccessDeniedException' });
const amount = (v: number) => ({ UnblendedCost: { Amount: String(v), Unit: 'USD' }, UsageQuantity: { Amount: '1', Unit: 'N/A' } });

const OWN = '123456789012';
const MEMBER_A = '222222222222';
const MEMBER_B = '333333333333';
const MEMBER_TINY = '444444444444';

let dir: string;
let ceCalls: Cmd[];
/** linked accounts reported by Cost Explorer: id -> [name, spend per day] */
let org: Record<string, [string, number]>;
let stsCalls: Cmd[];
/** member accounts whose role cannot be assumed */
let lockedOut: Set<string>;
/** access key ids used for CloudTrail lookups */
let trailKeys: string[];
/** what GetCostAndUsageWithResources does */
let resourceCosts: (input: Record<string, any>) => unknown;

const keyOf = async (client: { config: { credentials: () => Promise<{ accessKeyId: string }> } }) => (await client.config.credentials()).accessKeyId;

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
        if (keys.join() === 'LINKED_ACCOUNT') {
          // one old day (outside the 30-day window used to rank member accounts) and one recent day
          const groupsAt = (scale: number) => Object.entries(org).map(([id, [, perDay]]) => group([id], perDay * scale));
          return { ResultsByTime: [{ TimePeriod: { Start: i.TimePeriod.Start }, Groups: groupsAt(1000).reverse() }, { TimePeriod: { Start: '2026-11-10' }, Groups: groupsAt(1) }] };
        }
        if (keys.join() === 'team') groups = [group(['team$web'], 3), group(['team$'], 7)];
        // two pages for the big daily query to exercise pagination + request counting
        if (keys.join() === 'SERVICE,USAGE_TYPE' && !i.NextPageToken) {
          return { ResultsByTime: [{ TimePeriod: { Start: i.TimePeriod.Start }, Groups: groups }], NextPageToken: 'p2' };
        }
        return { ResultsByTime: [{ TimePeriod: { Start: i.TimePeriod.Start }, Groups: groups }] };
      }
      case 'GetCostAndUsageWithResourcesCommand':
        return resourceCosts(i);
      case 'GetDimensionValuesCommand':
        return { DimensionValues: Object.entries(org).map(([id, [name]]) => ({ Value: id, Attributes: { description: name } })) };
      case 'GetTagsCommand':
        return { Tags: ['Name', 'team'] };
      case 'GetCostForecastCommand':
        // Total deliberately disagrees with the daily rows: the collector must sum the days, not trust Total
        return {
          Total: { Amount: '999' },
          ForecastResultsByTime: [
            { MeanValue: '60', PredictionIntervalLowerBound: '50', PredictionIntervalUpperBound: '80' },
            { MeanValue: '40', PredictionIntervalLowerBound: '30', PredictionIntervalUpperBound: '50' },
          ],
        };
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
  org = { [OWN]: ['Acme Prod', 5] };
  stsCalls = [];
  lockedOut = new Set();
  trailKeys = [];
  resourceCosts = () => ({ ResultsByTime: [] });
  stubCe();
  vi.spyOn(STSClient.prototype, 'send').mockImplementation((async (cmd: Cmd) => {
    stsCalls.push(cmd);
    const account = /::(\d{12}):role\//.exec(cmd.input.RoleArn)![1];
    if (lockedOut.has(account)) throw denied(`sts:AssumeRole on resource: ${cmd.input.RoleArn}`);
    return { Credentials: { AccessKeyId: `ASIA${account}`, SecretAccessKey: 's'.repeat(40), SessionToken: 'token', Expiration: new Date('2026-11-18T11:00:00Z') } };
  }) as never);
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
  vi.spyOn(CloudTrailClient.prototype, 'send').mockImplementation((async function (this: CloudTrailClient) {
    trailKeys.push(await keyOf(this as never));
    return { Events: [{ EventTime: new Date('2026-11-10T00:00:00Z'), CloudTrailEvent: JSON.stringify({ requestParameters: { dashboardName: 'ops' } }) }] };
  }) as never);
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

const make = (deepScan: boolean, extra: Partial<Settings> = {}) =>
  createLiveSource({
    credentials: { accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'x'.repeat(40) },
    settings: { ...DEFAULT_SETTINGS, deepScan, ...extra },
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
    expect(snap.meta.accountsScanned).toEqual([OWN]);
    expect(stsCalls).toHaveLength(0);

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
    expect(r.logGroups[0]).toMatchObject({ account: OWN, name: '/aws/lambda/x', storedBytes: 10, retentionDays: null });
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
    expect(snap.meta.accountsScanned).toEqual([]);
  });

  it('scans member accounts through the configured role and survives accounts it cannot enter', async () => {
    org = { [OWN]: ['Acme Prod', 5], [MEMBER_B]: ['Member B', 2], [MEMBER_A]: ['Member A', 9], [MEMBER_TINY]: ['Tiny', 0.005] };
    lockedOut = new Set([MEMBER_B]);
    const progress: ScanProgress[] = [];
    const snap = await make(true, { memberRoleName: ' CloudPenniesReadOnly ' }).scan((p) => progress.push(p));

    // highest spend first, tiny account skipped, own account never assumed
    expect(stsCalls.map((c) => c.input)).toEqual([
      { RoleArn: `arn:aws:iam::${MEMBER_A}:role/CloudPenniesReadOnly`, RoleSessionName: 'CloudPennies', DurationSeconds: 3600 },
      { RoleArn: `arn:aws:iam::${MEMBER_B}:role/CloudPenniesReadOnly`, RoleSessionName: 'CloudPennies', DurationSeconds: 3600 },
    ]);
    expect(snap.meta.accountsScanned).toEqual([OWN, MEMBER_A]);
    expect(snap.meta.regionsScanned).toEqual(['us-east-1', 'eu-west-1']);

    // findings of both accounts and both regions are merged, each stamped with its account
    const r = snap.resources!;
    const count = (list: { account?: string }[]) => [list.filter((x) => x.account === OWN).length, list.filter((x) => x.account === MEMBER_A).length, list.length];
    expect(count(r.logGroups)).toEqual([2, 2, 4]);
    expect(count(r.dashboards)).toEqual([4, 4, 8]);
    expect(count(r.volumes)).toEqual([4, 4, 8]);
    expect(count(r.addresses)).toEqual([2, 2, 4]);
    expect(count(r.loadBalancers)).toEqual([4, 4, 8]);
    expect(count(r.stoppedInstances)).toEqual([2, 2, 4]);
    expect(r.alarms).toEqual({ total: 8, insufficientData: 4, noActions: 4 });
    expect(r.dashboards.every((d) => (d.name === 'ops' ? d.lastViewed === '2026-11-10T00:00:00.000Z' : d.lastViewed === null))).toBe(true);
    // the CloudTrail lookup runs in each account with that account's credentials
    expect([...new Set(trailKeys)].sort()).toEqual(['AKIAFAKEFAKEFAKEFAKE', `ASIA${MEMBER_A}`]);
    expect(trailKeys).toHaveLength(4);

    // one warning for the locked-out account; permission warnings stay one per permission across accounts
    const members = snap.meta.warnings.filter((w) => w.section === 'member-accounts');
    expect(members).toHaveLength(1);
    expect(members[0].message).toMatch(new RegExp(`^Could not enter 1 of 2 member accounts \\(${MEMBER_B}\\)`));
    expect(members[0].message).toMatch(/Create the role "CloudPenniesReadOnly" in each member account.*docs\/MEMBER_ROLE\.md/);
    expect(snap.meta.warnings.filter((w) => w.missingPermission === 'ec2:DescribeSnapshots')).toHaveLength(1);
    expect(snap.meta.warnings).toHaveLength(5);

    const steps = new Set(progress.map((p) => p.step));
    expect(steps).toContain('Inspecting resources in Acme Prod (1 of 3)');
    expect(steps).toContain('Inspecting resources in Member A (2 of 3)');
    expect(steps).toContain('Could not enter Member B (3 of 3)');
    expect(progress.every((p) => p.done <= p.total)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ done: progress.at(-1)!.total });
    expect(progress.at(-1)!.total).toBe(6 + 13 + 3 * 2);
  });

  it('reports a single warning however many accounts cannot be entered', async () => {
    org = { [OWN]: ['Acme Prod', 5] };
    const ids = Array.from({ length: 7 }, (_, i) => String(500000000000 + i));
    ids.forEach((id, i) => (org[id] = [`m${i}`, 20 - i]));
    lockedOut = new Set(ids);
    const snap = await make(true, { memberRoleName: 'CloudPenniesReadOnly' }).scan();
    expect(stsCalls).toHaveLength(7);
    expect(snap.meta.accountsScanned).toEqual([OWN]);
    const members = snap.meta.warnings.filter((w) => w.section === 'member-accounts');
    expect(members).toHaveLength(1);
    expect(members[0].message).toContain(`Could not enter 7 of 7 member accounts (${ids.slice(0, 5).join(', ')}, and 2 more)`);
    expect(snap.resources!.logGroups.every((g) => g.account === OWN)).toBe(true);
  });

  it('says so when member accounts exist but no role name is set', async () => {
    org = { [OWN]: ['Acme Prod', 5], [MEMBER_A]: ['Member A', 9], [MEMBER_B]: ['Member B', 2], [MEMBER_TINY]: ['Tiny', 0.005] };
    const snap = await make(true).scan();
    expect(stsCalls).toHaveLength(0);
    expect(snap.meta.accountsScanned).toEqual([OWN]);
    const members = snap.meta.warnings.filter((w) => w.section === 'member-accounts');
    expect(members).toHaveLength(1);
    expect(members[0].message).toMatch(/^Resources in 2 member accounts were not inspected/);
    expect(members[0].message).toMatch(/Settings/);
    expect(members[0].missingPermission).toBeUndefined();
    // nothing to say when the resource scan is off
    expect((await make(false).scan()).meta.warnings.filter((w) => w.section === 'member-accounts')).toEqual([]);
  });

  it('uses the caller partition for member role ARNs', async () => {
    org = { [OWN]: ['Acme Prod', 5], [MEMBER_A]: ['Member A', 9] };
    const src = createLiveSource({
      credentials: { accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'x'.repeat(40) },
      settings: { ...DEFAULT_SETTINGS, memberRoleName: 'Audit' },
      cacheDir: dir,
      identity: { accountId: OWN, arn: `arn:aws-us-gov:iam::${OWN}:user/x` },
      now: () => new Date('2026-11-18T10:00:00Z'),
    });
    await src.scan();
    expect(stsCalls.map((c) => c.input.RoleArn)).toEqual([`arn:aws-us-gov:iam::${MEMBER_A}:role/Audit`]);
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

describe('query() by RESOURCE_ID', () => {
  const day = (date: string, groups: [string, number][]) => ({ TimePeriod: { Start: date }, Groups: groups.map(([k, v]) => ({ Keys: [k], Metrics: amount(v) })) });
  const q: CostQuery = { start: '2026-09-01', end: '2026-11-19', granularity: 'MONTHLY', groupBy: ['RESOURCE_ID'], filters: { SERVICE: ['Amazon Elastic Compute Cloud - Compute'] } };

  it('asks GetCostAndUsageWithResources for the last 14 days, daily, and buckets months client-side', async () => {
    resourceCosts = (i) =>
      i.NextPageToken
        ? { ResultsByTime: [day('2026-11-05', [['i-1', 2], ['NoResourceId', 1]])] }
        : { ResultsByTime: [day('2026-11-04', [['i-1', 3], ['i-2', 4]])], NextPageToken: 'p2' };
    const src = make(false);
    const res = await src.query(q);
    expect(ceCalls.map((c) => c.constructor.name)).toEqual(['GetCostAndUsageWithResourcesCommand', 'GetCostAndUsageWithResourcesCommand']);
    expect(ceCalls[0].input).toMatchObject({
      TimePeriod: { Start: '2026-11-04', End: '2026-11-19' },
      Granularity: 'DAILY',
      Metrics: ['UnblendedCost', 'UsageQuantity'],
      GroupBy: [{ Type: 'DIMENSION', Key: 'RESOURCE_ID' }],
      Filter: {
        And: [
          { Dimensions: { Key: 'SERVICE', Values: ['Amazon Elastic Compute Cloud - Compute'] } },
          { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } } },
        ],
      },
    });
    expect(res.rows).toEqual([
      { keys: ['i-1'], date: '2026-11-01', cost: 5, usage: 2 },
      { keys: ['i-2'], date: '2026-11-01', cost: 4, usage: 1 },
      { keys: [''], date: '2026-11-01', cost: 1, usage: 1 },
    ]);
    expect(src.queryRequests()).toBe(2); // both pages are paid requests
    // cached like any other query
    expect(await src.query({ ...q })).toEqual(res);
    expect(ceCalls).toHaveLength(2);
    expect(src.queryRequests()).toBe(2);
  });

  it('keeps daily rows for DAILY queries and also handles RESOURCE_ID as a filter', async () => {
    resourceCosts = () => ({ ResultsByTime: [day('2026-11-10', [['BoxUsage', 3]]), day('2026-11-11', [['BoxUsage', 4]])] });
    const res = await make(false).query({ start: '2026-11-10', end: '2026-11-12', granularity: 'DAILY', groupBy: ['USAGE_TYPE'], filters: { RESOURCE_ID: ['i-1'] } });
    expect(ceCalls[0].constructor.name).toBe('GetCostAndUsageWithResourcesCommand');
    expect(ceCalls[0].input.TimePeriod).toEqual({ Start: '2026-11-10', End: '2026-11-12' });
    expect(res.rows.map((r) => [r.date, r.cost])).toEqual([['2026-11-10', 3], ['2026-11-11', 4]]);
  });

  it('makes no request when the whole period is older than 14 days', async () => {
    const src = make(false);
    expect(await src.query({ ...q, start: '2026-09-01', end: '2026-10-01' })).toEqual({ rows: [] });
    expect(ceCalls).toHaveLength(0);
    expect(src.queryRequests()).toBe(0);
  });

  it('explains how to enable resource-level data, and classifies other failures', async () => {
    resourceCosts = () => {
      throw Object.assign(new Error('The requested data is unavailable.'), { name: 'DataUnavailableException' });
    };
    await expect(make(false).query(q)).rejects.toThrow(RESOURCE_LEVEL_DISABLED_MESSAGE);
    resourceCosts = () => {
      throw denied('ce:GetCostAndUsageWithResources');
    };
    await expect(make(false).query(q)).rejects.toThrow('Access denied: ce:GetCostAndUsageWithResources');
    // a failure is not cached
    resourceCosts = () => ({ ResultsByTime: [day('2026-11-04', [['i-1', 3]])] });
    expect((await make(false).query(q)).rows).toHaveLength(1);
  });
});
