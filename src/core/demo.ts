// A realistic, deterministic demo account ("Acme") so CloudPennies can be explored
// without credentials. The demo is a small OLAP cube of daily line items that
// answers the same CostQuery interface as the live Cost Explorer source, plus
// hand-authored commitments / recommendations / resource findings that are
// consistent with the cube.

import type { CostQuery, CostResult, CostRow, DataSource, Dim, HistoryEntry, HubRec, InsightCategory, LogGroupInfo, Report, Snapshot, VolumeInfo } from './types';
import { addDays, addMonths, diffDays, monthStart, rng, sum, todayIso } from './util';

interface Item {
  service: string;
  usageType: string;
  region: string;
  account: string;
  team: string;
  env: string;
  recordType: string;
  purchase: string;
  /** $ per unit of usage, to derive usage quantity */
  unitPrice: number;
  daily: Float64Array;
}

interface Spec {
  s: string; // service
  u: string; // usage type
  /** $/day today */
  base: number;
  r?: string;
  a?: string;
  team?: string;
  env?: string;
  /** monthly growth rate, e.g. 0.03 */
  g?: number;
  /** weekend dip 0..1 */
  wk?: number;
  noise?: number;
  /** started N days ago (ramps in over `ramp` days) */
  startAgo?: number;
  ramp?: number;
  /** multiplicative events [fromDaysAgo, toDaysAgo, multiplier] */
  ev?: [number, number, number][];
  price?: number;
  rec?: string;
  purchase?: string;
  /** charged as a lump on the 1st of each month (base = monthly amount) */
  monthly?: boolean;
}

const ACCOUNTS = [
  { id: '999900001111', name: 'acme-payer' },
  { id: '111122223333', name: 'acme-prod' },
  { id: '222233334444', name: 'acme-staging' },
  { id: '333344445555', name: 'acme-data' },
  { id: '444455556666', name: 'acme-sandbox' },
];
const PROD = '111122223333';
const STG = '222233334444';
const DATA = '333344445555';
const SBX = '444455556666';
const PAYER = '999900001111';

const EC2 = 'Amazon Elastic Compute Cloud - Compute';
const EC2O = 'EC2 - Other';
const RDS = 'Amazon Relational Database Service';
const S3 = 'Amazon Simple Storage Service';
const CW = 'AmazonCloudWatch';
const VPC = 'Amazon Virtual Private Cloud';
const SP = 'Savings Plans for AWS Compute usage';

