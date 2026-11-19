// Cost and Usage Report reader: files on disk, the local store, queries and end-to-end imports against an in-memory S3.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync, gzipSync, zstdCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parquetMetadata } from 'hyparquet';
import { encodeMonth, OTHER_RESOURCES, type AggRow } from '../electron/aws/cur/aggregate';
import type { LineItem } from '../electron/aws/cur/columns';
import { listCurExports } from '../electron/aws/cur/exports';
import { curStatus, importCur, NO_EXPORT_MESSAGE, statusOf, type CurImportOptions } from '../electron/aws/cur/importer';
import { readCsvFile, readParquetFile, type ReadStats } from '../electron/aws/cur/reader';
import { buildKnownServices, EC2_COMPUTE, EC2_OTHER } from '../electron/aws/cur/services';
import { CurStore, curStoreDir, currentCurStore, exportIdHash, fingerprintOf, storeSupports } from '../electron/aws/cur/store';
import type { CostQuery } from '../src/core/types';
import { cur2Export, CUR2_ARN, denied, legacyCsv, legacyCsvGz, legacyReport, parquetFile, sampleLines, stubListing, stubS3, type Line } from './curFixtures';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'cp-cur-'));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const collect = async (read: (onItem: (i: LineItem) => void) => Promise<ReadStats>) => {
  const items: LineItem[] = [];
  const stats = await read((i) => items.push(i));
  return { items, stats };
};
const total = (items: { cost: number }[]) => items.reduce((a, i) => a + i.cost, 0);

