import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  bucketByMonth,
  buildCostAndUsageRequest,
  buildFilter,
  buildResourceCostRequest,
  cacheKey,
  cacheTtlMs,
  clampEnd,
  isFresh,
  mapCostAndUsage,
  matchAllExpression,
  normalizeResourceKeys,
  QUERY_TTL_MS,
  SETTLED_TTL_MS,
  stripTagKey,
  totalsByKey,
  usesResourceId,
} from '../electron/aws/ce';
import { classifyError, deniedAction, friendlyConnectError, maskKeyId, RESOURCE_LEVEL_DISABLED_MESSAGE, resourceCostError, WarningSink } from '../electron/aws/errors';
import {
  assumeRoleWarning,
  isValidRoleName,
  memberRoleArn,
  membersNotInspectedWarning,
  normalizeRoleName,
  partitionOf,
  selectMemberAccounts,
  stampAccount,
  stsRegion,
} from '../electron/aws/members';
import { emptyFindings } from '../electron/aws/resources';
import {
  combineCoverage,
  commitmentTotals,
  coverageByService,
  mapAnomaly,
  mapHubRec,
  mapReservation,
  mapRightsizing,
  mapRiRecommendations,
  mapSavingsPlan,
  mapSpRecommendation,
  orderTagKeys,
  parseDashboardName,
  parseStoppedSince,
  pickPrimaryTagKey,
  selectRegions,
} from '../electron/aws/mappers';
import { toIsoDate } from '../electron/aws/dates';
import { pool } from '../electron/aws/pool';
import { IAM_POLICY_ASSUME, IAM_POLICY_BILLING, IAM_POLICY_CUR, IAM_POLICY_SCAN, iamPolicyJson } from '../src/core/iamPolicy';
import type { AccountInfo, CostQuery, CostRow } from '../src/core/types';