const SPECS: Spec[] = [
  // ── EC2 instances (on-demand portion) ──
  { s: EC2, u: 'BoxUsage:m5.2xlarge', base: 182, team: 'checkout', wk: 0.08, g: 0.012, price: 0.384 },
  { s: EC2, u: 'BoxUsage:c5.4xlarge', base: 141, team: 'search', wk: 0.12, g: 0.02, price: 0.68 },
  { s: EC2, u: 'BoxUsage:m4.xlarge', base: 62, team: '', price: 0.2 },
  { s: EC2, u: 'BoxUsage:r5.xlarge', base: 76, a: DATA, team: 'data', g: 0.01, price: 0.252 },
  { s: EC2, u: 'BoxUsage:t2.medium', base: 18, a: STG, team: 'platform', env: 'staging', price: 0.0464 },
  { s: EC2, u: 'BoxUsage:m5.large', base: 46, a: STG, team: 'platform', env: 'staging', price: 0.096 },
  { s: EC2, u: 'BoxUsage:g5.2xlarge', base: 87, a: DATA, team: 'ml', startAgo: 47, ramp: 6, price: 1.212 },
  { s: EC2, u: 'SpotUsage:c5.2xlarge', base: 31, a: DATA, team: 'data', noise: 0.25, price: 0.13, purchase: 'Spot Instances' },
  { s: EC2, u: 'USW2-BoxUsage:m5.xlarge', base: 41, r: 'us-west-2', team: 'search', price: 0.192 },
  { s: EC2, u: 'EU-BoxUsage:m5.large', base: 35, r: 'eu-west-1', team: 'checkout', price: 0.107 },
  { s: EC2, u: 'BoxUsage:m4.large', base: 9.6, a: SBX, team: '', env: 'dev', price: 0.1 },
  { s: SP, u: 'ComputeSP:1yrNoUpfront', base: 235.2, a: PAYER, team: '', rec: 'SavingsPlanRecurringFee', price: 9.8, noise: 0, purchase: 'Savings Plans' },
  { s: SP, u: 'EC2SP:m5.3yrPartialUpfront', base: 36, a: PAYER, team: '', rec: 'SavingsPlanRecurringFee', price: 1.5, noise: 0, purchase: 'Savings Plans' },

  // ── EC2 other ──
  { s: EC2O, u: 'EBS:VolumeUsage.gp2', base: 58, team: 'checkout', g: 0.01, price: 0.1, noise: 0.01 },
  { s: EC2O, u: 'EBS:VolumeUsage.gp3', base: 22, team: 'search', g: 0.02, price: 0.08, noise: 0.01 },
  { s: EC2O, u: 'USW2-EBS:VolumeUsage.gp2', base: 9, r: 'us-west-2', team: 'search', price: 0.1, noise: 0.01 },
  { s: EC2O, u: 'EBS:VolumeUsage.gp2', base: 14, a: DATA, team: '', price: 0.1, noise: 0.01 },
  { s: EC2O, u: 'EBS:SnapshotUsage', base: 31, team: '', g: 0.035, price: 0.05, noise: 0.01 },
  { s: EC2O, u: 'NatGateway-Hours', base: 6.5, team: 'platform', price: 0.045, noise: 0 },
  { s: EC2O, u: 'NatGateway-Bytes', base: 38, team: 'platform', g: 0.02, wk: 0.15, price: 0.045, ev: [[23, 19, 4.6]] },
  { s: EC2O, u: 'DataTransfer-Regional-Bytes', base: 27, team: 'checkout', wk: 0.1, g: 0.015, price: 0.01 },
  { s: EC2O, u: 'DataTransfer-Out-Bytes', base: 44, team: 'checkout', wk: 0.18, g: 0.02, price: 0.09 },
  { s: EC2O, u: 'USE1-USW2-AWS-Out-Bytes', base: 6, team: 'search', price: 0.02 },

  // ── VPC ──
  { s: VPC, u: 'PublicIPv4:InUseAddress', base: 14.4, team: 'platform', price: 0.005, noise: 0.01 },
  { s: VPC, u: 'PublicIPv4:IdleAddress', base: 2.88, team: '', price: 0.005, noise: 0 },
  { s: VPC, u: 'VpcEndpoint-Hours', base: 4.3, team: 'platform', price: 0.01, noise: 0 },

  // ── RDS ──
  { s: RDS, u: 'Multi-AZUsage:db.r5.2xlarge', base: 96, team: 'checkout', price: 2.0, noise: 0.005 },
  { s: RDS, u: 'InstanceUsage:db.m5.large', base: 8.2, a: STG, team: 'platform', env: 'staging', price: 0.171, noise: 0.005 },
  { s: RDS, u: 'HeavyUsage:db.r5.xlarge', base: 22, team: 'search', rec: 'RIFee', price: 0.458, noise: 0, purchase: 'Reserved Instances' },
  { s: RDS, u: 'RDS:Multi-AZ-GP2-Storage', base: 21, team: 'checkout', g: 0.02, price: 0.23, noise: 0.005 },
  { s: RDS, u: 'Aurora:StorageIOUsage', base: 12, a: DATA, team: 'data', wk: 0.2, price: 0.0000002 },
  { s: RDS, u: 'RDS:ChargedBackupUsage', base: 6, team: 'checkout', g: 0.03, price: 0.095 },
  { s: RDS, u: 'ExtendedSupport:Yr1-Yr2:MySQL5.7', base: 38.4, team: 'checkout', startAgo: 68, ramp: 0, price: 0.1, noise: 0 },

  // ── S3 ──
  { s: S3, u: 'TimedStorage-ByteHrs', base: 118, a: DATA, team: 'data', g: 0.026, price: 0.023, noise: 0.004 },
  { s: S3, u: 'TimedStorage-ByteHrs', base: 30, team: 'checkout', g: 0.015, price: 0.023, noise: 0.004 },
  { s: S3, u: 'Requests-Tier1', base: 9, a: DATA, team: 'data', wk: 0.2, price: 0.000005 },
  { s: S3, u: 'Requests-Tier2', base: 4, team: 'checkout', wk: 0.1, price: 0.0000004 },
  { s: S3, u: 'DataTransfer-Out-Bytes', base: 7, team: 'checkout', wk: 0.15, price: 0.09 },

  // ── CloudWatch ──
  { s: CW, u: 'DataProcessing-Bytes', base: 52, team: 'checkout', wk: 0.08, g: 0.02, price: 0.5, ev: [[9, 0, 3.15]] },
  { s: CW, u: 'DataProcessing-Bytes', base: 17, a: DATA, team: 'data', wk: 0.1, price: 0.5 },
  { s: CW, u: 'TimedStorage-ByteHrs', base: 34, team: '', g: 0.062, price: 0.03, noise: 0.003 },
  { s: CW, u: 'CW:MetricMonitorUsage', base: 41, team: 'platform', g: 0.02, price: 0.3, noise: 0.01 },
  { s: CW, u: 'CW:GMD-Metrics', base: 23, team: 'platform', g: 0.01, price: 0.00001 },
  { s: CW, u: 'CW:AlarmMonitorUsage', base: 6.5, team: 'platform', price: 0.1, noise: 0.005 },
  { s: CW, u: 'DashboardsUsageHour', base: 1.4, team: '', price: 3, noise: 0 },
  { s: CW, u: 'VendedLog-Bytes', base: 11, team: 'platform', wk: 0.1, price: 0.5 },

  // ── Everything else ──
  { s: 'AWS Lambda', u: 'Lambda-GB-Second', base: 26, team: 'checkout', wk: 0.2, g: 0.03, price: 0.0000166667 },
  { s: 'AWS Lambda', u: 'Request', base: 3, team: 'checkout', wk: 0.2, price: 0.0000002 },
  { s: 'Amazon DynamoDB', u: 'WriteCapacityUnit-Hrs', base: 22, team: 'checkout', price: 0.00065, noise: 0.01 },
  { s: 'Amazon DynamoDB', u: 'ReadCapacityUnit-Hrs', base: 14, team: 'checkout', price: 0.00013, noise: 0.01 },
  { s: 'Amazon DynamoDB', u: 'TimedStorage-ByteHrs', base: 5, team: 'checkout', g: 0.02, price: 0.25 },
  { s: 'Amazon ElastiCache', u: 'NodeUsage:cache.r5.xlarge', base: 44, team: 'search', price: 0.431, noise: 0.005 },
  { s: 'Amazon ElastiCache', u: 'HeavyUsage:cache.m5.large', base: 9, team: 'checkout', rec: 'RIFee', price: 0.094, noise: 0, purchase: 'Reserved Instances' },
  { s: 'Amazon Elastic Load Balancing', u: 'LoadBalancerUsage', base: 13, team: 'platform', price: 0.0225, noise: 0 },
  { s: 'Amazon Elastic Load Balancing', u: 'LCUUsage', base: 9, team: 'platform', wk: 0.15, price: 0.008 },
  { s: 'Amazon OpenSearch Service', u: 'ESInstance:r5.large.search', base: 32, team: 'search', price: 0.186, noise: 0.005 },
  { s: 'Amazon OpenSearch Service', u: 'ES:gp2-Storage', base: 5, team: 'search', price: 0.135 },
  { s: 'Amazon Elastic Container Service', u: 'Fargate-vCPU-Hours:perCPU', base: 58, team: 'platform', wk: 0.1, g: 0.025, price: 0.04048 },
  { s: 'Amazon Elastic Container Service', u: 'Fargate-GB-Hours', base: 14, team: 'platform', wk: 0.1, g: 0.025, price: 0.004445 },
  { s: 'Amazon Elastic Container Service for Kubernetes', u: 'AmazonEKS-Hours:perCluster', base: 7.2, team: 'platform', price: 0.1, noise: 0 },
  { s: 'Amazon Elastic Container Service for Kubernetes', u: 'AmazonEKS-Hours:extendedSupport', base: 12, a: STG, team: 'platform', env: 'staging', startAgo: 33, ramp: 0, price: 0.5, noise: 0 },
  { s: 'AWS CloudTrail', u: 'PaidEventsRecorded', base: 8.5, team: '', price: 0.00002 },
  { s: 'AWS Config', u: 'ConfigurationItemRecorded', base: 17, team: '', wk: 0.25, price: 0.003 },
  { s: 'AWS Key Management Service', u: 'KMS-Keys', base: 3.1, team: 'platform', price: 1, noise: 0 },
  { s: 'AWS Secrets Manager', u: 'AWSSecretsManager-Secrets', base: 2.4, team: 'platform', price: 0.4, noise: 0 },
  { s: 'Amazon Route 53', u: 'DNS-Queries', base: 1.8, team: 'platform', r: 'global', price: 0.0000004 },
  { s: 'Amazon CloudFront', u: 'US-DataTransfer-Out-Bytes', base: 21, team: 'checkout', r: 'global', wk: 0.2, g: 0.02, price: 0.085 },
  { s: 'Amazon Bedrock', u: 'USE1-Claude-InputTokenCount', base: 41, a: DATA, team: 'ml', startAgo: 21, ramp: 18, wk: 0.25, price: 0.000003 },
  { s: 'Amazon Bedrock', u: 'USE1-Claude-OutputTokenCount', base: 27, a: DATA, team: 'ml', startAgo: 21, ramp: 18, wk: 0.25, price: 0.000015 },
  { s: 'Amazon Simple Queue Service', u: 'Requests-Tier1', base: 2, team: 'checkout', price: 0.0000004 },
  { s: 'Amazon EC2 Container Registry (ECR)', u: 'TimedStorage-ByteHrs', base: 3.2, team: 'platform', g: 0.03, price: 0.1 },
  { s: 'Amazon GuardDuty', u: 'PaidEventsAnalyzed', base: 9, team: '', price: 0.000004 },
  { s: 'AWS Support (Business)', u: 'Dollar', base: 4650, a: PAYER, team: '', r: 'global', rec: 'Support', monthly: true, g: 0.012, price: 1 },
  { s: 'AWS Lambda', u: 'Lambda-GB-Second', base: -1500, a: PAYER, team: '', r: 'global', rec: 'Credit', monthly: true, price: 1 },
];

