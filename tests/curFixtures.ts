// Shared fixtures for the Cost and Usage Report tests: API responses, report files and an in-memory S3.
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { vi } from 'vitest';
import { BCMDataExportsClient, type Export } from '@aws-sdk/client-bcm-data-exports';
import { CostAndUsageReportServiceClient, type ReportDefinition } from '@aws-sdk/client-cost-and-usage-report-service';
import { S3Client } from '@aws-sdk/client-s3';
import { parquetWriteBuffer } from 'hyparquet-writer';

export type Cmd = { constructor: { name: string }; input: Record<string, any> };

export const denied = (action: string) =>
  Object.assign(new Error(`User: arn:aws:iam::1:user/x is not authorized to perform: ${action}`), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 403 } });

export const CUR2_ARN = 'arn:aws:bcm-data-exports:us-east-1:123456789012:export/cloudpennies-0a1b2c';

const CUR2_COLUMNS =
  'bill_billing_period_start_date, line_item_usage_start_date, line_item_usage_account_id, line_item_product_code, line_item_usage_type, line_item_operation, line_item_resource_id, line_item_line_item_type, line_item_unblended_cost, line_item_usage_amount, product, product_region_code';

/** A healthy CUR 2.0 Data Export as GetExport returns it. */
export function cur2Export(over: { name?: string; arn?: string; prefix?: string; bucket?: string; region?: string; format?: 'PARQUET' | 'TEXT_OR_CSV'; compression?: 'PARQUET' | 'GZIP'; table?: string; config?: Record<string, string>; query?: string } = {}): Export {
  const table = over.table ?? 'COST_AND_USAGE_REPORT';
  return {
    ExportArn: over.arn ?? CUR2_ARN,
    Name: over.name ?? 'cloudpennies',
    DataQuery: {
      QueryStatement: over.query ?? `SELECT ${CUR2_COLUMNS} FROM ${table}`,
      TableConfigurations: { [table]: over.config ?? { TIME_GRANULARITY: 'HOURLY', INCLUDE_RESOURCES: 'TRUE', INCLUDE_SPLIT_COST_ALLOCATION_DATA: 'FALSE' } },
    },
    DestinationConfigurations: {
      S3Destination: {
        S3Bucket: over.bucket ?? 'acme-billing',
        S3Prefix: over.prefix ?? 'exports',
        S3Region: over.region ?? 'eu-west-1',
        S3OutputConfigurations: { OutputType: 'CUSTOM', Format: over.format ?? 'PARQUET', Compression: over.compression ?? 'PARQUET', Overwrite: 'OVERWRITE_REPORT' },
      },
    },
    RefreshCadence: { Frequency: 'SYNCHRONOUS' },
  };
}

export function legacyReport(over: Partial<ReportDefinition> = {}): ReportDefinition {
  return {
    ReportName: 'legacy-cur',
    TimeUnit: 'DAILY',
    Format: 'textORcsv',
    Compression: 'GZIP',
    AdditionalSchemaElements: ['RESOURCES'],
    S3Bucket: 'acme-billing',
    S3Prefix: '/old/reports/',
    S3Region: 'us-east-1',
    ...over,
  };
}

/** Stub both listing APIs. An Error in place of a list makes that API fail. */
export function stubListing(o: { dataExports?: Export[] | Error; legacy?: ReportDefinition[] | Error; getExport?: Error } = {}): { calls: Cmd[] } {
  const calls: Cmd[] = [];
  vi.spyOn(BCMDataExportsClient.prototype, 'send').mockImplementation((async (cmd: Cmd) => {
    calls.push(cmd);
    if (o.dataExports instanceof Error) throw o.dataExports;
    const list = o.dataExports ?? [];
    if (cmd.constructor.name === 'ListExportsCommand') return { Exports: list.map((e) => ({ ExportArn: e.ExportArn, ExportName: e.Name, ExportStatus: { StatusCode: 'HEALTHY' } })) };
    if (o.getExport) throw o.getExport;
    return { Export: list.find((e) => e.ExportArn === cmd.input.ExportArn) };
  }) as never);
  vi.spyOn(CostAndUsageReportServiceClient.prototype, 'send').mockImplementation((async (cmd: Cmd) => {
    calls.push(cmd);
    if (o.legacy instanceof Error) throw o.legacy;
    return { ReportDefinitions: o.legacy ?? [] };
  }) as never);
  return { calls };
}