const TODAY = '2026-11-18';
const NO_CREDITS = { Not: { Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit', 'Refund'] } } };
const base: CostQuery = { start: '2026-10-01', end: '2026-11-01', granularity: 'DAILY', groupBy: ['SERVICE'] };

describe('query -> GetCostAndUsage request', () => {
  it('maps metrics, period, granularity and group-by; excludes credits/refunds by default', () => {
    const req = buildCostAndUsageRequest({ ...base, groupBy: ['SERVICE', 'TAG:team'] }, 'AmortizedCost', TODAY)!;
    expect(req.TimePeriod).toEqual({ Start: '2026-10-01', End: '2026-11-01' });
    expect(req.Granularity).toBe('DAILY');
    expect(req.Metrics).toEqual(['AmortizedCost', 'UsageQuantity']);
    expect(req.GroupBy).toEqual([
      { Type: 'DIMENSION', Key: 'SERVICE' },
      { Type: 'TAG', Key: 'team' },
    ]);
    expect(req.Filter).toEqual(NO_CREDITS);
  });

  it('omits GroupBy when ungrouped', () => {
    const req = buildCostAndUsageRequest({ ...base, groupBy: [] }, 'UnblendedCost', TODAY)!;
    expect(req.GroupBy).toBeUndefined();
  });

  it('combines a single dimension filter with the credit exclusion via And', () => {
    const req = buildCostAndUsageRequest({ ...base, filters: { SERVICE: ['Amazon S3'] } }, 'UnblendedCost', TODAY)!;
    expect(req.Filter).toEqual({ And: [{ Dimensions: { Key: 'SERVICE', Values: ['Amazon S3'] } }, NO_CREDITS] });
  });

  it('ANDs multiple dimensions, ORs values within one', () => {
    const f = buildFilter({ groupBy: [], filters: { SERVICE: ['A', 'B'], REGION: ['us-east-1'] } });
    expect(f).toEqual({
      And: [{ Dimensions: { Key: 'REGION', Values: ['us-east-1'] } }, { Dimensions: { Key: 'SERVICE', Values: ['A', 'B'] } }, NO_CREDITS],
    });
  });

  it('passes credits through untouched when grouping by RECORD_TYPE', () => {
    const req = buildCostAndUsageRequest({ ...base, groupBy: ['RECORD_TYPE'] }, 'UnblendedCost', TODAY)!;
    expect(req.Filter).toBeUndefined();
    const two = buildFilter({ groupBy: ['SERVICE', 'RECORD_TYPE'], filters: { REGION: ['eu-west-1'] } });
    expect(two).toEqual({ Dimensions: { Key: 'REGION', Values: ['eu-west-1'] } });
  });

  it('passes credits through untouched when filtering on RECORD_TYPE', () => {
    const f = buildFilter({ groupBy: ['SERVICE'], filters: { RECORD_TYPE: ['Credit'] } });
    expect(f).toEqual({ Dimensions: { Key: 'RECORD_TYPE', Values: ['Credit'] } });
    // an empty RECORD_TYPE filter is not a filter
    expect(buildFilter({ groupBy: ['SERVICE'], filters: { RECORD_TYPE: [] } })).toEqual(NO_CREDITS);
  });

  it('includeCredits disables the exclusion (used for monthlyByRecordType)', () => {
    expect(buildFilter({ groupBy: ['SERVICE'] }, { includeCredits: true })).toBeUndefined();
  });

  it('translates tag filters: values -> EQUALS, "" -> ABSENT, both -> Or', () => {
    expect(buildFilter({ groupBy: [], filters: { 'TAG:team': ['web', 'data'] } }, { includeCredits: true })).toEqual({
      Tags: { Key: 'team', Values: ['web', 'data'], MatchOptions: ['EQUALS'] },
    });
    expect(buildFilter({ groupBy: [], filters: { 'TAG:team': [''] } }, { includeCredits: true })).toEqual({
      Tags: { Key: 'team', MatchOptions: ['ABSENT'] },
    });
    expect(buildFilter({ groupBy: [], filters: { 'TAG:team': ['web', ''] } })).toEqual({
      And: [
        { Or: [{ Tags: { Key: 'team', Values: ['web'], MatchOptions: ['EQUALS'] } }, { Tags: { Key: 'team', MatchOptions: ['ABSENT'] } }] },
        NO_CREDITS,
      ],
    });
  });

  it('ignores empty filter lists', () => {
    expect(buildFilter({ groupBy: [], filters: { SERVICE: [] } }, { includeCredits: true })).toBeUndefined();
  });

  it('never asks for an end date beyond tomorrow, and skips empty periods', () => {
    expect(clampEnd('2027-01-01', TODAY)).toBe('2026-11-19');
    expect(clampEnd('2026-11-10', TODAY)).toBe('2026-11-10');
    const req = buildCostAndUsageRequest({ ...base, start: '2026-11-01', end: '2026-12-01' }, 'UnblendedCost', TODAY)!;
    expect(req.TimePeriod?.End).toBe('2026-11-19');
    expect(buildCostAndUsageRequest({ ...base, start: '2026-11-19', end: '2026-12-01' }, 'UnblendedCost', TODAY)).toBeNull();
    expect(buildCostAndUsageRequest({ ...base, start: '2026-10-05', end: '2026-10-05' }, 'UnblendedCost', TODAY)).toBeNull();
  });

  it('rejects more than two group-bys', () => {
    expect(() => buildCostAndUsageRequest({ ...base, groupBy: ['SERVICE', 'REGION', 'OPERATION'] }, 'UnblendedCost', TODAY)).toThrow();
  });
});

describe('resource-level queries (GetCostAndUsageWithResources)', () => {
  const rq: CostQuery = { start: '2026-11-10', end: '2026-11-18', granularity: 'DAILY', groupBy: ['RESOURCE_ID'] };

  it('is used when grouping by or filtering on RESOURCE_ID', () => {
    expect(usesResourceId(rq)).toBe(true);
    expect(usesResourceId({ groupBy: ['SERVICE'], filters: { RESOURCE_ID: ['i-1'] } })).toBe(true);
    expect(usesResourceId({ groupBy: ['SERVICE'], filters: { RESOURCE_ID: [] } })).toBe(false);
    expect(usesResourceId({ groupBy: ['SERVICE', 'REGION'] })).toBe(false);
  });

  it('builds a DAILY request with metrics, group-by and the usual filter translation', () => {
    const req = buildResourceCostRequest({ ...rq, groupBy: ['RESOURCE_ID', 'TAG:team'], filters: { SERVICE: ['Amazon Simple Storage Service'] } }, 'AmortizedCost', TODAY)!;
    expect(req.TimePeriod).toEqual({ Start: '2026-11-10', End: '2026-11-18' });
    expect(req.Granularity).toBe('DAILY');
    expect(req.Metrics).toEqual(['AmortizedCost', 'UsageQuantity']);
    expect(req.GroupBy).toEqual([{ Type: 'DIMENSION', Key: 'RESOURCE_ID' }, { Type: 'TAG', Key: 'team' }]);
    expect(req.Filter).toEqual({ And: [{ Dimensions: { Key: 'SERVICE', Values: ['Amazon Simple Storage Service'] } }, NO_CREDITS] });
  });

  it('translates a RESOURCE_ID filter', () => {
    const req = buildResourceCostRequest({ ...rq, groupBy: ['USAGE_TYPE'], filters: { RESOURCE_ID: ['i-1', 'i-2'] } }, 'UnblendedCost', TODAY)!;
    expect(req.Filter).toEqual({ And: [{ Dimensions: { Key: 'RESOURCE_ID', Values: ['i-1', 'i-2'] } }, NO_CREDITS] });
  });

  it('clamps the start to today-14 and makes no request for older periods', () => {
    const today = '2026-11-18';
    expect(buildResourceCostRequest({ ...rq, start: '2026-08-01', end: '2026-12-01' }, 'UnblendedCost', today)!.TimePeriod).toEqual({ Start: '2026-11-04', End: '2026-11-19' });
    expect(buildResourceCostRequest({ ...rq, start: '2026-11-04' }, 'UnblendedCost', today)!.TimePeriod!.Start).toBe('2026-11-04');
    expect(buildResourceCostRequest({ ...rq, start: '2026-10-01', end: '2026-11-04' }, 'UnblendedCost', today)).toBeNull();
    expect(buildResourceCostRequest({ ...rq, start: '2026-10-01', end: '2026-11-05' }, 'UnblendedCost', today)!.TimePeriod).toEqual({ Start: '2026-11-04', End: '2026-11-05' });
  });

  it('issues MONTHLY queries as DAILY and always sends a Filter', () => {
    const req = buildResourceCostRequest({ ...rq, granularity: 'MONTHLY' }, 'UnblendedCost', TODAY)!;
    expect(req.Granularity).toBe('DAILY');
    expect(req.Filter).toEqual(NO_CREDITS);
    // nothing to filter on (credits included on purpose): a match-everything expression keeps the request valid
    const open = buildResourceCostRequest({ ...rq, groupBy: ['RESOURCE_ID', 'RECORD_TYPE'] }, 'UnblendedCost', TODAY)!;
    expect(open.Filter).toEqual(matchAllExpression());
    expect(() => buildResourceCostRequest({ ...rq, groupBy: ['RESOURCE_ID', 'SERVICE', 'REGION'] }, 'UnblendedCost', TODAY)).toThrow(/two/);
  });

  it('buckets daily rows to the month start per key', () => {
    const rows: CostRow[] = [
      { keys: ['i-1'], date: '2026-10-30', cost: 1, usage: 2 },
      { keys: ['i-1'], date: '2026-10-31', cost: 2, usage: 2 },
      { keys: ['i-2'], date: '2026-10-31', cost: 5 },
      { keys: ['i-1'], date: '2026-11-01', cost: 4, usage: 1 },
      { keys: ['i-1'], date: '2026-11-02', cost: 8, usage: 1 },
    ];
    expect(bucketByMonth(rows)).toEqual([
      { keys: ['i-1'], date: '2026-10-01', cost: 3, usage: 4 },
      { keys: ['i-2'], date: '2026-10-01', cost: 5, usage: 0 },
      { keys: ['i-1'], date: '2026-11-01', cost: 12, usage: 2 },
    ]);
    expect(rows[0].cost).toBe(1); // input untouched
  });

  it("returns '' for costs without a resource id", () => {
    const rows = normalizeResourceKeys(
      [
        { keys: ['S3', 'NoResourceId'], date: 'd', cost: 1 },
        { keys: ['S3', ''], date: 'd', cost: 1 },
        { keys: ['S3', 'arn:aws:s3:::bucket'], date: 'd', cost: 1 },
      ],
      ['SERVICE', 'RESOURCE_ID'],
    );
    expect(rows.map((r) => r.keys[1])).toEqual(['', '', 'arn:aws:s3:::bucket']);
    expect(normalizeResourceKeys([{ keys: ['NoResourceId'], date: 'd', cost: 1 }], ['SERVICE'])[0].keys).toEqual(['NoResourceId']);
  });

  it('explains the opt-in when resource-level data is not enabled; other errors keep their classification', () => {
    const err = (name: string, message: string) => Object.assign(new Error(message), { name });
    expect(RESOURCE_LEVEL_DISABLED_MESSAGE).toBe(
      "Resource-level cost data is not enabled for this account. Turn on 'Resource-level data at daily granularity' in Billing → Cost Management preferences (free), wait up to 48 hours, then try again.",
    );
    expect(resourceCostError(err('DataUnavailableException', 'The requested data is unavailable.')).message).toBe(RESOURCE_LEVEL_DISABLED_MESSAGE);
    expect(resourceCostError(err('AccessDeniedException', 'Resource level data is an opt-in only feature.')).message).toBe(RESOURCE_LEVEL_DISABLED_MESSAGE);
    expect(resourceCostError(err('AccessDeniedException', 'User not enabled for resource level data access')).message).toBe(RESOURCE_LEVEL_DISABLED_MESSAGE);
    expect(resourceCostError(err('AccessDeniedException', 'User: arn:aws:iam::1:user/x is not authorized to perform: ce:GetCostAndUsageWithResources on resource: *')).message).toBe(
      'Access denied: ce:GetCostAndUsageWithResources',
    );
    expect(resourceCostError(err('ExpiredTokenException', 'The security token included in the request is expired')).message).toMatch(/Reconnect/);
    expect(resourceCostError(err('ThrottlingException', 'Rate exceeded')).message).toMatch(/throttled/);
    expect(resourceCostError(err('ValidationException', 'start date is too old')).message).toBe('ValidationException: start date is too old');
  });
});

describe('member accounts', () => {
  const accounts: AccountInfo[] = [
    { id: '111111111111', name: 'management' },
    { id: '222222222222', name: 'prod' },
    { id: '333333333333', name: 'dev' },
    { id: '444444444444', name: 'sandbox' },
    { id: '555555555555', name: 'closed' },
  ];
  const day = (id: string, date: string, cost: number): CostRow => ({ keys: [id], date, cost });
  const spend = [
    day('111111111111', '2026-11-01', 900),
    day('222222222222', '2026-11-01', 40),
    day('222222222222', '2026-11-02', 60),
    day('333333333333', '2026-11-01', 500),
    day('444444444444', '2026-11-01', 0.99),
    day('555555555555', '2026-09-01', 800), // before the window
  ];

  it('orders by recent spend, skips the caller, tiny and idle accounts', () => {
    const picked = selectMemberAccounts(accounts, spend, '111111111111', '2026-10-19');
    expect(picked).toEqual([
      { id: '333333333333', name: 'dev', spend: 500 },
      { id: '222222222222', name: 'prod', spend: 100 },
    ]);
  });

  it('caps the number of accounts (40 by default), keeping the biggest spenders', () => {
    const many: AccountInfo[] = Array.from({ length: 60 }, (_, i) => ({ id: String(100000000000 + i), name: `a${i}` }));
    const rows = many.map((a, i) => day(a.id, '2026-11-01', 10 + i));
    const picked = selectMemberAccounts(many, rows, '999999999999', '2026-10-19');
    expect(picked).toHaveLength(40);
    expect(picked[0].name).toBe('a59');
    expect(picked.at(-1)!.name).toBe('a20');
    expect(selectMemberAccounts(many, rows, '999999999999', '2026-10-19', { cap: 2 }).map((a) => a.name)).toEqual(['a59', 'a58']);
  });

  it('falls back to the ids in the cost rows when the account list is unavailable, ignoring non-account keys', () => {
    const picked = selectMemberAccounts([], [...spend, day('NoLinkedAccount', '2026-11-01', 50)], '111111111111', '2026-10-19');
    expect(picked.map((a) => a.id)).toEqual(['333333333333', '222222222222']);
  });

  it('builds role ARNs for the caller partition', () => {
    expect(partitionOf('arn:aws:iam::1:user/x')).toBe('aws');
    expect(partitionOf('arn:aws-us-gov:sts::1:assumed-role/a/b')).toBe('aws-us-gov');
    expect(partitionOf('arn:aws-cn:iam::1:user/x')).toBe('aws-cn');
    expect(partitionOf(undefined)).toBe('aws');
    expect(memberRoleArn('aws', '222222222222', 'CloudPenniesReadOnly')).toBe('arn:aws:iam::222222222222:role/CloudPenniesReadOnly');
    expect(memberRoleArn('aws-us-gov', '222222222222', 'R')).toBe('arn:aws-us-gov:iam::222222222222:role/R');
    expect(stsRegion('aws-cn')).toBe('cn-north-1');
    expect(normalizeRoleName('  /role/CloudPenniesReadOnly ')).toBe('CloudPenniesReadOnly');
    expect(normalizeRoleName(undefined)).toBe('');
    expect(isValidRoleName('CloudPenniesReadOnly')).toBe(true);
    expect(isValidRoleName('ops/Audit_Role-1')).toBe(true);
    expect(isValidRoleName('bad name')).toBe(false);
    expect(isValidRoleName('arn:aws:iam::1:role/x')).toBe(false);
    expect(isValidRoleName('x'.repeat(65))).toBe(false);
  });

  it('stamps every finding with its account', () => {
    const f = emptyFindings();
    f.logGroups.push({ name: 'g', region: 'r', storedBytes: 1, retentionDays: null });
    f.dashboards.push({ name: 'd', region: 'r' });
    f.volumes.push({ id: 'v', region: 'r', sizeGb: 1, type: 'gp3', attached: false });
    f.addresses.push({ ip: '1.1.1.1', region: 'r', associated: false });
    f.loadBalancers.push({ name: 'l', arn: 'a', region: 'r', type: 'network', targets: 0 });
    f.stoppedInstances.push({ id: 'i', region: 'r', type: 't3.micro', ebsGb: 8 });
    stampAccount(f, '222222222222');
    for (const list of [f.logGroups, f.dashboards, f.volumes, f.addresses, f.loadBalancers, f.stoppedInstances]) {
      expect(list.map((x: { account?: string }) => x.account)).toEqual(['222222222222']);
    }
  });

  it('writes one warning for all assume-role failures, listing at most five ids', () => {
    const w = assumeRoleWarning(['1', '2', '3', '4', '5', '6', '7'], 9, 'CloudPenniesReadOnly');
    expect(w.section).toBe('member-accounts');
    expect(w.message).toBe(
      'Could not enter 7 of 9 member accounts (1, 2, 3, 4, 5, and 2 more), so their resources were not inspected. ' +
        'Create the role "CloudPenniesReadOnly" in each member account, trusting the management account, and allow this user sts:AssumeRole on it — see docs/MEMBER_ROLE.md.',
    );
    expect(assumeRoleWarning(['222222222222'], 1, 'R').message).toMatch(/^Could not enter 1 of 1 member account \(222222222222\),/);
    const info = membersNotInspectedWarning(3);
    expect(info.section).toBe('member-accounts');
    expect(info.message).toMatch(/^Resources in 3 member accounts were not inspected/);
    expect(info.message).toMatch(/member role name in Settings/);
  });
});

describe('GetCostAndUsage response -> CostRow', () => {
  const m = (cost: string, usage = '0') => ({ UnblendedCost: { Amount: cost, Unit: 'USD' }, UsageQuantity: { Amount: usage, Unit: 'N/A' } });

  it('maps groups, strips tag prefixes, keeps account ids and drops all-zero rows', () => {
    const page = {
      ResultsByTime: [
        {
          TimePeriod: { Start: '2026-11-01', End: '2026-11-02' },
          Groups: [
            { Keys: ['123456789012', 'team$web'], Metrics: m('12.5', '3') },
            { Keys: ['123456789012', 'team$'], Metrics: m('4') },
            { Keys: ['210987654321', 'team$a$b'], Metrics: m('0', '7') },
            { Keys: ['210987654321', 'team$zero'], Metrics: m('0', '0') },
          ],
        },
      ],
    };
    expect(mapCostAndUsage(page, ['LINKED_ACCOUNT', 'TAG:team'], 'UnblendedCost')).toEqual([
      { keys: ['123456789012', 'web'], date: '2026-11-01', cost: 12.5, usage: 3 },
      { keys: ['123456789012', ''], date: '2026-11-01', cost: 4, usage: 0 },
      { keys: ['210987654321', 'a$b'], date: '2026-11-01', cost: 0, usage: 7 },
    ]);
  });

  it('uses Total when ungrouped and reads the requested cost basis', () => {
    const page: Parameters<typeof mapCostAndUsage>[0] = {
      ResultsByTime: [
        { TimePeriod: { Start: '2026-10-01', End: '2026-11-01' }, Total: { AmortizedCost: { Amount: '99.9' }, UnblendedCost: { Amount: '1' } } },
        { TimePeriod: { Start: '2026-11-01', End: '2026-11-18' }, Total: { AmortizedCost: { Amount: '0' } } },
      ],
    };
    expect(mapCostAndUsage(page, [], 'AmortizedCost')).toEqual([{ keys: [], date: '2026-10-01', cost: 99.9, usage: 0 }]);
  });

  it('keeps negative costs (credits)', () => {
    const page = { ResultsByTime: [{ TimePeriod: { Start: '2026-11-01', End: '2026-12-01' }, Groups: [{ Keys: ['Credit'], Metrics: m('-50') }] }] };
    expect(mapCostAndUsage(page, ['RECORD_TYPE'], 'UnblendedCost')[0].cost).toBe(-50);
  });

  it('stripTagKey handles odd keys', () => {
    expect(stripTagKey('team$web', 'team')).toBe('web');
    expect(stripTagKey('team$', 'team')).toBe('');
    expect(stripTagKey('aws:createdBy$IAMUser:x', 'aws:createdBy')).toBe('IAMUser:x');
    expect(stripTagKey('plain', 'team')).toBe('plain');
  });

  it('totalsByKey collapses periods', () => {
    const rows = [
      { keys: ['S3', 'us-east-1'], date: '2026-10-19', cost: 1, usage: 1 },
      { keys: ['S3', 'us-east-1'], date: '2026-11-01', cost: 2, usage: 1 },
      { keys: ['EC2', 'eu-west-1'], date: '2026-11-01', cost: 10 },
    ];
    expect(totalsByKey(rows, '2026-10-19')).toEqual([
      { keys: ['EC2', 'eu-west-1'], date: '2026-10-19', cost: 10, usage: 0 },
      { keys: ['S3', 'us-east-1'], date: '2026-10-19', cost: 3, usage: 2 },
    ]);
  });
});

describe('query cache', () => {
  it('key is stable across filter ordering but sensitive to account, basis and query', () => {
    const a = cacheKey('1', 'UnblendedCost', { ...base, filters: { SERVICE: ['A', 'B'], REGION: ['x'] } });
    const b = cacheKey('1', 'UnblendedCost', { ...base, filters: { REGION: ['x'], SERVICE: ['B', 'A'] } });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{40}$/);
    expect(cacheKey('2', 'UnblendedCost', base)).not.toBe(cacheKey('1', 'UnblendedCost', base));
    expect(cacheKey('1', 'AmortizedCost', base)).not.toBe(cacheKey('1', 'UnblendedCost', base));
    expect(cacheKey('1', 'UnblendedCost', { ...base, end: '2026-11-02' })).not.toBe(cacheKey('1', 'UnblendedCost', base));
    expect(cacheKey('1', 'UnblendedCost', { ...base, groupBy: ['SERVICE', 'REGION'] })).not.toBe(
      cacheKey('1', 'UnblendedCost', { ...base, groupBy: ['REGION', 'SERVICE'] }),
    );
    expect(cacheKey('1', 'UnblendedCost', { ...base, filters: {} })).toBe(cacheKey('1', 'UnblendedCost', base));
  });

  it('TTL is 6h for recent periods and 7d once the period ended before today-3', () => {
    expect(cacheTtlMs({ end: '2026-11-19' }, TODAY)).toBe(QUERY_TTL_MS);
    expect(cacheTtlMs({ end: '2026-11-16' }, TODAY)).toBe(QUERY_TTL_MS); // last day = today-3
    expect(cacheTtlMs({ end: '2026-11-15' }, TODAY)).toBe(SETTLED_TTL_MS); // last day = today-4
    expect(cacheTtlMs({ end: '2026-01-01' }, TODAY)).toBe(SETTLED_TTL_MS);
    expect(QUERY_TTL_MS).toBe(6 * 3600_000);
    expect(SETTLED_TTL_MS).toBe(7 * 24 * 3600_000);
  });

  it('isFresh', () => {
    expect(isFresh(1000, 500, 1400)).toBe(true);
    expect(isFresh(1000, 500, 1500)).toBe(false);
    expect(isFresh(2000, 500, 1000)).toBe(false); // clock went backwards
  });
});

describe('region selection', () => {
  const row = (service: string, region: string, cost: number) => ({ keys: [service, region], date: '2026-10-19', cost });
  it('sums per region, ignores pseudo regions and small spend, sorts by spend', () => {
    const rows = [
      row('EC2', 'us-east-1', 50),
      row('S3', 'us-east-1', 25),
      row('EC2', 'eu-west-1', 200),
      row('Route 53', 'global', 500),
      row('Tax', 'NoRegion', 500),
      row('Support', '', 500),
      row('S3', 'ap-south-1', 0.6),
      row('Lambda', 'ap-south-1', 0.4),
      row('EC2', 'us-gov-west-1', 3),
    ];
    expect(selectRegions(rows)).toEqual(['eu-west-1', 'us-east-1', 'us-gov-west-1']);
  });
  it('caps at 12', () => {
    const rows = Array.from({ length: 20 }, (_, i) => row('EC2', `eu-west-${i + 1}`, 100 - i));
    const r = selectRegions(rows);
    expect(r).toHaveLength(12);
    expect(r[0]).toBe('eu-west-1');
  });
});

describe('error -> ScanWarning', () => {
  const err = (name: string, message: string, extra: object = {}) => Object.assign(new Error(message), { name, ...extra });

  it('names the denied IAM action from the message', () => {
    const w = classifyError(
      'budgets',
      err('AccessDeniedException', 'User: arn:aws:iam::1:user/x is not authorized to perform: budgets:ViewBudget on resource: arn:aws:budgets::1:budget/*'),
      'budgets:Other',
    );
    expect(w).toEqual({ section: 'budgets', message: 'Access denied: budgets:ViewBudget', missingPermission: 'budgets:ViewBudget' });
    expect(deniedAction('is not authorized to perform: ce:GetCostAndUsage on resource')).toBe('ce:GetCostAndUsage');
  });

  it('falls back to the expected action (EC2 UnauthorizedOperation has no action in old messages)', () => {
    const w = classifyError('volumes', err('UnauthorizedOperation', 'You are not authorized to perform this operation.'), 'ec2:DescribeVolumes');
    expect(w.missingPermission).toBe('ec2:DescribeVolumes');
    expect(w.message).toBe('Access denied: ec2:DescribeVolumes');
  });

  it('recognises opt-in features even when reported as AccessDenied', () => {
    const hub = classifyError('cost-optimization-hub', err('AccessDeniedException', 'Account 123 is not enrolled in Cost Optimization Hub'), 'cost-optimization-hub:ListRecommendations');
    expect(hub.missingPermission).toBeUndefined();
    expect(hub.message).toMatch(/^Cost Optimization Hub is not enabled/);
    const rs = classifyError('rightsizing', err('AccessDeniedException', 'Rightsizing EC2 recommendation is an opt-in only feature. You can enable this feature from the PAYER account.'));
    expect(rs.message).toMatch(/rightsizing recommendations is not enabled/i);
    // a genuine IAM denial for the hub is still a permission problem
    const denied = classifyError('cost-optimization-hub', err('AccessDeniedException', 'User x is not authorized to perform: cost-optimization-hub:ListRecommendations'));
    expect(denied.missingPermission).toBe('cost-optimization-hub:ListRecommendations');
  });

  it('phrases data-unavailable, throttling, credential and network errors', () => {
    expect(classifyError('forecast', err('DataUnavailableException', 'Insufficient data')).message).toMatch(/no data for this yet/);
    expect(classifyError('costs', err('ThrottlingException', 'Rate exceeded')).message).toMatch(/throttled/);
    expect(classifyError('costs', err('ExpiredTokenException', 'expired')).message).toMatch(/credentials/);
    expect(classifyError('costs', Object.assign(new Error('getaddrinfo ENOTFOUND ce.us-east-1.amazonaws.com'), { code: 'ENOTFOUND' })).message).toMatch(/Could not reach AWS/);
    expect(classifyError('x', err('WeirdException', 'something  odd\nhappened')).message).toBe('WeirdException: something odd happened');
    expect(classifyError('x', 'plain string').message).toContain('plain string');
  });

  it('WarningSink keeps one warning per missing permission across regions', () => {
    const sink = new WarningSink();
    for (let i = 0; i < 5; i++) sink.add(classifyError('log-groups', err('AccessDeniedException', 'no'), 'logs:DescribeLogGroups'));
    sink.add(classifyError('alarms', err('AccessDeniedException', 'no'), 'cloudwatch:DescribeAlarms'));
    expect(sink.list.map((w) => w.missingPermission)).toEqual(['logs:DescribeLogGroups', 'cloudwatch:DescribeAlarms']);
  });

  it('connection errors are friendly and key ids are masked', () => {
    expect(friendlyConnectError(err('InvalidClientTokenId', 'x'), 'keys')).toMatch(/doesn't recognize/);
    expect(friendlyConnectError(err('SignatureDoesNotMatch', 'x'), 'keys')).toMatch(/secret access key/);
    expect(friendlyConnectError(err('ExpiredToken', 'x'), 'profile')).toMatch(/sso login/);
    expect(maskKeyId('AKIAIOSFODNN7EXAMPLE')).toBe('AKIA…MPLE');
    expect(maskKeyId('AKIAIOSFODNN7EXAMPLE')).not.toContain('IOSFODNN7');
  });
});

describe('commitment mappers', () => {
  it('maps a Savings Plan with full attributes', () => {
    const sp = mapSavingsPlan(
      {
        SavingsPlanArn: 'arn:aws:savingsplans::1:savingsplan/abc',
        Attributes: {
          SavingsPlansType: 'EC2InstanceSavingsPlans',
          PaymentOption: 'No Upfront',
          HourlyCommitment: '2.5',
          StartDateTime: '2025-03-01T00:00:00.000Z',
          EndDateTime: '2028-03-01T00:00:00.000Z',
          Region: 'us-east-1',
          InstanceFamily: 'm6i',
          PurchaseTerm: '3yr',
        },
        Utilization: { TotalCommitment: '1800', UsedCommitment: '1620', UnusedCommitment: '180', UtilizationPercentage: '90' },
        Savings: { NetSavings: '400', OnDemandCostEquivalent: '2020' },
      },
      30,
    );
    expect(sp).toEqual({
      id: 'arn:aws:savingsplans::1:savingsplan/abc',
      type: 'EC2Instance',
      region: 'us-east-1',
      instanceFamily: 'm6i',
      paymentOption: 'No Upfront',
      termYears: 3,
      hourlyCommitment: 2.5,
      start: '2025-03-01',
      end: '2028-03-01',
      utilizationPct: 90,
      usedCommitment: 1620,
      unusedCommitment: 180,
      netSavings: 400,
    });
  });

  it('survives missing Savings Plan attributes', () => {
    const sp = mapSavingsPlan({ SavingsPlanArn: 'arn', Attributes: { SavingsPlansType: 'ComputeSavingsPlans' }, Utilization: { TotalCommitment: '720', UsedCommitment: '360' } }, 30);
    expect(sp.type).toBe('Compute');
    expect(sp.hourlyCommitment).toBe(1);
    expect(sp.utilizationPct).toBe(50);
    expect(sp.unusedCommitment).toBe(360);
    expect(sp.termYears).toBe(1);
    expect(sp.region).toBeUndefined();
  });

  it('maps a reservation and estimates unused cost', () => {
    const r = mapReservation(
      {
        Key: 'SUBSCRIPTION_ID',
        Value: '9876',
        Attributes: {
          service: 'Amazon Relational Database Service',
          instanceType: 'db.r6g.xlarge',
          region: 'eu-west-1',
          numberOfInstances: '2',
          platform: 'PostgreSQL',
          offeringType: 'Partial Upfront',
          startDateTime: '2026-01-10T00:00:00.000Z',
          endDateTime: '2027-01-10T00:00:00.000Z',
        },
        Utilization: {
          UtilizationPercentage: '75',
          PurchasedHours: '1440',
          UnusedHours: '360',
          AmortizedUpfrontFee: '100',
          AmortizedRecurringFee: '300',
          NetRISavings: '150',
        },
      },
      'fallback',
    );
    expect(r).toMatchObject({
      id: '9876',
      service: 'Amazon Relational Database Service',
      instanceType: 'db.r6g.xlarge',
      region: 'eu-west-1',
      count: 2,
      platform: 'PostgreSQL',
      offeringType: 'Partial Upfront',
      termYears: 1,
      start: '2026-01-10',
      end: '2027-01-10',
      utilizationPct: 75,
      unusedHours: 360,
      amortizedCost: 400,
      unusedCost: 100,
      netSavings: 150,
    });
    expect(mapReservation({ Value: 'x' }, 'Amazon ElastiCache')).toMatchObject({ service: 'Amazon ElastiCache', count: 1, unusedCost: 0, end: '' });
  });

  it('combines SP and RI coverage without double counting SP-eligible services', () => {
    const ec2 = 'Amazon Elastic Compute Cloud - Compute';
    const rds = 'Amazon Relational Database Service';
    const ri = [
      { service: ec2, date: '2026-11-01', reservedHours: 10, onDemandHours: 90, totalHours: 100, onDemandCost: 9 },
      { service: rds, date: '2026-11-01', reservedHours: 24, onDemandHours: 24, totalHours: 48, onDemandCost: 12 },
      { service: rds, date: '2026-11-02', reservedHours: 48, onDemandHours: 0, totalHours: 48, onDemandCost: 0 },
    ];
    const cov = combineCoverage(
      [
        { date: '2026-11-02', covered: 5, onDemand: 6 },
        { date: '2026-11-01', covered: 5, onDemand: 7 },
      ],
      ri,
      new Map([[rds, 0.4]]),
      new Set([ec2]),
    );
    expect(cov.map((c) => c.date)).toEqual(['2026-11-01', '2026-11-02']);
    // day 1: SP 5 + EC2 RI 10h × (9/90) + RDS RI 24h × 0.4 ; on-demand: SP 7 + RDS 12 (EC2's 9 is already in the SP figure)
    expect(cov[0].covered).toBeCloseTo(5 + 1 + 9.6);
    expect(cov[0].onDemand).toBeCloseTo(19);
    expect(cov[1].covered).toBeCloseTo(5 + 19.2);
    expect(cov[1].onDemand).toBeCloseTo(6);

    const by = coverageByService([{ service: ec2, covered: 30, onDemand: 70 }, { service: 'AWS Lambda', covered: 0, onDemand: 0 }], ri);
    expect(by).toEqual([
      { service: ec2, kind: 'SP', coveragePct: 30, onDemandCost: 70 },
      { service: rds, kind: 'RI', coveragePct: 75, onDemandCost: 12 },
      { service: ec2, kind: 'RI', coveragePct: 10, onDemandCost: 0 },
    ]);

    const totals = commitmentTotals(
      [{ usedCommitment: 90, unusedCommitment: 10, netSavings: 20 } as never],
      [{ amortizedCost: 40, unusedCost: 4, netSavings: 6 } as never],
      cov,
      '2026-11-02',
    );
    expect(totals).toMatchObject({ spCommitment: 100, spUsed: 90, riAmortized: 40, riUnused: 4, netSavings: 26, onDemandEligible: 6 });
    expect(totals.onDemandEquivalentCovered).toBeCloseTo(24.2);
  });

  it('maps Savings Plans purchase recommendations (null when nothing is recommended)', () => {
    const req = { type: 'COMPUTE_SP', term: 'THREE_YEARS', payment: 'NO_UPFRONT', lookback: 'THIRTY_DAYS' };
    expect(mapSpRecommendation(undefined, [], req)).toBeNull();
    expect(mapSpRecommendation({ SavingsPlansPurchaseRecommendationSummary: { HourlyCommitmentToPurchase: '0' } }, [], req)).toBeNull();
    const details = [
      { HourlyCommitmentToPurchase: '1', UpfrontCost: '0', EstimatedAverageUtilization: '100' },
      { HourlyCommitmentToPurchase: '3', UpfrontCost: '10', EstimatedAverageUtilization: '80' },
    ];
    const rec = mapSpRecommendation(
      {
        SavingsPlansType: 'COMPUTE_SP',
        TermInYears: 'THREE_YEARS',
        PaymentOption: 'NO_UPFRONT',
        LookbackPeriodInDays: 'THIRTY_DAYS',
        SavingsPlansPurchaseRecommendationSummary: {
          HourlyCommitmentToPurchase: '4',
          EstimatedMonthlySavingsAmount: '900',
          EstimatedSavingsPercentage: '31.5',
          CurrentOnDemandSpend: '3000',
        },
      },
      details,
      req,
    )!;
    expect(rec).toMatchObject({ type: 'Compute', termYears: 3, paymentOption: 'No Upfront', lookbackDays: 30, hourlyCommitment: 4, upfrontCost: 10, estimatedMonthlySavings: 900, estimatedSavingsPct: 31.5 });
    expect(rec.currentMonthlyOnDemand).toBeCloseTo(3043.75);
    expect(rec.estimatedUtilizationPct).toBeCloseTo(85);
  });

  it('maps reservation purchase recommendations for different services', () => {
    const recs = mapRiRecommendations('Amazon Relational Database Service', [
      {
        TermInYears: 'ONE_YEAR',
        PaymentOption: 'NO_UPFRONT',
        LookbackPeriodInDays: 'THIRTY_DAYS',
        RecommendationDetails: [
          {
            AccountId: '111',
            InstanceDetails: { RDSInstanceDetails: { InstanceType: 'db.m6g.large', Region: 'us-east-1', DatabaseEngine: 'MySQL', DeploymentOption: 'Multi-AZ' } },
            RecommendedNumberOfInstancesToPurchase: '3',
            EstimatedMonthlySavingsAmount: '120.5',
            EstimatedMonthlySavingsPercentage: '28',
            EstimatedBreakEvenInMonths: '0',
            UpfrontCost: '0',
            RecurringStandardMonthlyCost: '310',
          },
          { InstanceDetails: { ESInstanceDetails: { InstanceClass: 'r6g', InstanceSize: 'large', Region: 'eu-west-1' } }, RecommendedNumberOfInstancesToPurchase: '2', EstimatedMonthlySavingsAmount: '200' },
          { RecommendedNumberOfInstancesToPurchase: '0', EstimatedMonthlySavingsAmount: '0' },
        ],
      },
    ]);
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ instanceType: 'r6g.large', region: 'eu-west-1', count: 2, estimatedMonthlySavings: 200 });
    expect(recs[1]).toEqual({
      service: 'Amazon Relational Database Service',
      instanceType: 'db.m6g.large',
      region: 'us-east-1',
      platform: 'MySQL Multi-AZ',
      count: 3,
      termYears: 1,
      paymentOption: 'No Upfront',
      lookbackDays: 30,
      upfrontCost: 0,
      recurringMonthlyCost: 310,
      estimatedMonthlySavings: 120.5,
      estimatedSavingsPct: 28,
      breakEvenMonths: 0,
      account: '111',
    });
  });
});