export interface DemoCube {
  start: string; // first day
  days: number;
  today: string;
  items: Item[];
}

let cached: DemoCube | null = null;

export function buildCube(today = todayIso()): DemoCube {
  if (cached && cached.today === today) return cached;
  const start = addMonths(monthStart(today), -12);
  const days = diffDays(today, start); // data through yesterday
  const rand = rng(20261118);
  const items: Item[] = SPECS.map((sp) => {
    const daily = new Float64Array(days);
    const noise = sp.noise ?? 0.035;
    for (let i = 0; i < days; i++) {
      const ago = days - i; // 1 = yesterday
      const date = addDays(start, i);
      if (sp.monthly) {
        if (date.endsWith('-01')) {
          // credits only landed in the last two months
          if (sp.rec === 'Credit' && ago > 62) continue;
          daily[i] = sp.base * Math.pow(1 + (sp.g ?? 0), -ago / 30.4);
        }
        continue;
      }
      if (sp.startAgo !== undefined && ago > sp.startAgo) continue;
      let v = sp.base * Math.pow(1 + (sp.g ?? 0), -ago / 30.4);
      if (sp.startAgo !== undefined && sp.ramp) v *= Math.min(1, 0.12 + (0.88 * (sp.startAgo - ago + 1)) / sp.ramp);
      const dow = new Date(date + 'T00:00:00Z').getUTCDay();
      if (sp.wk && (dow === 0 || dow === 6)) v *= 1 - sp.wk;
      for (const [from, to, mult] of sp.ev ?? []) if (ago <= from && ago >= to) v *= mult;
      v *= 1 + (rand() - 0.5) * 2 * noise;
      daily[i] = v;
    }
    return {
      service: sp.s,
      usageType: sp.u,
      region: sp.r ?? 'us-east-1',
      account: sp.a ?? PROD,
      team: sp.team ?? '',
      env: sp.env ?? (sp.team ? 'prod' : ''),
      recordType: sp.rec ?? 'Usage',
      purchase: sp.purchase ?? 'On Demand Instances',
      unitPrice: sp.price ?? 1,
      daily,
    };
  });
  cached = { start, days, today, items };
  return cached;
}