export interface FakeS3 {
  objects: Map<string, Buffer>;
  calls: Cmd[];
  /** keys fetched with GetObject, in order */
  gets: string[];
  deny: { get?: boolean; list?: boolean };
  /** client region of every request */
  regions: string[];
}

/** An in-memory bucket behind S3Client.send (GetObject + ListObjectsV2). */
export function stubS3(objects: Record<string, Buffer | string> = {}): FakeS3 {
  const fake: FakeS3 = { objects: new Map(Object.entries(objects).map(([k, v]) => [k, Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8')])), calls: [], gets: [], deny: {}, regions: [] };
  const etag = (b: Buffer) => `"${createHash('md5').update(b).digest('hex')}"`;
  vi.spyOn(S3Client.prototype, 'send').mockImplementation((async function (this: S3Client, cmd: Cmd) {
    fake.calls.push(cmd);
    fake.regions.push(await this.config.region());
    if (cmd.constructor.name === 'GetObjectCommand') {
      if (fake.deny.get) throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      const b = fake.objects.get(cmd.input.Key);
      if (!b) {
        // S3 hides missing keys behind "access denied" from callers who may not list the bucket
        if (fake.deny.list) throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
        throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      }
      fake.gets.push(cmd.input.Key);
      return { Body: Readable.from([b]), ETag: etag(b), ContentLength: b.length };
    }
    if (cmd.constructor.name === 'ListObjectsV2Command') {
      if (fake.deny.list) throw Object.assign(new Error('Access Denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } });
      const keys = [...fake.objects.keys()].filter((k) => k.startsWith(cmd.input.Prefix ?? '')).sort();
      const max = cmd.input.MaxKeys ?? 1000;
      const from = cmd.input.ContinuationToken ? Number(cmd.input.ContinuationToken) : 0;
      const page = keys.slice(from, from + max);
      const more = from + max < keys.length;
      return {
        Contents: page.map((k) => ({ Key: k, Size: fake.objects.get(k)!.length, ETag: etag(fake.objects.get(k)!), LastModified: new Date('2026-11-17T06:00:00Z') })),
        IsTruncated: more,
        ...(more ? { NextContinuationToken: String(from + max) } : {}),
      };
    }
    throw new Error(`unexpected S3 command ${cmd.constructor.name}`);
  }) as never);
  return fake;
}

// ── report files ──

export interface Line {
  /** ISO datetime of the usage start */
  start: string;
  account?: string;
  product?: string;
  productName?: string;
  usageType?: string;
  operation?: string;
  region?: string;
  resource?: string;
  type?: string;
  unblended: number;
  usage?: number;
  spEffective?: number;
  description?: string;
}

/**
 * One month of lines: unblended total 3.45 (credit excluded), amortized total 4.65.
 * i-aaa has two hourly lines on the same day.
 */
export function sampleLines(month: string): Line[] {
  const at = (day: number, hour = 0) => `${month}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00Z`;
  const ec2 = { product: 'AmazonEC2', productName: 'Amazon Elastic Compute Cloud', region: 'us-east-1' };
  return [
    { start: at(3, 0), ...ec2, usageType: 'USE1-BoxUsage:t3.micro', operation: 'RunInstances', resource: 'i-aaa', unblended: 1, usage: 1 },
    { start: at(3, 1), ...ec2, usageType: 'USE1-BoxUsage:t3.micro', operation: 'RunInstances', resource: 'i-aaa', unblended: 1.5, usage: 1 },
    { start: at(4), ...ec2, usageType: 'USE1-EBS:VolumeUsage.gp3', operation: 'CreateVolume-Gp3', resource: 'vol-bbb', unblended: 0.4, usage: 8 },
    { start: at(4), product: 'AmazonS3', productName: 'Amazon Simple Storage Service', region: 'us-east-1', usageType: 'USE1-TimedStorage-ByteHrs', operation: 'StandardStorage', resource: 'my-bucket', unblended: 0.25, usage: 11, description: 'Storage, "standard" tier,\nfirst 50 TB' },
    { start: at(5), ...ec2, usageType: 'USE1-BoxUsage:t3.micro', operation: 'RunInstances', resource: '', type: 'Credit', unblended: -5 },
    { start: at(1), ...ec2, region: '', usageType: '', operation: '', resource: '', type: 'Tax', unblended: 0.3 },
    { start: at(6), ...ec2, usageType: 'USE1-BoxUsage:m5.large', operation: 'RunInstances', resource: 'i-ccc', type: 'SavingsPlanCoveredUsage', unblended: 2, usage: 24, spEffective: 1.2 },
    { start: at(6), ...ec2, usageType: 'USE1-BoxUsage:m5.large', operation: 'RunInstances', resource: '', type: 'SavingsPlanNegation', unblended: -2 },
  ];
}

const ACCOUNT = '111111111111';

/** CUR 2.0 / legacy Parquet style: snake_case columns, timestamps, doubles. */
export function parquetFile(lines: Line[], opts: { codec?: 'SNAPPY' | 'GZIP' | 'ZSTD' | 'UNCOMPRESSED'; rowGroupSize?: number; compressors?: Record<string, (b: Uint8Array) => Uint8Array> } = {}): Buffer {
  const col = <T>(name: string, type: string, f: (l: Line) => T) => ({ name, type, data: lines.map(f) }) as never;
  const buf = parquetWriteBuffer({
    codec: opts.codec ?? 'SNAPPY',
    ...(opts.compressors ? { compressors: opts.compressors as never } : {}),
    ...(opts.rowGroupSize ? { rowGroupSize: opts.rowGroupSize } : {}),
    columnData: [
      col('bill_billing_period_start_date', 'TIMESTAMP', (l) => new Date(`${l.start.slice(0, 7)}-01T00:00:00Z`)),
      col('line_item_usage_start_date', 'TIMESTAMP', (l) => new Date(l.start)),
      col('line_item_usage_account_id', 'STRING', (l) => l.account ?? ACCOUNT),
      col('line_item_product_code', 'STRING', (l) => l.product ?? ''),
      col('product_product_name', 'STRING', (l) => l.productName ?? ''),
      col('line_item_usage_type', 'STRING', (l) => l.usageType ?? ''),
      col('line_item_operation', 'STRING', (l) => l.operation ?? ''),
      col('line_item_resource_id', 'STRING', (l) => (l.resource ? l.resource : null)),
      col('line_item_line_item_type', 'STRING', (l) => l.type ?? 'Usage'),
      col('line_item_unblended_cost', 'DOUBLE', (l) => l.unblended),
      col('line_item_usage_amount', 'DOUBLE', (l) => l.usage ?? 0),
      col('product_region_code', 'STRING', (l) => l.region ?? ''),
      col('savings_plan_savings_plan_effective_cost', 'DOUBLE', (l) => l.spEffective ?? null),
      col('line_item_line_item_description', 'STRING', (l) => l.description ?? ''),
    ],
  });
  return Buffer.from(buf);
}

const csvCell = (v: string | number): string => {
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Legacy CSV style: `category/ColumnName` headers, ISO date strings, numbers as text. */
export function legacyCsv(lines: Line[]): string {
  const header = [
    'identity/LineItemId',
    'bill/BillingPeriodStartDate',
    'lineItem/UsageAccountId',
    'lineItem/LineItemType',
    'lineItem/UsageStartDate',
    'lineItem/ProductCode',
    'lineItem/UsageType',
    'lineItem/Operation',
    'lineItem/ResourceId',
    'lineItem/UsageAmount',
    'lineItem/UnblendedCost',
    'lineItem/LineItemDescription',
    'product/ProductName',
    'product/region',
    'savingsPlan/SavingsPlanEffectiveCost',
  ];
  const rows = lines.map((l, i) =>
    [
      `id${i}`,
      `${l.start.slice(0, 7)}-01T00:00:00Z`,
      l.account ?? ACCOUNT,
      l.type ?? 'Usage',
      l.start,
      l.product ?? '',
      l.usageType ?? '',
      l.operation ?? '',
      l.resource ?? '',
      l.usage ?? 0,
      l.unblended,
      l.description ?? '',
      l.productName ?? '',
      l.region ?? '',
      l.spEffective ?? '',
    ]
      .map(csvCell)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}

export const legacyCsvGz = (lines: Line[]): Buffer => gzipSync(Buffer.from(legacyCsv(lines), 'utf8'));