describe('Parquet reader', () => {
  it('reads a real Parquet file: columns resolved, timestamps to days, credits dropped', async () => {
    const file = path.join(dir, 'a.snappy.parquet');
    writeFileSync(file, parquetFile(sampleLines('2026-10')));
    const { items, stats } = await collect((on) => readParquetFile(file, 'UnblendedCost', on));
    expect(stats).toEqual({ rows: 8, kept: 7 });
    expect(total(items)).toBeCloseTo(3.45, 9);
    expect(items[0]).toEqual({
      day: '2026-10-03',
      account: '111111111111',
      productCode: 'AmazonEC2',
      productName: 'Amazon Elastic Compute Cloud',
      usageType: 'USE1-BoxUsage:t3.micro',
      operation: 'RunInstances',
      region: 'us-east-1',
      resourceId: 'i-aaa',
      lineItemType: 'Usage',
      cost: 1,
      usage: 1,
    });
    expect(items.find((i) => i.lineItemType === 'Tax')).toMatchObject({ day: '2026-10-01', resourceId: '', cost: 0.3 }); // null resource id -> ''
    expect(items.some((i) => i.lineItemType === 'Credit')).toBe(false);
  });

  it('applies the cost basis while reading', async () => {
    const file = path.join(dir, 'a.parquet');
    writeFileSync(file, parquetFile(sampleLines('2026-10')));
    const { items } = await collect((on) => readParquetFile(file, 'AmortizedCost', on));
    expect(total(items)).toBeCloseTo(4.65, 9);
    expect(items.find((i) => i.lineItemType === 'SavingsPlanCoveredUsage')!.cost).toBe(1.2);
    expect(items.find((i) => i.lineItemType === 'SavingsPlanNegation')!.cost).toBe(0);
  });

  it('reads every row group, and gzip- and zstd-compressed pages', async () => {
    const lines: Line[] = Array.from({ length: 250 }, (_, i) => ({ start: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`, product: 'AmazonS3', resource: `bucket-${i % 7}`, unblended: 0.01 * (i + 1) }));
    const expected = lines.reduce((a, l) => a + l.unblended, 0);
    const variants: [string, Buffer][] = [
      ['groups', parquetFile(lines, { rowGroupSize: 40 })],
      ['gzip', parquetFile(lines, { codec: 'GZIP', rowGroupSize: 100, compressors: { GZIP: (b) => gzipSync(b) } })],
      ['zstd', parquetFile(lines, { codec: 'ZSTD', compressors: { ZSTD: (b) => zstdCompressSync(b) } })],
      ['plain', parquetFile(lines, { codec: 'UNCOMPRESSED' })],
    ];
    // the fixtures really are compressed the way their name says
    const codecOf = (b: Buffer) => parquetMetadata(new Uint8Array(b)).row_groups[0].columns[0].meta_data!.codec;
    expect(variants.map(([, b]) => codecOf(b))).toEqual(['SNAPPY', 'GZIP', 'ZSTD', 'UNCOMPRESSED']);
    expect(parquetMetadata(new Uint8Array(variants[0][1])).row_groups.length).toBeGreaterThan(3);
    for (const [name, buf] of variants) {
      const file = path.join(dir, `${name}.parquet`);
      writeFileSync(file, buf);
      const { items, stats } = await collect((on) => readParquetFile(file, 'UnblendedCost', on));
      expect([name, stats.rows]).toEqual([name, 250]);
      expect(total(items)).toBeCloseTo(expected, 6);
      expect(new Set(items.map((i) => i.resourceId)).size).toBe(7);
    }
  });

  it('says which columns are missing', async () => {
    const { parquetWriteBuffer } = await import('hyparquet-writer');
    const file = path.join(dir, 'x.parquet');
    writeFileSync(file, Buffer.from(parquetWriteBuffer({ columnData: [{ name: 'line_item_resource_id', data: ['a'], type: 'STRING' }] })));
    await expect(readParquetFile(file, 'UnblendedCost', () => undefined, 'p/x.parquet')).rejects.toThrow(/line_item_usage_start_date, line_item_line_item_type, line_item_unblended_cost missing in p\/x\.parquet/);
  });
});

describe('CSV reader', () => {
  it('reads a gzip legacy CSV with quoted, multi-line fields', async () => {
    const file = path.join(dir, 'r-00001.csv.gz');
    writeFileSync(file, legacyCsvGz(sampleLines('2026-10')));
    const { items, stats } = await collect((on) => readCsvFile(file, 'UnblendedCost', on));
    expect(stats).toEqual({ rows: 8, kept: 7 }); // the embedded newline did not split a row
    expect(total(items)).toBeCloseTo(3.45, 9);
    expect(items.find((i) => i.resourceId === 'my-bucket')).toEqual({
      day: '2026-10-04',
      account: '111111111111',
      productCode: 'AmazonS3',
      productName: 'Amazon Simple Storage Service',
      usageType: 'USE1-TimedStorage-ByteHrs',
      operation: 'StandardStorage',
      region: 'us-east-1',
      resourceId: 'my-bucket',
      lineItemType: 'Usage',
      cost: 0.25,
      usage: 11,
    });
    const amortized = await collect((on) => readCsvFile(file, 'AmortizedCost', on));
    expect(total(amortized.items)).toBeCloseTo(4.65, 9);
  });

  it('reads an uncompressed CSV and a large one in many chunks', async () => {
    const plain = path.join(dir, 'plain.csv');
    writeFileSync(plain, legacyCsv(sampleLines('2026-10')));
    expect((await collect((on) => readCsvFile(plain, 'UnblendedCost', on))).stats.kept).toBe(7);

    const lines: Line[] = Array.from({ length: 20000 }, (_, i) => ({ start: '2026-10-09T00:00:00Z', product: 'AmazonS3', resource: `b-${i}`, unblended: 0.5, description: 'x'.repeat(40) + ', "q"' }));
    const big = path.join(dir, 'big.csv.gz');
    writeFileSync(big, legacyCsvGz(lines));
    const { items, stats } = await collect((on) => readCsvFile(big, 'UnblendedCost', on));
    expect(stats.rows).toBe(20000);
    expect(total(items)).toBe(10000);
    expect(items.at(-1)!.resourceId).toBe('b-19999');
  });

  it('rejects a file without the needed columns', async () => {
    const file = path.join(dir, 'bad.csv.gz');
    writeFileSync(file, gzipSync('a,b\n1,2\n'));
    await expect(readCsvFile(file, 'UnblendedCost', () => undefined, 'k/bad.csv.gz')).rejects.toThrow(/missing in k\/bad\.csv\.gz/);
  });
});

// ── store + queries ──

const KNOWN = buildKnownServices([
  { keys: [EC2_COMPUTE, 'BoxUsage'], date: '2026-11-01', cost: 1 },
  { keys: [EC2_OTHER, 'EBS:VolumeUsage'], date: '2026-11-01', cost: 1 },
  { keys: ['Amazon Simple Storage Service', 'TimedStorage'], date: '2026-11-01', cost: 1 },
]);

const r = (day: string, resource: string, cost: number, o: Partial<AggRow> = {}): AggRow => ({ day, account: '111', product: 'AmazonEC2', usageType: 'BoxUsage', operation: 'RunInstances', region: 'us-east-1', resource, cost, usage: 1, ...o });

/** Sep, Oct (complete) and Nov (through the 16th) */
async function seededStore(): Promise<CurStore> {
  const store = new CurStore(path.join(dir, 'store'));
  const meta = (complete: boolean) => ({ exportId: 'x', exportName: 'x', fingerprint: 'f', complete, now: new Date('2026-11-17T08:00:00Z') });
  await store.writeMonth(encodeMonth('2026-09', 'UnblendedCost', [r('2026-09-10', 'i-1', 10), r('2026-09-30', 'i-2', 20, { account: '222', region: 'eu-west-1' })]), meta(true));
  await store.writeMonth(
    encodeMonth(
      '2026-10',
      'UnblendedCost',
      [
        r('2026-10-01', 'i-1', 1),
        r('2026-10-02', 'i-1', 2),
        r('2026-10-02', 'vol-1', 4, { usageType: 'EBS:VolumeUsage', operation: 'CreateVolume' }),
        r('2026-10-31', 'bucket', 8, { product: 'AmazonS3', usageType: 'TimedStorage', operation: 'StandardStorage' }),
        r('2026-10-31', '', 16, { product: 'AmazonS3', usageType: 'TimedStorage', operation: 'StandardStorage' }),
        r('2026-10-15', OTHER_RESOURCES, 32, { account: '222' }),
      ],
      { AmazonEC2: 'Amazon Elastic Compute Cloud', AmazonS3: 'Amazon Simple Storage Service' },
    ),
    meta(true),
  );
  await store.writeMonth(encodeMonth('2026-11', 'UnblendedCost', [r('2026-11-01', 'i-1', 100), r('2026-11-16', 'i-1', 200), r('2026-11-16', 'i-3', 400, { usage: 5 })]), meta(false));
  await store.saveServices(KNOWN);
  return store;
}

describe('CurStore', () => {
  it('writes months as gzip JSON next to an index, atomically', async () => {
    const store = await seededStore();
    const files = readdirSync(store.dir).sort();
    expect(files).toEqual(['2026-09.json.gz', '2026-10.json.gz', '2026-11.json.gz', 'index.json', 'services.json']);
    const month = JSON.parse(gunzipSync(readFileSync(path.join(store.dir, '2026-10.json.gz'))).toString('utf8'));
    expect(month.dict.resource).toEqual(['i-1', 'vol-1', OTHER_RESOURCES, 'bucket', '']);
    expect(month.cols.resource.every((n: unknown) => Number.isInteger(n))).toBe(true);
    const idx = JSON.parse(readFileSync(path.join(store.dir, 'index.json'), 'utf8'));
    expect(idx.months.map((m: { month: string }) => m.month)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(idx.months[1]).toMatchObject({ month: '2026-10', rows: 6, cost: 63, complete: true, fingerprint: 'f', basis: 'UnblendedCost', dataThrough: '2026-10-31', ingestedAt: '2026-11-17T08:00:00.000Z' });
    expect(idx.months[2]).toMatchObject({ complete: false, dataThrough: '2026-11-16' });
    expect(await store.months()).toEqual([
      { month: '2026-09', rows: 2, cost: 30, ingestedAt: '2026-11-17T08:00:00.000Z', complete: true },
      { month: '2026-10', rows: 6, cost: 63, ingestedAt: '2026-11-17T08:00:00.000Z', complete: true },
      { month: '2026-11', rows: 3, cost: 700, ingestedAt: '2026-11-17T08:00:00.000Z', complete: false },
    ]);
  });

  it('re-imports a month only when its fingerprint or the cost basis changed, or the file is gone', async () => {
    const store = await seededStore();
    expect(await store.needsImport('2026-10', 'f', 'UnblendedCost')).toBe(false);
    expect(await store.needsImport('2026-10', 'other', 'UnblendedCost')).toBe(true);
    expect(await store.needsImport('2026-10', 'f', 'AmortizedCost')).toBe(true);
    expect(await store.needsImport('2026-08', 'f', 'UnblendedCost')).toBe(true);
    rmSync(path.join(store.dir, '2026-10.json.gz'));
    expect(await store.needsImport('2026-10', 'f', 'UnblendedCost')).toBe(true);
    // a fresh object sees the same state: nothing lives only in memory
    expect(await new CurStore(store.dir).needsImport('2026-09', 'f', 'UnblendedCost')).toBe(false);
  });

  it('fingerprints the source files: manifest id, keys, ETags and sizes, in any order', () => {
    const a = { key: 'a', etag: '"1"', size: 10 };
    const b = { key: 'b', etag: '"2"', size: 20 };
    expect(fingerprintOf([a, b], 'm1')).toBe(fingerprintOf([b, a], 'm1'));
    expect(fingerprintOf([a, b], 'm1')).not.toBe(fingerprintOf([a, b], 'm2'));
    expect(fingerprintOf([a, b])).not.toBe(fingerprintOf([a, { ...b, etag: '"3"' }]));
    expect(fingerprintOf([a, b])).not.toBe(fingerprintOf([a, { ...b, size: 21 }]));
    expect(fingerprintOf([a, b])).not.toBe(fingerprintOf([a]));
  });

  it('drops months outside the retention window and updates completeness', async () => {
    const store = await seededStore();
    expect(await store.prune(['2026-10', '2026-11', '2026-12'])).toEqual(['2026-09']);
    expect(existsSync(path.join(store.dir, '2026-09.json.gz'))).toBe(false);
    expect((await store.months()).map((m) => m.month)).toEqual(['2026-10', '2026-11']);
    expect(await store.prune(['2026-10', '2026-11'])).toEqual([]);
    await store.setComplete(() => true);
    expect((await store.months()).every((m) => m.complete)).toBe(true);
  });

  it('survives a missing or corrupt index and month file', async () => {
    const store = new CurStore(path.join(dir, 'nothing'));
    expect(await store.readIndex()).toBeNull();
    expect(await store.months()).toEqual([]);
    expect(await store.query({ start: '2026-10-01', end: '2026-11-01', granularity: 'DAILY', groupBy: ['RESOURCE_ID'] })).toBeNull();
    const seeded = await seededStore();
    writeFileSync(path.join(seeded.dir, '2026-10.json.gz'), 'not gzip');
    const res = await new CurStore(seeded.dir).query({ start: '2026-09-01', end: '2026-11-01', granularity: 'MONTHLY', groupBy: [] });
    expect(res!.rows).toEqual([{ keys: [], date: '2026-09-01', cost: 30, usage: 2 }]);
  });
});

describe('CurStore.query', () => {
  const q = (o: Partial<CostQuery>): CostQuery => ({ start: '2026-10-01', end: '2026-11-01', granularity: 'DAILY', groupBy: ['RESOURCE_ID'], ...o });
  const flat = (rows: { keys: string[]; date: string; cost: number }[]) => rows.map((x) => [x.date, ...x.keys, x.cost]);

  it('groups by resource, daily', async () => {
    const store = await seededStore();
    const res = await store.query(q({}));
    expect(flat(res!.rows)).toEqual([
      ['2026-10-01', 'i-1', 1],
      ['2026-10-02', 'vol-1', 4],
      ['2026-10-02', 'i-1', 2],
      ['2026-10-15', OTHER_RESOURCES, 32],
      ['2026-10-31', '', 16],
      ['2026-10-31', 'bucket', 8],
    ]);
    expect(res!.rows[0].usage).toBe(1);
  });

  it('buckets by month across several months, with two group-by dimensions', async () => {
    const store = await seededStore();
    const res = await store.query(q({ start: '2026-09-01', end: '2026-12-01', granularity: 'MONTHLY', groupBy: ['RESOURCE_ID', 'LINKED_ACCOUNT'] }));
    expect(flat(res!.rows)).toEqual([
      ['2026-09-01', 'i-2', '222', 20],
      ['2026-09-01', 'i-1', '111', 10],
      ['2026-10-01', OTHER_RESOURCES, '222', 32],
      ['2026-10-01', '', '111', 16],
      ['2026-10-01', 'bucket', '111', 8],
      ['2026-10-01', 'vol-1', '111', 4],
      ['2026-10-01', 'i-1', '111', 3],
      ['2026-11-01', 'i-3', '111', 400],
      ['2026-11-01', 'i-1', '111', 300],
    ]);
    expect(res!.rows.find((x) => x.keys[0] === 'i-3')!.usage).toBe(5);
    // no group-by: one total per period
    expect(flat((await store.query(q({ granularity: 'MONTHLY', groupBy: [] })))!.rows)).toEqual([['2026-10-01', 63]]);
  });

  it('honours day boundaries inside a month (end exclusive)', async () => {
    const store = await seededStore();
    expect(flat((await store.query(q({ start: '2026-10-02', end: '2026-10-31', groupBy: [] })))!.rows)).toEqual([['2026-10-02', 6], ['2026-10-15', 32]]);
    expect(flat((await store.query(q({ start: '2026-10-31', end: '2026-11-02', groupBy: [] })))!.rows)).toEqual([['2026-10-31', 24], ['2026-11-01', 100]]);
    expect(flat((await store.query(q({ start: '2026-09-30', end: '2026-10-02', groupBy: [], granularity: 'MONTHLY' })))!.rows)).toEqual([['2026-09-01', 20], ['2026-10-01', 1]]);
  });

  it('filters on every stored dimension (AND across, OR within)', async () => {
    const store = await seededStore();
    const costs = async (filters: CostQuery['filters'], groupBy: CostQuery['groupBy'] = ['RESOURCE_ID']) => flat((await store.query(q({ granularity: 'MONTHLY', groupBy, filters })))!.rows);
    expect(await costs({ RESOURCE_ID: ['i-1'] })).toEqual([['2026-10-01', 'i-1', 3]]);
    expect(await costs({ RESOURCE_ID: ['i-1', 'vol-1'] })).toEqual([['2026-10-01', 'vol-1', 4], ['2026-10-01', 'i-1', 3]]);
    expect(await costs({ RESOURCE_ID: [''] })).toEqual([['2026-10-01', '', 16]]); // '' = no resource id
    expect(await costs({ LINKED_ACCOUNT: ['222'] })).toEqual([['2026-10-01', OTHER_RESOURCES, 32]]);
    expect(await costs({ USAGE_TYPE: ['EBS:VolumeUsage'] })).toEqual([['2026-10-01', 'vol-1', 4]]);
    expect(await costs({ OPERATION: ['StandardStorage'], RESOURCE_ID: ['bucket'] })).toEqual([['2026-10-01', 'bucket', 8]]);
    expect(await costs({ REGION: ['eu-west-1'] })).toEqual([]);
    expect(await costs({ USAGE_TYPE: [] })).toHaveLength(5); // an empty filter list is no filter
    // RESOURCE_ID only as a filter, grouped by something else
    expect(await costs({ RESOURCE_ID: ['i-1'] }, ['USAGE_TYPE', 'OPERATION'])).toEqual([['2026-10-01', 'BoxUsage', 'RunInstances', 3]]);
  });

  it('resolves SERVICE through the persisted usage-type map, for filters and groupings', async () => {
    const store = await seededStore();
    const res = await store.query(q({ granularity: 'MONTHLY', groupBy: ['SERVICE'] }));
    expect(flat(res!.rows)).toEqual([
      ['2026-10-01', EC2_COMPUTE, 35],
      ['2026-10-01', 'Amazon Simple Storage Service', 24],
      ['2026-10-01', EC2_OTHER, 4],
    ]);
    const ec2Other = await store.query(q({ granularity: 'MONTHLY', filters: { SERVICE: [EC2_OTHER] } }));
    expect(flat(ec2Other!.rows)).toEqual([['2026-10-01', 'vol-1', 4]]);
    const both = await store.query(q({ granularity: 'MONTHLY', groupBy: ['SERVICE', 'RESOURCE_ID'], filters: { SERVICE: [EC2_COMPUTE, EC2_OTHER], LINKED_ACCOUNT: ['111'] } }));
    expect(flat(both!.rows)).toEqual([['2026-10-01', EC2_OTHER, 'vol-1', 4], ['2026-10-01', EC2_COMPUTE, 'i-1', 3]]);
    // the map is read from disk by a fresh store too
    expect(flat((await new CurStore(store.dir).query(q({ granularity: 'MONTHLY', groupBy: ['SERVICE'], filters: { RESOURCE_ID: ['bucket'] } })))!.rows)).toEqual([['2026-10-01', 'Amazon Simple Storage Service', 8]]);
  });

  it('clamps a period that starts before the first imported month or ends after the last', async () => {
    const store = await seededStore();
    const early = await store.query(q({ start: '2026-01-01', end: '2026-10-01', granularity: 'MONTHLY', groupBy: [] }));
    expect(flat(early!.rows)).toEqual([['2026-09-01', 30]]);
    const late = await store.query(q({ start: '2026-11-10', end: '2027-03-01', granularity: 'MONTHLY', groupBy: [] }));
    expect(flat(late!.rows)).toEqual([['2026-11-01', 600]]);
  });

  it('returns null when it cannot answer', async () => {
    const store = await seededStore();
    // nothing of the period is covered
    expect(await store.query(q({ start: '2026-01-01', end: '2026-09-01' }))).toBeNull();
    expect(await store.query(q({ start: '2026-12-01', end: '2027-01-01' }))).toBeNull();
    expect(await store.query(q({ start: '2026-11-17', end: '2026-11-19' }))).toBeNull(); // after the last day of data
    expect(await store.query(q({ start: '2026-10-05', end: '2026-10-05' }))).toBeNull(); // empty period
    // dimensions the store does not have
    for (const dim of ['TAG:team', 'PURCHASE_TYPE', 'RECORD_TYPE', 'INSTANCE_TYPE'] as const) {
      expect(await store.query(q({ groupBy: ['RESOURCE_ID', dim] }))).toBeNull();
      expect(await store.query(q({ filters: { [dim]: ['x'] } }))).toBeNull();
      expect(storeSupports({ groupBy: [dim] })).toBe(false);
    }
    expect(storeSupports({ groupBy: ['RESOURCE_ID'], filters: { 'TAG:team': [] } })).toBe(true); // an empty filter does not count
    // months imported in another cost basis do not count
    expect(await store.query(q({}), 'AmortizedCost')).toBeNull();
    expect(await store.query(q({}), 'UnblendedCost')).not.toBeNull();
    // a covered period with no matching rows is an answer, not a null
    expect(await store.query(q({ filters: { RESOURCE_ID: ['nope'] } }))).toEqual({ rows: [] });
  });

  it('keeps at most three months decoded and notices a re-import', async () => {
    const store = await seededStore();
    const load = vi.spyOn(store, 'loadMonth');
    const all = q({ start: '2026-09-01', end: '2026-12-01', granularity: 'MONTHLY', groupBy: [] });
    await store.query(all);
    await store.query(all);
    expect(load).toHaveBeenCalledTimes(6);
    expect((store as unknown as { loaded: Map<string, unknown> }).loaded.size).toBe(3);
    await store.writeMonth(encodeMonth('2026-08', 'UnblendedCost', [r('2026-08-01', 'i-0', 1)]), { exportId: 'x', exportName: 'x', fingerprint: 'f', complete: true, now: new Date('2026-11-17T09:00:00Z') });
    await store.query({ ...all, start: '2026-08-01' });
    expect((store as unknown as { loaded: Map<string, unknown> }).loaded.size).toBe(3);
    // re-importing a month replaces what queries see
    await store.writeMonth(encodeMonth('2026-10', 'UnblendedCost', [r('2026-10-01', 'i-9', 5)]), { exportId: 'x', exportName: 'x', fingerprint: 'g', complete: true, now: new Date('2026-11-18T09:00:00Z') });
    expect(flat((await store.query(q({ granularity: 'MONTHLY' })))!.rows)).toEqual([['2026-10-01', 'i-9', 5]]);
  });
});

// ── discovery against stubbed APIs ──

const CREDS = { accessKeyId: 'AKIAFAKEFAKEFAKEFAKE', secretAccessKey: 'x'.repeat(40) };

describe('listCurExports', () => {
  it('lists both kinds, best first', async () => {
    const { calls } = stubListing({ dataExports: [cur2Export()], legacy: [legacyReport()] });
    const r = await listCurExports(CREDS);
    expect(r.error).toBeUndefined();
    expect(r.exports.map((e) => [e.id, e.kind, e.usable])).toEqual([[CUR2_ARN, 'cur2', true], ['legacy:legacy-cur', 'legacy', true]]);
    expect(calls.map((c) => c.constructor.name).sort()).toEqual(['DescribeReportDefinitionsCommand', 'GetExportCommand', 'ListExportsCommand']);
  });

  it('keeps the results of one API when the other is denied, and names the permission', async () => {
    stubListing({ dataExports: denied('bcm-data-exports:ListExports'), legacy: [legacyReport()] });
    const a = await listCurExports(CREDS);
    expect(a.exports.map((e) => e.id)).toEqual(['legacy:legacy-cur']);
    expect(a.error).toMatchObject({ missingPermission: 'bcm-data-exports:ListExports' });
    expect(a.error!.message).toMatch(/not allowed to list Data Exports/);

    vi.restoreAllMocks();
    stubListing({ dataExports: [cur2Export()], legacy: denied('cur:DescribeReportDefinitions') });
    const b = await listCurExports(CREDS);
    expect(b.exports.map((e) => e.id)).toEqual([CUR2_ARN]);
    expect(b.error).toMatchObject({ missingPermission: 'cur:DescribeReportDefinitions' });

    vi.restoreAllMocks();
    stubListing({ dataExports: [cur2Export()], legacy: [legacyReport()], getExport: denied('bcm-data-exports:GetExport') });
    const c = await listCurExports(CREDS);
    expect(c.exports.map((e) => e.id)).toEqual(['legacy:legacy-cur']);
    expect(c.error).toMatchObject({ missingPermission: 'bcm-data-exports:GetExport' });

    vi.restoreAllMocks();
    stubListing({ dataExports: denied('bcm-data-exports:ListExports'), legacy: Object.assign(new Error('boom'), { name: 'InternalErrorException' }) });
    const d = await listCurExports(CREDS);
    expect(d.exports).toEqual([]);
    expect(d.error!.missingPermission).toBe('bcm-data-exports:ListExports');
    expect(d.error!.message).toMatch(/Data Exports.*legacy Cost and Usage Reports/);
  });
});

// ── end-to-end imports ──

const ACCOUNT = '123456789012';
const NOW = '2026-11-18T10:00:00Z';

const run = (o: Partial<CurImportOptions> = {}, settings: Partial<CurImportOptions['settings']> = {}) =>
  importCur({
    credentials: CREDS,
    accountId: ACCOUNT,
    cacheDir: dir,
    settings: { costBasis: 'UnblendedCost', curExportId: '', curMonths: 3, ...settings },
    now: () => new Date(NOW),
    tmpRoot: dir,
    ...o,
  });

const cur2Key = (month: string, file: string) => `exports/cloudpennies/data/BILLING_PERIOD=${month}/${file}`;
const cur2Manifest = (month: string) => `exports/cloudpennies/metadata/BILLING_PERIOD=${month}/cloudpennies-Manifest.json`;

/** Oct (two files) and Nov (one file) delivered; Sep predates the export */
function cur2Bucket(): Record<string, Buffer | string> {
  const oct = sampleLines('2026-10');
  return {
    [cur2Manifest('2026-10')]: JSON.stringify({ executionId: 'exec-oct', dataFiles: [`s3://acme-billing/${cur2Key('2026-10', 'cloudpennies-00001.snappy.parquet')}`, `s3://acme-billing/${cur2Key('2026-10', 'cloudpennies-00002.snappy.parquet')}`] }),
    [cur2Key('2026-10', 'cloudpennies-00001.snappy.parquet')]: parquetFile(oct.slice(0, 4)),
    [cur2Key('2026-10', 'cloudpennies-00002.snappy.parquet')]: parquetFile(oct.slice(4)),
    [cur2Manifest('2026-11')]: JSON.stringify({ executionId: 'exec-nov-1', dataFiles: [`s3://acme-billing/${cur2Key('2026-11', 'cloudpennies-00001.snappy.parquet')}`] }),
    [cur2Key('2026-11', 'cloudpennies-00001.snappy.parquet')]: parquetFile(sampleLines('2026-11')),
  };
}

const tmpLeftovers = () => readdirSync(dir).filter((f) => f.startsWith('cloudpennies-cur-'));

describe('importCur: CUR 2.0 Parquet', () => {
  it('imports the delivered months, stores them and answers queries', async () => {
    stubListing({ dataExports: [cur2Export()], legacy: [legacyReport()] });
    const s3 = stubS3(cur2Bucket());
    const steps: string[] = [];
    const res = await run({ onStep: (s) => steps.push(s), known: buildKnownServices([{ keys: [EC2_COMPUTE, 'USE1-BoxUsage:t3.micro'], date: '2026-11-01', cost: 1 }]) });

    expect(res.problem).toBeUndefined();
    expect(res.selected).toMatchObject({ id: CUR2_ARN, kind: 'cur2' });
    expect(res.imported).toEqual(['2026-11', '2026-10']);
    expect(res.months.map((m) => [m.month, m.complete, m.rows])).toEqual([['2026-10', true, 6], ['2026-11', false, 6]]);
    expect(res.months[0].cost).toBeCloseTo(3.45, 9);
    expect(res.months[0].ingestedAt).toBe('2026-11-18T10:00:00.000Z');
    expect(steps).toEqual(['Looking for a Cost and Usage Report', 'Importing the Cost and Usage Report (November)', 'Importing the Cost and Usage Report (October)', 'Importing the Cost and Usage Report (September)']);

    // the bucket region of the export is used; every data file was fetched once; nothing is left in the temp dir
    expect(new Set(s3.regions)).toEqual(new Set(['eu-west-1']));
    expect(s3.gets.filter((k) => k.endsWith('.parquet')).sort()).toEqual([cur2Key('2026-10', 'cloudpennies-00001.snappy.parquet'), cur2Key('2026-10', 'cloudpennies-00002.snappy.parquet'), cur2Key('2026-11', 'cloudpennies-00001.snappy.parquet')]);
    expect(tmpLeftovers()).toEqual([]);

    // on disk: <cache>/cur/<account>/<hash>/<month>.json.gz + index + services + the pointer
    const storeDir = curStoreDir(dir, ACCOUNT, CUR2_ARN);
    expect(storeDir).toBe(path.join(dir, 'cur', ACCOUNT, exportIdHash(CUR2_ARN)));
    expect(readdirSync(storeDir).sort()).toEqual(['2026-10.json.gz', '2026-11.json.gz', 'index.json', 'services.json']);

    const cur = await currentCurStore(dir, ACCOUNT);
    expect(cur!.pointer).toMatchObject({ exportId: CUR2_ARN, exportName: 'cloudpennies' });
    const byResource = await cur!.store.query({ start: '2026-10-01', end: '2026-11-01', granularity: 'MONTHLY', groupBy: ['RESOURCE_ID'] }, 'UnblendedCost');
    expect(byResource!.rows.map((x) => [x.keys[0], Number(x.cost.toFixed(6))])).toEqual([['i-aaa', 2.5], ['i-ccc', 2], ['vol-bbb', 0.4], ['my-bucket', 0.25], ['', -1.7]]);
    const daily = await cur!.store.query({ start: '2026-10-01', end: '2026-11-01', granularity: 'DAILY', groupBy: ['SERVICE'], filters: { RESOURCE_ID: ['i-aaa'] } }, 'UnblendedCost');
    expect(daily!.rows).toEqual([{ keys: [EC2_COMPUTE], date: '2026-10-03', cost: 2.5, usage: 2 }]);
    const tax = await cur!.store.query({ start: '2026-10-01', end: '2026-11-01', granularity: 'MONTHLY', groupBy: ['SERVICE'], filters: { RESOURCE_ID: [''] } }, 'UnblendedCost');
    expect(tax!.rows.find((x) => x.keys[0] === 'Tax')!.cost).toBeCloseTo(0.3, 9);
  });

  it('is incremental: an unchanged month is not downloaded again, a re-delivered one is', async () => {
    stubListing({ dataExports: [cur2Export()] });
    const s3 = stubS3(cur2Bucket());
    await run();
    s3.gets.length = 0;

    const second = await run();
    expect(second.imported).toEqual([]);
    expect(second.problem).toBeUndefined();
    expect(s3.gets.filter((k) => k.endsWith('.parquet'))).toEqual([]);
    expect(second.months.map((m) => m.month)).toEqual(['2026-10', '2026-11']);

    // AWS refreshes the current month: same key, new content and a new manifest
    s3.objects.set(cur2Key('2026-11', 'cloudpennies-00001.snappy.parquet'), parquetFile([...sampleLines('2026-11'), { start: '2026-11-17T00:00:00Z', product: 'AmazonS3', resource: 'my-bucket', unblended: 10 }]));
    s3.objects.set(cur2Manifest('2026-11'), Buffer.from(JSON.stringify({ executionId: 'exec-nov-2', dataFiles: [`s3://acme-billing/${cur2Key('2026-11', 'cloudpennies-00001.snappy.parquet')}`] })));
    const third = await run();
    expect(third.imported).toEqual(['2026-11']);
    expect(third.months.find((m) => m.month === '2026-11')!.cost).toBeCloseTo(13.45, 9);
  });

  it('re-imports everything when the cost basis changes', async () => {
    stubListing({ dataExports: [cur2Export()] });
    stubS3(cur2Bucket());
    await run();
    const res = await run({}, { costBasis: 'AmortizedCost' });
    expect(res.imported).toEqual(['2026-11', '2026-10']);
    expect(res.months[0].cost).toBeCloseTo(4.65, 9);
    const cur = await currentCurStore(dir, ACCOUNT);
    expect(await cur!.store.query({ start: '2026-10-01', end: '2026-11-01', granularity: 'MONTHLY', groupBy: [] }, 'UnblendedCost')).toBeNull();
    expect((await cur!.store.query({ start: '2026-10-01', end: '2026-11-01', granularity: 'MONTHLY', groupBy: [] }, 'AmortizedCost'))!.rows[0].cost).toBeCloseTo(4.65, 9);
  });

  it('drops months that fall out of the retention setting', async () => {
    stubListing({ dataExports: [cur2Export()] });
    stubS3(cur2Bucket());
    expect((await run()).months.map((m) => m.month)).toEqual(['2026-10', '2026-11']);
    const res = await run({}, { curMonths: 1 });
    expect(res.months.map((m) => m.month)).toEqual(['2026-11']);
    expect(readdirSync(curStoreDir(dir, ACCOUNT, CUR2_ARN)).filter((f) => f.endsWith('.gz'))).toEqual(['2026-11.json.gz']);
  });

  it('falls back to listing when a manifest is missing, and finds versioned deliveries', async () => {
    stubListing({ dataExports: [cur2Export()] });
    const bucket = cur2Bucket();
    delete bucket[cur2Manifest('2026-10')]; // -> data files found by listing the data prefix
    // November is delivered per execution: manifest and data one level down
    delete bucket[cur2Manifest('2026-11')];
    delete bucket[cur2Key('2026-11', 'cloudpennies-00001.snappy.parquet')];
    bucket['exports/cloudpennies/metadata/BILLING_PERIOD=2026-11/exec-9/cloudpennies-Manifest.json'] = JSON.stringify({ dataFiles: [`s3://acme-billing/${cur2Key('2026-11', 'exec-9/cloudpennies-00001.snappy.parquet')}`] });
    bucket[cur2Key('2026-11', 'exec-9/cloudpennies-00001.snappy.parquet')] = parquetFile(sampleLines('2026-11'));
    stubS3(bucket);
    const res = await run();
    expect(res.problem).toBeUndefined();
    expect(res.months.map((m) => [m.month, Number(m.cost.toFixed(2))])).toEqual([['2026-10', 3.45], ['2026-11', 3.45]]);
  });

  it('honours the export chosen in Settings', async () => {
    stubListing({ dataExports: [cur2Export()], legacy: [legacyReport()] });
    stubS3({});
    const res = await run({}, { curExportId: 'legacy:legacy-cur' });
    expect(res.selected!.id).toBe('legacy:legacy-cur');
  });

  it('skips a month whose files are too large, with one combined problem', async () => {
    stubListing({ dataExports: [cur2Export()] });
    const s3 = stubS3(cur2Bucket());
    const octBytes = s3.objects.get(cur2Key('2026-10', 'cloudpennies-00001.snappy.parquet'))!.length + s3.objects.get(cur2Key('2026-10', 'cloudpennies-00002.snappy.parquet'))!.length;
    const res = await run({ maxMonthBytes: octBytes - 1 });
    expect(res.months.map((m) => m.month)).toEqual(['2026-11']);
    expect(res.problem!.message).toMatch(/^October was skipped because its report files are very large/);
    expect(s3.gets.some((k) => k.includes('BILLING_PERIOD=2026-10') && k.endsWith('.parquet'))).toBe(false); // never downloaded
  });

  it('reports a broken file as a problem, keeps the other months and cleans up', async () => {
    stubListing({ dataExports: [cur2Export()] });
    const bucket = cur2Bucket();
    bucket[cur2Key('2026-10', 'cloudpennies-00002.snappy.parquet')] = Buffer.from('this is not parquet');
    stubS3(bucket);
    const res = await run();
    expect(res.months.map((m) => m.month)).toEqual(['2026-11']);
    expect(res.problem!.message).toMatch(/^October could not be imported: /);
    expect(res.problem!.missingPermission).toBeUndefined();
    expect(tmpLeftovers()).toEqual([]);
  });
});

describe('importCur: legacy reports', () => {
  const legacyBucket = (): Record<string, Buffer | string> => ({
    'old/reports/legacy-cur/20261001-20261101/legacy-cur-Manifest.json': JSON.stringify({ assemblyId: 'asm-1', reportKeys: ['old/reports/legacy-cur/20261001-20261101/asm-1/legacy-cur-00001.csv.gz'] }),
    'old/reports/legacy-cur/20261001-20261101/asm-1/legacy-cur-Manifest.json': JSON.stringify({ assemblyId: 'asm-1', reportKeys: ['old/reports/legacy-cur/20261001-20261101/asm-1/legacy-cur-00001.csv.gz'] }),
    'old/reports/legacy-cur/20261001-20261101/asm-1/legacy-cur-00001.csv.gz': legacyCsvGz(sampleLines('2026-10')),
    'old/reports/legacy-cur/20261001-20261101/asm-0/legacy-cur-00001.csv.gz': legacyCsvGz([{ start: '2026-10-01T00:00:00Z', unblended: 999 }]), // an older delivery
  });

  it('imports a legacy gzip CSV report through its manifest', async () => {
    stubListing({ legacy: [legacyReport()] });
    const s3 = stubS3(legacyBucket());
    const res = await run();
    expect(res.problem).toBeUndefined();
    expect(res.selected).toMatchObject({ id: 'legacy:legacy-cur', format: 'csv', prefix: 'old/reports' });
    expect(res.months.map((m) => [m.month, m.complete])).toEqual([['2026-10', true]]);
    expect(res.months[0].cost).toBeCloseTo(3.45, 9);
    expect(s3.gets.filter((k) => k.endsWith('.csv.gz'))).toEqual(['old/reports/legacy-cur/20261001-20261101/asm-1/legacy-cur-00001.csv.gz']);
    expect(new Set(s3.regions)).toEqual(new Set(['us-east-1']));
    const cur = await currentCurStore(dir, ACCOUNT);
    const res2 = await cur!.store.query({ start: '2026-10-01', end: '2026-11-01', granularity: 'DAILY', groupBy: ['RESOURCE_ID', 'REGION'], filters: { USAGE_TYPE: ['USE1-TimedStorage-ByteHrs'] } }, 'UnblendedCost');
    expect(res2!.rows).toEqual([{ keys: ['my-bucket', 'us-east-1'], date: '2026-10-04', cost: 0.25, usage: 11 }]);
    // unchanged assembly -> nothing to do
    s3.gets.length = 0;
    expect((await run()).imported).toEqual([]);
    expect(s3.gets.filter((k) => k.endsWith('.csv.gz'))).toEqual([]);
  });

  it('imports a legacy Parquet report by listing its year=/month= partition', async () => {
    stubListing({ legacy: [legacyReport({ Format: 'Parquet', Compression: 'Parquet', S3Prefix: '' })] });
    stubS3({
      'legacy-cur/legacy-cur/year=2026/month=11/legacy-cur-00001.snappy.parquet': parquetFile(sampleLines('2026-11')),
      'legacy-cur/legacy-cur/year=2026/month=9/legacy-cur-00001.snappy.parquet': parquetFile(sampleLines('2026-09').slice(0, 3)),
      'legacy-cur/legacy-cur/year=2026/month=1/legacy-cur-00001.snappy.parquet': parquetFile(sampleLines('2026-01')),
    });
    const res = await run();
    expect(res.problem).toBeUndefined();
    expect(res.months.map((m) => [m.month, Number(m.cost.toFixed(2))])).toEqual([['2026-09', 2.9], ['2026-11', 3.45]]);
  });
});

describe('importCur: problems', () => {
  it('explains how to create an export when there is none (informational)', async () => {
    stubListing({});
    const s3 = stubS3({});
    const res = await run();
    expect(res.problem).toEqual({ message: NO_EXPORT_MESSAGE, info: true });
    expect(res.problem!.message).toMatch(/Data Exports.*docs\/CUR\.md/);
    expect(res.months).toEqual([]);
    expect(s3.calls).toEqual([]);
    expect(statusOf(res)).toEqual({ exports: [], selected: null, months: [] }); // not an error in the status
  });

  it('says why when no export is usable', async () => {
    stubListing({ dataExports: [cur2Export({ config: { INCLUDE_RESOURCES: 'FALSE' } })] });
    stubS3({});
    const res = await run();
    expect(res.selected).toBeNull();
    expect(res.problem!.message).toMatch(/"cloudpennies" cannot be used\. This export does not include resource IDs/);
    expect(res.problem!.info).toBeUndefined();
  });

  it('names the missing permission when the listing APIs are denied', async () => {
    stubListing({ dataExports: denied('bcm-data-exports:ListExports'), legacy: denied('cur:DescribeReportDefinitions') });
    stubS3({});
    const res = await run();
    expect(res.problem!.missingPermission).toBe('bcm-data-exports:ListExports, cur:DescribeReportDefinitions');
  });

  it('names s3:ListBucket when the bucket cannot be listed (S3 hides missing keys as access denied)', async () => {
    stubListing({ dataExports: [cur2Export()] });
    const s3 = stubS3(cur2Bucket());
    s3.deny.list = true;
    s3.objects.delete(cur2Manifest('2026-11'));
    const res = await run();
    expect(res.problem).toEqual({ message: 'CloudPennies is not allowed to list the report files in the S3 bucket "acme-billing" (s3:ListBucket).', missingPermission: 's3:ListBucket' });
    expect(res.months).toEqual([]);
    expect(tmpLeftovers()).toEqual([]);
  });

  it('names s3:GetObject when the files cannot be read', async () => {
    stubListing({ dataExports: [cur2Export()] });
    const s3 = stubS3(cur2Bucket());
    s3.deny.get = true;
    const res = await run();
    expect(res.problem).toEqual({ message: 'CloudPennies is not allowed to read the report files in the S3 bucket "acme-billing" (s3:GetObject).', missingPermission: 's3:GetObject' });
    // one failure, not one per month
    expect(s3.calls.filter((c) => c.constructor.name === 'GetObjectCommand')).toHaveLength(1);
  });

  it('names the bucket and prefix it tried when nothing is found, and describes what is there', async () => {
    stubListing({ dataExports: [cur2Export()] });
    stubS3({});
    const empty = await run();
    expect(empty.problem!.message).toMatch(/^No report files were found for 2026-09, 2026-10, 2026-11 in s3:\/\/acme-billing\/exports\/cloudpennies\/ \(expected exports\/cloudpennies\/metadata\/BILLING_PERIOD=2026-11\/cloudpennies-Manifest\.json\)\. That location is empty: a new export delivers its first files within 24 hours\.$/);

    vi.restoreAllMocks();
    stubListing({ dataExports: [cur2Export()] });
    stubS3({ 'exports/cloudpennies/strange/layout/file.bin': 'x' });
    const odd = await run();
    expect(odd.problem!.message).toMatch(/holds other files \(for example exports\/cloudpennies\/strange\/layout\/file\.bin\); please report this layout/);
  });

  it('discovers data files in an unexpected place under the export root', async () => {
    stubListing({ dataExports: [cur2Export()] });
    stubS3({ 'exports/cloudpennies/v2/BILLING_PERIOD=2026-11/part-0.parquet': parquetFile(sampleLines('2026-11')) });
    const res = await run();
    expect(res.problem).toBeUndefined();
    expect(res.months.map((m) => m.month)).toEqual(['2026-11']);
  });

  it('reports a bucket that no longer exists', async () => {
    stubListing({ dataExports: [cur2Export()] });
    const { S3Client } = await import('@aws-sdk/client-s3');
    vi.spyOn(S3Client.prototype, 'send').mockImplementation((async () => {
      throw Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
    }) as never);
    const res = await run();
    expect(res.problem!.message).toBe('The S3 bucket "acme-billing" that the export delivers to does not exist.');
  });

  it('never throws, whatever the listing does', async () => {
    const { BCMDataExportsClient } = await import('@aws-sdk/client-bcm-data-exports');
    stubListing({});
    vi.spyOn(BCMDataExportsClient.prototype, 'send').mockImplementation((() => {
      throw new TypeError('synchronous surprise');
    }) as never);
    stubS3({});
    const res = await run();
    expect(res.problem!.message).toMatch(/Could not list Data Exports/);
  });
});

describe('curStatus', () => {
  const status = (refresh = false, curExportId = '') => curStatus({ credentials: CREDS, accountId: ACCOUNT, cacheDir: dir, settings: { curExportId }, refresh, now: () => new Date(NOW) });

  it('lists once, then answers from the cached listing until refreshed', async () => {
    const { calls } = stubListing({ dataExports: [cur2Export()], legacy: [legacyReport()] });
    stubS3(cur2Bucket());
    const first = await status();
    expect(first).toEqual({ exports: expect.any(Array), selected: CUR2_ARN, months: [] });
    expect(first.exports.map((e) => e.id)).toEqual([CUR2_ARN, 'legacy:legacy-cur']);
    const n = calls.length;
    expect(n).toBe(3);
    await status();
    expect(calls.length).toBe(n);
    await status(true);
    expect(calls.length).toBe(2 * n);

    // after an import the months of the selected export show up
    await run();
    const after = await status();
    expect(after.months.map((m) => m.month)).toEqual(['2026-10', '2026-11']);
    expect(after.lastError).toBeUndefined();
    // a different choice in Settings shows that export's (empty) store
    expect(await status(false, 'legacy:legacy-cur')).toMatchObject({ selected: 'legacy:legacy-cur', months: [] });
  });

  it('reports the last import failure and listing failures in lastError, without throwing', async () => {
    stubListing({ dataExports: [cur2Export()] });
    const s3 = stubS3(cur2Bucket());
    s3.deny.get = true;
    await run();
    expect(await status()).toMatchObject({ selected: CUR2_ARN, lastError: expect.stringMatching(/s3:GetObject/), missingPermission: 's3:GetObject' });
    // fixed and imported again: the error is gone
    s3.deny.get = false;
    await run();
    expect((await status()).lastError).toBeUndefined();

    vi.restoreAllMocks();
    stubListing({ dataExports: denied('bcm-data-exports:ListExports'), legacy: denied('cur:DescribeReportDefinitions') });
    const st = await status(true);
    expect(st).toMatchObject({ exports: [], selected: null, months: [], missingPermission: 'bcm-data-exports:ListExports, cur:DescribeReportDefinitions' });
    expect(st.lastError).toMatch(/not allowed to list/);
  });

  it('is well-formed when there is nothing at all', async () => {
    stubListing({});
    expect(await status()).toEqual({ exports: [], selected: null, months: [] });
  });
});