function dimValue(it: Item, d: Dim): string {
  switch (d) {
    case 'SERVICE':
      return it.service;
    case 'USAGE_TYPE':
      return it.usageType;
    case 'REGION':
      return it.region;
    case 'LINKED_ACCOUNT':
      return it.account;
    case 'RECORD_TYPE':
      return it.recordType;
    case 'PURCHASE_TYPE':
      return it.purchase;
    case 'OPERATION':
      return it.usageType.includes('BoxUsage') ? 'RunInstances' : it.usageType.split(/[:.-]/)[0];
    case 'INSTANCE_TYPE': {
      const m = it.usageType.match(/:((?:db\.|cache\.)?[a-z]\d[a-z]*\.\w+(?:\.search)?)$/);
      return m ? m[1] : 'NoInstanceType';
    }
    case 'RESOURCE_ID':
      return demoResourceId(it);
    default:
      if (d === 'TAG:team') return it.team;
      if (d === 'TAG:env') return it.env;
      return '';
  }
}

/** a plausible resource id for a demo line item (one resource per item keeps the cube small) */
function demoResourceId(it: Item): string {
  const h = (it.service + it.usageType + it.account + it.team).split('').reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7).toString(16).padStart(8, '0');
  const arn = (svc: string, res: string) => `arn:aws:${svc}:${it.region}:${it.account}:${res}`;
  const u = it.usageType;
  if (/BoxUsage|SpotUsage/.test(u)) return `i-0${h}${h.slice(0, 8)}`;
  if (/EBS:Volume/.test(u)) return `vol-0${h}${h.slice(0, 8)}`;
  if (/NatGateway/.test(u)) return `nat-0${h}${h.slice(0, 8)}`;
  if (/CloudWatch/.test(it.service) && /DataProcessing|TimedStorage/.test(u)) return arn('logs', `log-group:/ecs/${it.team || 'shared'}-api`);
  if (/Relational/.test(it.service)) return arn('rds', `db:${it.team || 'shared'}-primary`);
  if (/Simple Storage/.test(it.service)) return `acme-${it.team || 'shared'}-${it.account.slice(-4)}`;
  if (/Lambda/.test(it.service)) return arn('lambda', `function:${it.team || 'shared'}-handler`);
  if (/DynamoDB/.test(it.service)) return arn('dynamodb', `table/${it.team || 'shared'}-orders`);
  if (/ElastiCache/.test(it.service)) return arn('elasticache', `cluster:${it.team || 'shared'}-cache`);
  if (it.recordType !== 'Usage') return '';
  return arn(it.service.replace(/^(Amazon|AWS)\s+/, '').replace(/\W+/g, '').toLowerCase(), `${h}`);
}

export function demoQuery(cube: DemoCube, q: CostQuery): CostResult {
  const touchesRecord = q.groupBy.includes('RECORD_TYPE') || !!q.filters?.RECORD_TYPE;
  const filters = Object.entries(q.filters ?? {}) as [Dim, string[]][];
  const acc = new Map<string, CostRow>();
  const i0 = Math.max(0, diffDays(q.start, cube.start));
  const i1 = Math.min(cube.days, diffDays(q.end, cube.start));
  for (const it of cube.items) {
    if (!touchesRecord && (it.recordType === 'Credit' || it.recordType === 'Refund')) continue;
    if (filters.some(([d, vals]) => vals.length && !vals.includes(dimValue(it, d)))) continue;
    const keys = q.groupBy.map((d) => dimValue(it, d));
    for (let i = i0; i < i1; i++) {
      const c = it.daily[i];
      if (!c) continue;
      const day = addDays(cube.start, i);
      const date = q.granularity === 'MONTHLY' ? monthStart(day) : day;
      const k = keys.join('\u0001') + '\u0001' + date;
      let row = acc.get(k);
      if (!row) acc.set(k, (row = { keys, date, cost: 0, usage: 0 }));
      row.cost += c;
      row.usage! += c / it.unitPrice;
    }
  }
  return { rows: [...acc.values()] };
}

export function demoSource(today = todayIso()): DataSource {
  const cube = buildCube(today);
  return { query: async (q) => demoQuery(cube, q) };
}

// ───────────────────────────── Snapshot ─────────────────────────────