describe('other mappers', () => {
  it('rightsizing: modify picks the default target, terminate uses its own savings', () => {
    const cur = { ResourceId: 'i-1', InstanceName: 'api', MonthlyCost: '140', ResourceDetails: { EC2ResourceDetails: { InstanceType: 'm5.2xlarge', Region: 'us-east-1' } }, ResourceUtilization: { EC2ResourceUtilization: { MaxCpuUtilizationPercentage: '11.2' } } };
    const mod = mapRightsizing({
      AccountId: '1',
      RightsizingType: 'MODIFY',
      CurrentInstance: cur,
      ModifyRecommendationDetail: {
        TargetInstances: [
          { EstimatedMonthlySavings: '90', ResourceDetails: { EC2ResourceDetails: { InstanceType: 'm5.large' } } },
          { EstimatedMonthlySavings: '70', DefaultTargetInstance: true, ResourceDetails: { EC2ResourceDetails: { InstanceType: 'm5.xlarge' } } },
        ],
      },
    });
    expect(mod).toEqual({ resourceId: 'i-1', name: 'api', account: '1', region: 'us-east-1', currentType: 'm5.2xlarge', action: 'MODIFY', targetType: 'm5.xlarge', currentMonthlyCost: 140, monthlySavings: 70, maxCpuPct: 11.2 });
    const term = mapRightsizing({ RightsizingType: 'TERMINATE', CurrentInstance: cur, TerminateRecommendationDetail: { EstimatedMonthlySavings: '140' } });
    expect(term).toMatchObject({ action: 'TERMINATE', monthlySavings: 140 });
    expect(term!.targetType).toBeUndefined();
    expect(mapRightsizing({ RightsizingType: 'MODIFY', CurrentInstance: cur })).toBeNull();
  });

  it('hub recommendation and anomaly', () => {
    expect(
      mapHubRec({ recommendationId: 'r1', resourceId: 'vol-1', currentResourceType: 'EbsVolume', actionType: 'Upgrade', estimatedMonthlySavings: 12, estimatedSavingsPercentage: 20, estimatedMonthlyCost: 60, implementationEffort: 'Low', restartNeeded: false, rollbackPossible: true, region: 'us-east-1', accountId: '1', currentResourceSummary: 'gp2', recommendedResourceSummary: 'gp3' }),
    ).toEqual({ id: 'r1', resourceId: 'vol-1', resourceType: 'EbsVolume', actionType: 'Upgrade', currentSummary: 'gp2', recommendedSummary: 'gp3', monthlySavings: 12, savingsPct: 20, currentMonthlyCost: 60, effort: 'Low', restartNeeded: false, rollbackPossible: true, region: 'us-east-1', account: '1' });
    expect(mapHubRec({}, 3)).toEqual({ id: 'hub-3', resourceType: 'Unknown', actionType: 'Unknown', monthlySavings: 0 });

    expect(
      mapAnomaly({
        AnomalyId: 'a1',
        AnomalyStartDate: '2026-10-01T00:00:00Z',
        AnomalyEndDate: '2026-10-03T00:00:00Z',
        RootCauses: [{ Service: 'Amazon EC2', Region: 'us-east-1', LinkedAccount: '1', UsageType: 'BoxUsage' }, { Service: 'other' }],
        Impact: { MaxImpact: 40, TotalImpact: 100, TotalActualSpend: 300, TotalExpectedSpend: 200 },
        AnomalyScore: { MaxScore: 1, CurrentScore: 1 },
        MonitorArn: 'm',
        Feedback: 'YES',
      }),
    ).toEqual({ id: 'a1', start: '2026-10-01', end: '2026-10-03', service: 'Amazon EC2', region: 'us-east-1', account: '1', usageType: 'BoxUsage', impact: 100, expected: 200, actual: 300, feedback: 'YES' });
  });

  it('tag key ordering and primary key choice', () => {
    expect(orderTagKeys(['aws:createdBy', 'Zeta', '', 'Zeta', 'alpha'])).toEqual(['Zeta', 'alpha', 'aws:createdBy']);
    expect(orderTagKeys(Array.from({ length: 30 }, (_, i) => `k${i}`))).toHaveLength(20);
    expect(pickPrimaryTagKey(['Name', 'Environment', 'Owner', 'TEAM'])).toBe('TEAM');
    expect(pickPrimaryTagKey(['Name', 'env', 'CostCenter'])).toBe('CostCenter');
    expect(pickPrimaryTagKey(['Name', 'App', 'env'])).toBe('App');
    expect(pickPrimaryTagKey(['Name', 'stack'])).toBe('Name');
    expect(pickPrimaryTagKey([])).toBeNull();
  });

  it('CloudTrail / EC2 parsing helpers', () => {
    expect(parseDashboardName(JSON.stringify({ eventName: 'GetDashboard', requestParameters: { dashboardName: 'ops' } }))).toBe('ops');
    expect(parseDashboardName(JSON.stringify({ requestParameters: null }))).toBeUndefined();
    expect(parseDashboardName('{not json')).toBeUndefined();
    expect(parseDashboardName(undefined)).toBeUndefined();
    expect(parseStoppedSince('User initiated (2024-01-15 10:30:00 GMT)')).toBe('2024-01-15T10:30:00Z');
    expect(parseStoppedSince('')).toBeUndefined();
    expect(toIsoDate('2027-01-10T00:00:00.000Z')).toBe('2027-01-10');
    expect(toIsoDate('01/31/2027 00:00:00')).toBe('2027-01-31');
    expect(toIsoDate('garbage')).toBeUndefined();
  });

  it('pool limits concurrency and keeps order', async () => {
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => async () => {
      peak = Math.max(peak, ++active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return i;
    });
    expect(await pool(tasks, 3)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('IAM policy', () => {
  it('docs/IAM_POLICY.json matches the exported policy', () => {
    const doc = JSON.parse(readFileSync(path.join(__dirname, '../docs/IAM_POLICY.json'), 'utf8'));
    expect(doc).toEqual(JSON.parse(iamPolicyJson(true, 'CloudPenniesReadOnly', 'YOUR-CUR-BUCKET')));
    expect(doc.Statement.map((s: { Sid: string }) => s.Sid)).toEqual([
      'CloudPenniesBilling',
      'CloudPenniesResourceScan',
      'CloudPenniesAssumeMemberRole',
      'CloudPenniesCostAndUsageReport',
      'CloudPenniesCostAndUsageReportList',
    ]);
    expect(JSON.parse(iamPolicyJson(false)).Statement).toHaveLength(1);
  });

  it('includes the Cost and Usage Report statements only for a bucket, scoping S3 access to it', () => {
    expect(JSON.parse(iamPolicyJson(true, 'CloudPenniesReadOnly')).Statement).toHaveLength(3);
    expect(JSON.parse(iamPolicyJson(true, undefined, '  ')).Statement).toHaveLength(2);
    const st = JSON.parse(iamPolicyJson(false, '', ' s3://acme-billing/reports/ ')).Statement;
    expect(st).toHaveLength(3);
    expect(st[1]).toEqual({
      Sid: 'CloudPenniesCostAndUsageReport',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:ListBucket'],
      Resource: ['arn:aws:s3:::acme-billing', 'arn:aws:s3:::acme-billing/*'],
    });
    expect(st[2]).toEqual({
      Sid: 'CloudPenniesCostAndUsageReportList',
      Effect: 'Allow',
      Action: ['bcm-data-exports:ListExports', 'bcm-data-exports:GetExport', 'cur:DescribeReportDefinitions'],
      Resource: '*',
    });
    expect([...st[1].Action, ...st[2].Action]).toEqual(IAM_POLICY_CUR);
    for (const a of IAM_POLICY_CUR) expect(a).toMatch(/:(Get|List|Describe)/);
    // every permission the importer names in a warning is in the policy
    const src = ['exports.ts', 'locate.ts', 'importer.ts'].map((f) => readFileSync(path.join(__dirname, '../electron/aws/cur', f), 'utf8')).join('\n');
    const named = new Set([...src.matchAll(/'((?:s3|bcm-data-exports|cur):[A-Za-z]+)'/g)].map((m) => m[1]));
    expect([...named].sort()).toEqual([...IAM_POLICY_CUR].sort());
  });

  it('includes the AssumeRole statement only for a non-empty member role name', () => {
    expect(JSON.parse(iamPolicyJson(true)).Statement).toHaveLength(2);
    expect(JSON.parse(iamPolicyJson(true, '')).Statement).toHaveLength(2);
    expect(JSON.parse(iamPolicyJson(true, '   ')).Statement).toHaveLength(2);
    const st = JSON.parse(iamPolicyJson(false, 'OrgAudit')).Statement;
    expect(st).toHaveLength(2);
    expect(st[1]).toEqual({ Sid: 'CloudPenniesAssumeMemberRole', Effect: 'Allow', Action: IAM_POLICY_ASSUME, Resource: 'arn:aws:iam::*:role/OrgAudit' });
    expect(IAM_POLICY_ASSUME).toEqual(['sts:AssumeRole']);
    expect(IAM_POLICY_BILLING).toContain('ce:GetCostAndUsageWithResources');
  });

  it('docs/member-role.yaml grants exactly the resource-scan actions and trusts only the management account', () => {
    const yaml = readFileSync(path.join(__dirname, '../docs/member-role.yaml'), 'utf8');
    const actions = [...yaml.matchAll(/^\s+- ([a-z0-9-]+:[A-Za-z]+)\s*$/gm)].map((m) => m[1]);
    expect(actions).toEqual(IAM_POLICY_SCAN);
    expect(yaml).toContain("AWS: !Sub 'arn:${AWS::Partition}:iam::${ManagementAccountId}:root'");
    expect(yaml).toMatch(/RoleName:[\s\S]*?Default: CloudPenniesReadOnly/);
    expect(yaml.match(/sts:AssumeRole/g)).toHaveLength(1);
  });

  it('covers every action named in collector warnings, and only read-only verbs', () => {
    const src = ['source.ts', 'resources.ts'].map((f) => readFileSync(path.join(__dirname, '../electron/aws', f), 'utf8')).join('\n');
    const named = new Set([...src.matchAll(/'((?:ce|budgets|cost-optimization-hub|logs|cloudwatch|cloudtrail|ec2|elasticloadbalancing):[A-Za-z]+)'/g)].map((m) => m[1]));
    const all = new Set([...IAM_POLICY_BILLING, ...IAM_POLICY_SCAN]);
    expect([...named].filter((a) => !all.has(a))).toEqual([]);
    expect([...all].filter((a) => !named.has(a) && a !== 'sts:GetCallerIdentity')).toEqual([]);
    for (const a of all) expect(a).toMatch(/:(Get|List|Describe|View|Lookup)/);
  });
});