export function demoSnapshot(today = todayIso()): Snapshot {
  const cube = buildCube(today);
  const q = (start: string, granularity: 'DAILY' | 'MONTHLY', groupBy: Dim[], filters?: CostQuery['filters']) =>
    demoQuery(cube, { start, end: today, granularity, groupBy, filters }).rows;
  const d90 = addDays(today, -90);
  const d30 = addDays(today, -30);
  const rand = rng(77);

  const mtd = sum(q(monthStart(today), 'DAILY', []).map((r) => r.cost));
  const last7 = sum(q(addDays(today, -7), 'DAILY', [], { RECORD_TYPE: ['Usage', 'SavingsPlanRecurringFee', 'RIFee'] }).map((r) => r.cost)) / 7;
  const remainingDays = diffDays(addMonths(monthStart(today), 1), today);
  const remaining = last7 * remainingDays * 1.02;

  // Commitments
  const sp1Util = 100;
  const sp2Util = 91;
  const hours = 720;
  const savingsPlans = [
    {
      id: 'arn:aws:savingsplans::999900001111:savingsplan/8f2c1a7e-compute-1yr',
      type: 'Compute',
      paymentOption: 'No Upfront',
      termYears: 1,
      hourlyCommitment: 9.8,
      start: addDays(today, 19 - 365),
      end: addDays(today, 19),
      utilizationPct: sp1Util,
      usedCommitment: 9.8 * hours,
      unusedCommitment: 0,
      netSavings: 2744,
    },
    {
      id: 'arn:aws:savingsplans::999900001111:savingsplan/1b77d0c3-ec2-m5-3yr',
      type: 'EC2Instance',
      region: 'us-east-1',
      instanceFamily: 'm5',
      paymentOption: 'Partial Upfront',
      termYears: 3,
      hourlyCommitment: 1.5,
      start: addDays(today, 74 - 1095),
      end: addDays(today, 74),
      utilizationPct: sp2Util,
      usedCommitment: 1.5 * hours * 0.91,
      unusedCommitment: 1.5 * hours * 0.09,
      netSavings: 615,
    },
  ];
  const reservations = [
    {
      id: 'ri-2f81c9d04a',
      service: RDS,
      instanceType: 'db.r5.xlarge',
      region: 'us-east-1',
      count: 2,
      platform: 'MySQL',
      offeringType: 'No Upfront',
      termYears: 1,
      start: addDays(today, 41 - 365),
      end: addDays(today, 41),
      utilizationPct: 100,
      unusedHours: 0,
      amortizedCost: 660,
      unusedCost: 0,
      netSavings: 380,
    },
    {
      id: 'ri-7c05aa19be',
      service: 'Amazon ElastiCache',
      instanceType: 'cache.m5.large',
      region: 'us-east-1',
      count: 4,
      platform: 'Redis',
      offeringType: 'No Upfront',
      termYears: 1,
      start: addDays(today, 212 - 365),
      end: addDays(today, 212),
      utilizationPct: 62,
      unusedHours: 1094,
      amortizedCost: 270,
      unusedCost: 103,
      netSavings: 38,
    },
  ];
  const coverage = [];
  for (let i = 90; i >= 1; i--) {
    const date = addDays(today, -i);
    const dow = new Date(date + 'T00:00:00Z').getUTCDay();
    const wk = dow === 0 || dow === 6 ? 0.9 : 1;
    const g5 = i <= 47 ? 87 : 0;
    coverage.push({
      date,
      covered: 428 + (rand() - 0.5) * 8,
      onDemand: (880 + g5) * wk * (1 - i * 0.0006) + (rand() - 0.5) * 30,
    });
  }

  const hub: HubRec[] = [];
  const mkId = (p: string, n: number) => `${p}-0${(0x9a3f1c00 + n * 7919).toString(16)}${(n * 104729).toString(16).slice(0, 5)}`;
  [138.2, 138.2, 134.6].forEach((s, i) =>
    hub.push({
      id: `hub-rs-${i}`,
      resourceId: mkId('i', i + 1),
      resourceType: 'Ec2Instance',
      actionType: 'Rightsize',
      currentSummary: 'm5.2xlarge',
      recommendedSummary: 'm5.xlarge',
      monthlySavings: s,
      savingsPct: 50,
      currentMonthlyCost: 276.5,
      effort: 'Medium',
      restartNeeded: true,
      rollbackPossible: true,
      region: 'us-east-1',
      account: PROD,
    }),
  );
  hub.push({
    id: 'hub-stop-0',
    resourceId: mkId('i', 9),
    resourceType: 'Ec2Instance',
    actionType: 'Stop',
    currentSummary: 'm4.xlarge · idle 14+ days (max CPU 1.8%)',
    recommendedSummary: 'Stop or terminate',
    monthlySavings: 144,
    savingsPct: 100,
    currentMonthlyCost: 144,
    effort: 'Low',
    restartNeeded: false,
    rollbackPossible: true,
    region: 'us-east-1',
    account: SBX,
  });
  hub.push({
    id: 'hub-stop-1',
    resourceId: mkId('i', 12),
    resourceType: 'Ec2Instance',
    actionType: 'Stop',
    currentSummary: 'm4.large · idle 14+ days (max CPU 0.9%)',
    recommendedSummary: 'Stop or terminate',
    monthlySavings: 72,
    savingsPct: 100,
    currentMonthlyCost: 72,
    effort: 'Low',
    restartNeeded: false,
    rollbackPossible: true,
    region: 'us-east-1',
    account: SBX,
  });
  const gp2Sizes = [2000, 1500, 1000, 1000, 800, 500, 500, 500, 400, 300, 250, 200, 200, 100];
  gp2Sizes.forEach((gb, i) =>
    hub.push({
      id: `hub-ebs-${i}`,
      resourceId: mkId('vol', i + 20),
      resourceType: 'EbsVolume',
      actionType: 'Upgrade',
      currentSummary: `gp2 · ${gb} GB`,
      recommendedSummary: `gp3 · ${gb} GB`,
      monthlySavings: gb * 0.02,
      savingsPct: 20,
      currentMonthlyCost: gb * 0.1,
      effort: 'Low',
      restartNeeded: false,
      rollbackPossible: true,
      region: i > 11 ? 'us-west-2' : 'us-east-1',
      account: i % 5 === 4 ? DATA : PROD,
    }),
  );
  hub.push(
    {
      id: 'hub-rds-0',
      resourceId: 'checkout-primary',
      resourceType: 'RdsDbInstance',
      actionType: 'MigrateToGraviton',
      currentSummary: 'db.r5.2xlarge · Multi-AZ',
      recommendedSummary: 'db.r7g.2xlarge · Multi-AZ',
      monthlySavings: 212,
      savingsPct: 7,
      currentMonthlyCost: 2880,
      effort: 'Low',
      restartNeeded: true,
      rollbackPossible: true,
      region: 'us-east-1',
      account: PROD,
    },
    {
      id: 'hub-ecs-0',
      resourceId: 'platform-api',
      resourceType: 'EcsService',
      actionType: 'Rightsize',
      currentSummary: '2 vCPU / 8 GB × 12 tasks',
      recommendedSummary: '1 vCPU / 4 GB × 12 tasks',
      monthlySavings: 96,
      savingsPct: 31,
      currentMonthlyCost: 310,
      effort: 'Low',
      restartNeeded: true,
      rollbackPossible: true,
      region: 'us-east-1',
      account: PROD,
    },
    {
      id: 'hub-lambda-0',
      resourceId: 'checkout-image-resizer',
      resourceType: 'LambdaFunction',
      actionType: 'Rightsize',
      currentSummary: '3008 MB',
      recommendedSummary: '1024 MB',
      monthlySavings: 31,
      savingsPct: 38,
      currentMonthlyCost: 82,
      effort: 'VeryLow',
      restartNeeded: false,
      rollbackPossible: true,
      region: 'us-east-1',
      account: PROD,
    },
    {
      id: 'hub-sp-0',
      resourceType: 'ComputeSavingsPlans',
      actionType: 'PurchaseSavingsPlans',
      recommendedSummary: '$14.50/hour Compute Savings Plan',
      monthlySavings: 3890,
      savingsPct: 27,
      effort: 'VeryLow',
      account: PAYER,
    },
  );

  const lg = (name: string, gb: number, retentionDays: number | null, region = 'us-east-1'): LogGroupInfo => ({
    account: /staging/.test(name) ? STG : /search/.test(name) ? DATA : PROD,
    name,
    region,
    storedBytes: gb * 1024 ** 3,
    retentionDays,
    logClass: 'STANDARD',
    createdAt: addDays(today, -700),
  });
  const logGroups: LogGroupInfo[] = [
    lg('/ecs/checkout-api', 11840, null),
    lg('/aws/lambda/checkout-order-events', 6210, null),
    lg('/aws/eks/prod-main/cluster', 4930, null),
    lg('/ecs/search-indexer', 3350, null),
    lg('/aws/rds/instance/checkout-primary/slowquery', 2120, null),
    lg('/aws/vpc/flow-logs/prod', 1890, null),
    lg('/aws/lambda/legacy-report-generator', 940, null),
    lg('/ecs/platform-api', 610, 90),
    lg('/aws/lambda/checkout-image-resizer', 320, 30),
    lg('/aws/apigateway/checkout', 240, 30),
    lg('/aws/eks/staging/cluster', 410, null, 'us-east-1'),
    lg('/ecs/search-api', 180, 14, 'us-west-2'),
    ...Array.from({ length: 34 }, (_, i) => lg(`/aws/lambda/svc-${String(i + 1).padStart(2, '0')}`, 2 + ((i * 37) % 40), i % 3 === 0 ? null : 30)),
  ];

  const dash = (name: string, viewedAgo: number | null, modifiedAgo: number) => ({
    account: /data|cost-poc/.test(name) ? DATA : PROD,
    name,
    region: 'us-east-1',
    lastModified: addDays(today, -modifiedAgo) + 'T10:00:00Z',
    lastViewed: viewedAgo === null ? null : addDays(today, -viewedAgo) + 'T15:20:00Z',
  });
  const dashboards = [
    dash('checkout-golden-signals', 1, 12),
    dash('platform-oncall', 2, 40),
    dash('search-latency', 6, 95),
    dash('rds-overview', 21, 210),
    dash('data-pipeline', 44, 300),
    dash('black-friday-2024', null, 720),
    dash('migration-cutover-q1', null, 610),
    dash('k8s-upgrade-1.27', null, 540),
    dash('load-test-march', null, 600),
    dash('legacy-monolith', null, 880),
    dash('jsmith-scratch', null, 430),
    dash('incident-2291', null, 505),
    dash('cost-poc', null, 380),
    dash('tmp-copy-of-platform-oncall', null, 290),
  ];

  const vol = (i: number, sizeGb: number, type: string, attached: boolean, ageDays: number, name?: string): VolumeInfo => ({
    account: i % 4 === 0 ? SBX : PROD,
    id: mkId('vol', i),
    region: 'us-east-1',
    sizeGb,
    type,
    attached,
    createdAt: addDays(today, -ageDays),
    name,
  });
  const volumes: VolumeInfo[] = [
    vol(1, 1000, 'gp2', false, 412, 'old-search-data'),
    vol(2, 500, 'gp2', false, 290, 'checkout-db-restore-test'),
    vol(3, 500, 'gp3', false, 188),
    vol(4, 200, 'gp2', false, 610, 'jenkins-home'),
    vol(5, 100, 'io1', false, 95, 'perf-test'),
    vol(6, 50, 'gp2', false, 730),
    ...gp2Sizes.map((gb, i) => vol(20 + i, gb, 'gp2', true, 300 + i * 20)),
    ...[800, 600, 400, 300, 200, 100].map((gb, i) => vol(60 + i, gb, 'gp3', true, 100 + i * 10)),
  ];

  return {
    meta: {
      mode: 'demo',
      generatedAt: new Date().toISOString(),
      today,
      dataThrough: addDays(today, -1),
      accountId: PAYER,
      accountLabel: 'Acme Corp (demo)',
      currency: 'USD',
      costBasis: 'UnblendedCost',
      ceRequests: 0,
      deepScan: true,
      regionsScanned: ['us-east-1', 'us-west-2', 'eu-west-1'],
      accountsScanned: ACCOUNTS.map((a) => a.id),
      warnings: [],
    },
    accounts: ACCOUNTS,
    monthlyByService: q(cube.start, 'MONTHLY', ['SERVICE']),
    dailyByServiceUsage: q(d90, 'DAILY', ['SERVICE', 'USAGE_TYPE']),
    dailyByAccount: q(d90, 'DAILY', ['LINKED_ACCOUNT']),
    dailyByRegion: q(d90, 'DAILY', ['REGION']),
    recentByServiceRegion: q(d30, 'MONTHLY', ['SERVICE', 'REGION']),
    monthlyByRecordType: q(addMonths(monthStart(today), -2), 'MONTHLY', ['RECORD_TYPE']),
    tagKeys: ['team', 'env'],
    primaryTag: { key: 'team', rows: q(d30, 'MONTHLY', ['TAG:team']).map((r) => ({ ...r, date: d30 })) },
    forecast: remainingDays > 0 ? { remaining, remainingLow: remaining * 0.93, remainingHigh: remaining * 1.08 } : null,
    budgets: [
      { name: 'Total AWS — monthly', limit: 72000, actual: mtd, forecast: mtd + remaining, timeUnit: 'MONTHLY', type: 'COST' },
      { name: 'Data platform', limit: 12000, actual: mtd * 0.19, forecast: (mtd + remaining) * 0.19, timeUnit: 'MONTHLY', type: 'COST' },
    ],
    awsAnomalies: [],
    commitments: {
      savingsPlans,
      reservations,
      coverage,
      coverageByService: [
        { service: EC2, coveragePct: 37, onDemandCost: 21480, kind: 'SP' },
        { service: 'Amazon Elastic Container Service', coveragePct: 24, onDemandCost: 2160, kind: 'SP' },
        { service: 'AWS Lambda', coveragePct: 0, onDemandCost: 870, kind: 'SP' },
        { service: RDS, coveragePct: 24, onDemandCost: 3126, kind: 'RI' },
        { service: 'Amazon ElastiCache', coveragePct: 17, onDemandCost: 1320, kind: 'RI' },
        { service: 'Amazon OpenSearch Service', coveragePct: 0, onDemandCost: 960, kind: 'RI' },
      ],
      totals: {
        spCommitment: (9.8 + 1.5) * hours,
        spUsed: 9.8 * hours + 1.5 * hours * 0.91,
        riAmortized: 930,
        riUnused: 103,
        netSavings: 2744 + 615 + 380 + 38,
        onDemandEquivalentCovered: 12840,
        onDemandEligible: 29916,
      },
      spRecommendations: [
        { type: 'Compute', termYears: 1, paymentOption: 'No Upfront', lookbackDays: 30, hourlyCommitment: 14.5, upfrontCost: 0, estimatedMonthlySavings: 3890, estimatedSavingsPct: 27, currentMonthlyOnDemand: 24510, estimatedUtilizationPct: 99.2 },
        { type: 'Compute', termYears: 1, paymentOption: 'All Upfront', lookbackDays: 30, hourlyCommitment: 13.9, upfrontCost: 121764, estimatedMonthlySavings: 4410, estimatedSavingsPct: 30, currentMonthlyOnDemand: 24510, estimatedUtilizationPct: 99.2 },
        { type: 'Compute', termYears: 3, paymentOption: 'No Upfront', lookbackDays: 30, hourlyCommitment: 12.1, upfrontCost: 0, estimatedMonthlySavings: 6950, estimatedSavingsPct: 46, currentMonthlyOnDemand: 24510, estimatedUtilizationPct: 98.7 },
      ],
      riRecommendations: [
        { service: RDS, instanceType: 'db.r5.2xlarge', region: 'us-east-1', platform: 'MySQL · Multi-AZ', count: 1, termYears: 1, paymentOption: 'No Upfront', lookbackDays: 30, upfrontCost: 0, recurringMonthlyCost: 1930, estimatedMonthlySavings: 950, estimatedSavingsPct: 33, breakEvenMonths: 0 },
        { service: 'Amazon ElastiCache', instanceType: 'cache.r5.xlarge', region: 'us-east-1', platform: 'Redis', count: 3, termYears: 1, paymentOption: 'No Upfront', lookbackDays: 30, upfrontCost: 0, recurringMonthlyCost: 905, estimatedMonthlySavings: 415, estimatedSavingsPct: 31, breakEvenMonths: 0 },
        { service: 'Amazon OpenSearch Service', instanceType: 'r5.large.search', region: 'us-east-1', count: 7, termYears: 1, paymentOption: 'No Upfront', lookbackDays: 30, upfrontCost: 0, recurringMonthlyCost: 662, estimatedMonthlySavings: 298, estimatedSavingsPct: 31, breakEvenMonths: 0 },
      ],
    },
    rightsizing: [],
    hubRecommendations: hub,
    resources: {
      logGroups,
      dashboards,
      alarms: { total: 1950, insufficientData: 214, noActions: 96 },
      volumes,
      oldSnapshots: { count: 1284, totalGb: 96400 },
      addresses: [
        ...Array.from({ length: 24 }, (_, i) => ({ ip: `52.${20 + i}.${(i * 53) % 255}.${(i * 91 + 7) % 255}`, region: i > 19 ? 'us-west-2' : 'us-east-1', allocationId: mkId('eipalloc', i), associated: false, account: i % 3 === 0 ? STG : PROD })),
        ...Array.from({ length: 30 }, (_, i) => ({ ip: `34.${200 + (i % 50)}.${(i * 17) % 255}.${(i * 29 + 3) % 255}`, region: 'us-east-1', allocationId: mkId('eipalloc', 100 + i), associated: true })),
      ],
      loadBalancers: [
        { name: 'checkout-public', arn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/checkout-public/1', region: 'us-east-1', type: 'application', targets: 18 },
        { name: 'search-internal', arn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/search-internal/2', region: 'us-east-1', type: 'application', targets: 9 },
        { name: 'legacy-admin', arn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/legacy-admin/3', region: 'us-east-1', type: 'application', targets: 0, createdAt: addDays(today, -820) },
        { name: 'blue-green-old', arn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/app/blue-green-old/4', region: 'us-east-1', type: 'application', targets: 0, createdAt: addDays(today, -260) },
        { name: 'loadtest-nlb', arn: 'arn:aws:elasticloadbalancing:us-east-1:111122223333:loadbalancer/net/loadtest-nlb/5', region: 'us-east-1', type: 'network', targets: 0, createdAt: addDays(today, -600) },
        { name: 'staging-preview-17', arn: 'arn:aws:elasticloadbalancing:us-east-1:222233334444:loadbalancer/app/staging-preview-17/6', region: 'us-east-1', type: 'application', targets: 0, createdAt: addDays(today, -140) },
      ],
      stoppedInstances: [
        { id: mkId('i', 31), region: 'us-east-1', type: 'm5.2xlarge', name: 'checkout-batch-old', stoppedSince: addDays(today, -210), ebsGb: 800 },
        { id: mkId('i', 32), region: 'us-east-1', type: 'c5.xlarge', name: 'loadtest-driver', stoppedSince: addDays(today, -600), ebsGb: 300 },
        { id: mkId('i', 33), region: 'us-east-1', type: 't3.large', name: 'bastion-legacy', stoppedSince: addDays(today, -95), ebsGb: 100 },
      ],
    },
  };
}

/**
 * A believable scan history for the demo account: eight weekly scans in which a handful of
 * opportunities were open and have since been fixed, so the progress view has something to show.
 */
export function demoHistory(today: string, current: Report): HistoryEntry[] {
  const fixed: [string, string, number, InsightCategory, number][] = [
    // id, title, savings, category, fixed N weeks ago
    ['demo-old-gp2', 'Move 31 EBS volumes from gp2 to gp3', 412, 'modernize', 6],
    ['demo-idle-rds', '2 idle RDS instances to stop', 690, 'idle', 5],
    ['demo-s3-versions', 'Old object versions never expire in 4 buckets', 530, 'storage', 3],
    ['demo-nat-endpoints', 'Add S3 gateway endpoints to 3 VPCs', 340, 'network', 2],
    ['demo-dev-nightly', 'Dev environments run nights and weekends', 1180, 'idle', 1],
  ];
  const openNow = Object.fromEntries(current.insights.map((i) => [i.id, { title: i.title, savings: i.monthlySavings, category: i.category }]));
  const out: HistoryEntry[] = [];
  for (let w = 8; w >= 1; w--) {
    const day = addDays(today, -7 * w);
    const insights = { ...openNow };
    // opportunities that only showed up recently were not open back then
    if (w > 2) for (const id of Object.keys(insights)) if (/cw-log-ingest|ext-support-Amazon Elastic Container/.test(id)) delete insights[id];
    for (const [id, title, savings, category, fixedAgo] of fixed) if (w > fixedAgo) insights[id] = { title, savings, category };
    out.push({
      at: day + 'T08:00:00.000Z',
      today: day,
      last30: current.briefing.last30 * (1 - w * 0.011) + (w > 3 ? 900 : 0),
      mtd: 0,
      projected: 0,
      insights,
      anomalies: w === 3 ? { 'demo-nat': { title: 'NAT Gateway data processing is spiking', ongoing: true, impact: 410, start: addDays(day, -3) } } : {},
      expirations: {},
      esrPct: current.commitments.esrPct,
      coveragePct: current.commitments.coveragePct,
    });
  }
  return out;
}
