// Cost and Usage Report reader: the pure parts (paths, export mapping, columns, cost basis, CSV, aggregation, services).
import { describe, expect, it } from 'vitest';
import {
  cur2DataPrefix,
  cur2ManifestKey,
  dataFileKind,
  daysInMonth,
  joinKey,
  legacyManifestKey,
  legacyParquetPrefix,
  legacyPeriod,
  legacyPeriodPrefix,
  monthLocations,
  monthsToImport,
  normalizePrefix,
  parseManifest,
  shiftMonth,
} from '../electron/aws/cur/paths';
import { exportTable, mapDataExport, mapLegacyReport, pickExport, querySelects, rankExports } from '../electron/aws/cur/exports';
import { lineItemCost, normalizeColumnName, productNameFromMap, resolveColumns, toDay, toLineItem, toNumber, type CostInputs, type Field } from '../electron/aws/cur/columns';
import { CsvParser, parseCsv } from '../electron/aws/cur/csv';
import { encodeMonth, foldResources, isMonthData, MonthAggregator, monthTotal, OTHER_RESOURCES, type AggRow } from '../electron/aws/cur/aggregate';
import { buildKnownServices, EC2_COMPUTE, EC2_OTHER, knownServicesFromJson, knownServicesToJson, resolveService } from '../electron/aws/cur/services';
import { keysOfMonth, newestDataFiles } from '../electron/aws/cur/locate';
import type { CostBasis, CurExport } from '../src/core/types';
import { cur2Export, CUR2_ARN, legacyReport } from './curFixtures';

describe('S3 paths', () => {
  it('normalizes prefixes', () => {
    expect(normalizePrefix('')).toBe('');
    expect(normalizePrefix(undefined)).toBe('');
    expect(normalizePrefix('/')).toBe('');
    expect(normalizePrefix('/a/b/')).toBe('a/b');
    expect(normalizePrefix(' a//b ')).toBe('a/b');
    expect(joinKey('', 'name')).toBe('name');
    expect(joinKey('/p/', '/name/', 'x')).toBe('p/name/x');
  });

  it('builds the CUR 2.0 layout', () => {
    expect(cur2ManifestKey('exports', 'cloudpennies', '2026-11')).toBe('exports/cloudpennies/metadata/BILLING_PERIOD=2026-11/cloudpennies-Manifest.json');
    expect(cur2DataPrefix('exports', 'cloudpennies', '2026-11')).toBe('exports/cloudpennies/data/BILLING_PERIOD=2026-11/');
    // empty prefix and stray slashes
    expect(cur2ManifestKey('', 'cur', '2026-01')).toBe('cur/metadata/BILLING_PERIOD=2026-01/cur-Manifest.json');
    expect(cur2ManifestKey('/a/b/', 'cur', '2026-01')).toBe('a/b/cur/metadata/BILLING_PERIOD=2026-01/cur-Manifest.json');
    expect(cur2DataPrefix('/', 'cur', '2026-01')).toBe('cur/data/BILLING_PERIOD=2026-01/');
  });

  it('builds the legacy CSV layout', () => {
    expect(legacyPeriod('2026-11')).toBe('20261101-20261201');
    expect(legacyPeriod('2026-12')).toBe('20261201-20270101');
    expect(legacyManifestKey('old/reports', 'legacy-cur', '2026-11')).toBe('old/reports/legacy-cur/20261101-20261201/legacy-cur-Manifest.json');
    expect(legacyManifestKey('', 'r', '2026-02')).toBe('r/20260201-20260301/r-Manifest.json');
    expect(legacyPeriodPrefix('/x/', 'r', '2026-02')).toBe('x/r/20260201-20260301/');
  });

  it('builds the legacy Parquet layout with an unpadded month', () => {
    expect(legacyParquetPrefix('p', 'r', '2026-03')).toBe('p/r/r/year=2026/month=3/');
    expect(legacyParquetPrefix('', 'r', '2026-11')).toBe('r/r/year=2026/month=11/');
  });

  it('dispatches per export kind and format', () => {
    const base = { name: 'r', prefix: '/p/' };
    expect(monthLocations({ ...base, kind: 'cur2', format: 'parquet' }, '2026-11')).toEqual({
      manifestKey: 'p/r/metadata/BILLING_PERIOD=2026-11/r-Manifest.json',
      manifestPrefix: 'p/r/metadata/BILLING_PERIOD=2026-11/',
      dataPrefix: 'p/r/data/BILLING_PERIOD=2026-11/',
      rootPrefix: 'p/r/',
    });
    expect(monthLocations({ ...base, kind: 'legacy', format: 'csv' }, '2026-11')).toEqual({
      manifestKey: 'p/r/20261101-20261201/r-Manifest.json',
      manifestPrefix: 'p/r/20261101-20261201/',
      dataPrefix: 'p/r/20261101-20261201/',
      rootPrefix: 'p/r/',
    });
    expect(monthLocations({ ...base, kind: 'legacy', format: 'parquet' }, '2026-11').dataPrefix).toBe('p/r/r/year=2026/month=11/');
    expect(monthLocations({ name: 'r', prefix: '', kind: 'cur2', format: 'csv' }, '2026-11').rootPrefix).toBe('r/');
  });

  it('lists the months to import, oldest first, across a year boundary', () => {
    expect(monthsToImport('2026-11-18', 3)).toEqual(['2026-09', '2026-10', '2026-11']);
    expect(monthsToImport('2026-02-01', 6)).toEqual(['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
    expect(monthsToImport('2026-11-18', 1)).toEqual(['2026-11']);
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(daysInMonth('2024-02')).toBe(29);
    expect(daysInMonth('2026-11')).toBe(30);
  });

  it('recognizes data files', () => {
    expect(dataFileKind('a/b/x-00001.snappy.parquet')).toBe('parquet');
    expect(dataFileKind('a/b/x-00001.csv.gz')).toBe('csv');
    expect(dataFileKind('a/b/x-00001.CSV')).toBe('csv');
    expect(dataFileKind('a/b/x-Manifest.json')).toBeNull();
    expect(dataFileKind('a/b/x.csv.zip')).toBeNull();
  });

  it('parses legacy and CUR 2.0 manifests', () => {
    expect(parseManifest({ assemblyId: 'abc', reportKeys: ['p/r/20261101-20261201/abc/r-00001.csv.gz', 'p/r/20261101-20261201/abc/r-00002.csv.gz'] })).toEqual({
      id: 'abc',
      files: ['p/r/20261101-20261201/abc/r-00001.csv.gz', 'p/r/20261101-20261201/abc/r-00002.csv.gz'],
    });
    expect(parseManifest({ executionId: 'e1', dataFiles: ['s3://bkt/p/r/data/BILLING_PERIOD=2026-11/r-00001.snappy.parquet'] }, 'bkt')).toEqual({
      id: 'e1',
      files: ['p/r/data/BILLING_PERIOD=2026-11/r-00001.snappy.parquet'],
    });
    // unknown shapes and non-data entries yield nothing rather than throwing
    expect(parseManifest({ dataFiles: [{ key: '/a/b.parquet' }, 42, 'a/readme.txt'] })).toEqual({ files: ['a/b.parquet'] });
    expect(parseManifest(null)).toEqual({ files: [] });
    expect(parseManifest('nope')).toEqual({ files: [] });
  });

  it('picks the newest delivery when a month has several, and finds a month in any layout', () => {
    const o = (key: string, t: number) => ({ key, size: 1, lastModified: t });
    expect(newestDataFiles([o('m/e1/a.parquet', 1), o('m/e2/b.parquet', 5), o('m/e2/a.parquet', 4), o('m/e2/x-Manifest.json', 9)]).map((f) => f.key)).toEqual(['m/e2/a.parquet', 'm/e2/b.parquet']);
    expect(newestDataFiles([o('m/readme.txt', 1)])).toEqual([]);
    const keys = ['x/data/BILLING_PERIOD=2026-11/a.parquet', 'x/data/BILLING_PERIOD=2026-10/a.parquet', 'x/20261101-20261201/a.csv.gz', 'x/x/year=2026/month=11/a.parquet', 'x/x/year=2026/month=1/a.parquet'].map((k) => o(k, 1));
    expect(keysOfMonth(keys, '2026-11').map((k) => k.key)).toEqual(['x/data/BILLING_PERIOD=2026-11/a.parquet', 'x/20261101-20261201/a.csv.gz', 'x/x/year=2026/month=11/a.parquet']);
    expect(keysOfMonth(keys, '2026-01').map((k) => k.key)).toEqual(['x/x/year=2026/month=1/a.parquet']);
  });
});

describe('export discovery', () => {
  it('maps a CUR 2.0 Data Export', () => {
    expect(mapDataExport(cur2Export())).toEqual({
      id: CUR2_ARN,
      name: 'cloudpennies',
      kind: 'cur2',
      bucket: 'acme-billing',
      prefix: 'exports',
      region: 'eu-west-1',
      format: 'parquet',
      hasResourceIds: true,
      granularity: 'HOURLY',
      usable: true,
    });
    const csv = mapDataExport(cur2Export({ format: 'TEXT_OR_CSV', compression: 'GZIP', prefix: '/a/b/', config: { TIME_GRANULARITY: 'DAILY', INCLUDE_RESOURCES: 'TRUE' } }));
    expect(csv).toMatchObject({ format: 'csv', prefix: 'a/b', granularity: 'DAILY', usable: true });
    expect(mapDataExport(cur2Export({ query: 'SELECT * FROM COST_AND_USAGE_REPORT' })).usable).toBe(true);
  });

  it('marks exports without resource ids unusable, with a reason', () => {
    const off = mapDataExport(cur2Export({ config: { TIME_GRANULARITY: 'DAILY', INCLUDE_RESOURCES: 'FALSE' } }));
    expect(off).toMatchObject({ usable: false, hasResourceIds: false });
    expect(off.reason).toMatch(/resource IDs/);
    // INCLUDE_RESOURCES is on but the query does not select the column
    const notSelected = mapDataExport(cur2Export({ query: 'SELECT line_item_usage_start_date, line_item_unblended_cost, line_item_line_item_type FROM COST_AND_USAGE_REPORT' }));
    expect(notSelected).toMatchObject({ usable: false, hasResourceIds: false });
    // a column whose name merely contains the wanted one does not count
    expect(querySelects('SELECT x_line_item_resource_id_y FROM t', 'line_item_resource_id')).toBe(false);
    expect(querySelects('select a,\n  line_item_resource_id\nfrom t', 'line_item_resource_id')).toBe(true);
  });

  it('marks other tables and unsupported formats unusable', () => {
    const focus = mapDataExport(cur2Export({ table: 'FOCUS_1_0_AWS', config: {}, query: 'SELECT BilledCost, ResourceId FROM FOCUS_1_0_AWS' }));
    expect(focus.usable).toBe(false);
    expect(focus.reason).toMatch(/FOCUS data, not Cost and Usage Report/);
    expect(mapDataExport(cur2Export({ table: 'COST_OPTIMIZATION_RECOMMENDATIONS', config: { INCLUDE_ALL_RECOMMENDATIONS: 'TRUE' } })).reason).toMatch(/cost optimization recommendations/);
    expect(mapDataExport(cur2Export({ table: 'CARBON_EMISSIONS', config: {} })).reason).toMatch(/carbon emissions/);
    expect(exportTable({ DataQuery: { QueryStatement: 'select a from carbon_emissions', TableConfigurations: undefined } })).toBe('CARBON_EMISSIONS');
    expect(mapDataExport(cur2Export({ format: 'TEXT_OR_CSV', compression: 'ZIP' as never })).reason).toMatch(/ZIP/);
    const missingColumns = mapDataExport(cur2Export({ query: 'SELECT line_item_resource_id, line_item_unblended_cost FROM COST_AND_USAGE_REPORT' }));
    expect(missingColumns.reason).toMatch(/line_item_usage_start_date, line_item_line_item_type/);
  });

  it('maps legacy report definitions', () => {
    expect(mapLegacyReport(legacyReport())).toEqual({
      id: 'legacy:legacy-cur',
      name: 'legacy-cur',
      kind: 'legacy',
      bucket: 'acme-billing',
      prefix: 'old/reports',
      region: 'us-east-1',
      format: 'csv',
      hasResourceIds: true,
      granularity: 'DAILY',
      usable: true,
    });
    expect(mapLegacyReport(legacyReport({ Format: 'Parquet', Compression: 'Parquet', TimeUnit: 'HOURLY' }))).toMatchObject({ format: 'parquet', granularity: 'HOURLY', usable: true });
    const noRes = mapLegacyReport(legacyReport({ AdditionalSchemaElements: ['SPLIT_COST_ALLOCATION_DATA'] }));
    expect(noRes).toMatchObject({ usable: false, hasResourceIds: false });
    expect(noRes.reason).toMatch(/resource IDs/);
    expect(mapLegacyReport(legacyReport({ Compression: 'ZIP' })).reason).toMatch(/ZIP/);
  });

  it('auto-selects: usable, CUR 2.0 over legacy, Parquet over CSV', () => {
    const e = (id: string, o: Partial<CurExport>): CurExport => ({ id, name: id, kind: 'cur2', bucket: 'b', prefix: '', region: 'us-east-1', format: 'parquet', hasResourceIds: true, granularity: 'DAILY', usable: true, ...o });
    const legacyParquet = e('legacy:p', { kind: 'legacy' });
    const legacyCsv = e('legacy:c', { kind: 'legacy', format: 'csv' });
    const cur2Csv = e('cur2csv', { format: 'csv' });
    const cur2Parquet = e('cur2parquet', {});
    const broken = e('a-broken', { usable: false, reason: 'no' });
    const all = [legacyCsv, broken, legacyParquet, cur2Csv, cur2Parquet];
    expect(rankExports(all).map((x) => x.id)).toEqual(['cur2parquet', 'cur2csv', 'legacy:p', 'legacy:c', 'a-broken']);
    expect(pickExport(all)?.id).toBe('cur2parquet');
    expect(pickExport([legacyCsv, legacyParquet, broken])?.id).toBe('legacy:p');
    expect(pickExport([e('h', { granularity: 'HOURLY' }), e('d', {})])?.id).toBe('d'); // granularity does not matter: by name
    // an explicit choice wins when usable; otherwise falls back to automatic
    expect(pickExport(all, 'legacy:c')?.id).toBe('legacy:c');
    expect(pickExport(all, 'a-broken')?.id).toBe('cur2parquet');
    expect(pickExport(all, 'gone')?.id).toBe('cur2parquet');
    expect(pickExport([broken])).toBeNull();
    expect(pickExport([])).toBeNull();
  });
});

describe('column resolver', () => {
  it('normalizes the three naming styles to one', () => {
    expect(normalizeColumnName('lineItem/UsageStartDate')).toBe('line_item_usage_start_date');
    expect(normalizeColumnName('reservation/ReservationARN')).toBe('reservation_reservation_a_r_n');
    expect(normalizeColumnName('savingsPlan/SavingsPlanEffectiveCost')).toBe('savings_plan_savings_plan_effective_cost');
    expect(normalizeColumnName('product/region')).toBe('product_region');
    expect(normalizeColumnName('Line_Item_Usage_Start_Date')).toBe('line_item_usage_start_date');
    expect(normalizeColumnName(' line_item_resource_id ')).toBe('line_item_resource_id');
  });

  it('resolves CUR 2.0 columns (product map, region code)', () => {
    const m = resolveColumns(['bill_billing_period_start_date', 'line_item_usage_start_date', 'line_item_usage_account_id', 'line_item_product_code', 'line_item_usage_type', 'line_item_operation', 'line_item_resource_id', 'line_item_line_item_type', 'line_item_unblended_cost', 'line_item_usage_amount', 'product', 'product_region_code', 'reservation_reservation_a_r_n']);
    expect(m).toMatchObject({ usageStart: 'line_item_usage_start_date', region: 'product_region_code', productMap: 'product', reservationArn: 'reservation_reservation_a_r_n', resourceId: 'line_item_resource_id' });
    expect(m.productName).toBeUndefined();
    expect(m.netUnblended).toBeUndefined();
  });

  it('resolves legacy Parquet columns (flat product name, product_region), any case', () => {
    const m = resolveColumns(['LINE_ITEM_USAGE_START_DATE', 'line_item_line_item_type', 'line_item_unblended_cost', 'line_item_net_unblended_cost', 'product_product_name', 'product_region', 'product', 'savings_plan_net_savings_plan_effective_cost']);
    expect(m).toMatchObject({ usageStart: 'LINE_ITEM_USAGE_START_DATE', productName: 'product_product_name', region: 'product_region', netUnblended: 'line_item_net_unblended_cost', netSpEffective: 'savings_plan_net_savings_plan_effective_cost' });
    expect(m.productMap).toBeUndefined(); // not needed when the flat column exists
  });

  it('resolves legacy CSV columns and tolerates missing optional ones', () => {
    const m = resolveColumns(['identity/LineItemId', 'lineItem/UsageStartDate', 'lineItem/UsageAccountId', 'lineItem/ProductCode', 'lineItem/ResourceId', 'lineItem/LineItemType', 'lineItem/UnblendedCost', 'product/ProductName', 'product/region', 'product/regionCode', 'reservation/ReservationARN', 'reservation/UnusedAmortizedUpfrontFeeForBillingPeriod', 'savingsPlan/TotalCommitmentToDate']);
    expect(m).toMatchObject({
      usageStart: 'lineItem/UsageStartDate',
      account: 'lineItem/UsageAccountId',
      productCode: 'lineItem/ProductCode',
      resourceId: 'lineItem/ResourceId',
      productName: 'product/ProductName',
      region: 'product/regionCode',
      reservationArn: 'reservation/ReservationARN',
      riUnusedUpfront: 'reservation/UnusedAmortizedUpfrontFeeForBillingPeriod',
      spTotalCommitment: 'savingsPlan/TotalCommitmentToDate',
    });
    expect(m.usageType).toBeUndefined();
    expect(m.operation).toBeUndefined();
  });

  it('coerces dates, numbers and the product map', () => {
    expect(toDay(new Date('2026-11-03T23:00:00Z'))).toBe('2026-11-03');
    expect(toDay('2026-11-03T00:00:00Z')).toBe('2026-11-03');
    expect(toDay('2026-11-03 13:00:00.000')).toBe('2026-11-03');
    expect(toDay(Date.UTC(2026, 10, 3, 5))).toBe('2026-11-03'); // ms
    expect(toDay(Date.UTC(2026, 10, 3, 5) / 1000)).toBe('2026-11-03'); // s
    expect(toDay(Date.UTC(2026, 10, 3, 5) * 1000)).toBe('2026-11-03'); // µs
    expect(toDay(BigInt(Date.UTC(2026, 10, 3, 5)) * 1000000n)).toBe('2026-11-03'); // ns
    expect(toDay('1793682000')).toBe('2026-11-03');
    expect(toDay('')).toBeUndefined();
    expect(toDay('garbage')).toBeUndefined();
    expect(toDay(new Date(NaN))).toBeUndefined();
    expect(toNumber('1.50')).toBe(1.5);
    expect(toNumber('')).toBeUndefined();
    expect(toNumber(null)).toBeUndefined();
    expect(toNumber(7n)).toBe(7);
    expect(toNumber('abc')).toBeUndefined();
    expect(productNameFromMap({ product_name: 'Amazon Simple Storage Service', region: 'x' })).toBe('Amazon Simple Storage Service');
    expect(productNameFromMap(new Map([['product_name', 'AWS Lambda']]))).toBe('AWS Lambda');
    expect(productNameFromMap([{ key: 'product_name', value: 'A' }])).toBe('A');
    expect(productNameFromMap('{"product_name":"B"}')).toBe('B');
    expect(productNameFromMap('{broken')).toBe('');
    expect(productNameFromMap(null)).toBe('');
  });

  it('normalizes a row, falling back to the billing period for a missing date', () => {
    const row: Partial<Record<Field, unknown>> = { usageStart: '', billingPeriodStart: '2026-11-01T00:00:00Z', lineItemType: 'Usage', unblended: '0.5', usageAmount: '3', account: ' 111 ', productCode: 'AmazonS3', productMap: { product_name: 'Amazon Simple Storage Service' }, resourceId: null };
    expect(toLineItem((f) => row[f], 'UnblendedCost')).toEqual({ day: '2026-11-01', account: '111', productCode: 'AmazonS3', productName: 'Amazon Simple Storage Service', usageType: '', operation: '', region: '', resourceId: '', lineItemType: 'Usage', cost: 0.5, usage: 3 });
    expect(toLineItem((f) => ({ ...row, lineItemType: 'Refund' })[f], 'UnblendedCost')).toBeNull();
    expect(toLineItem((f) => ({ ...row, billingPeriodStart: undefined })[f], 'UnblendedCost')).toBeNull();
  });
});

describe('cost basis', () => {
  const base: CostInputs = {
    lineItemType: 'Usage',
    unblended: 10,
    netUnblended: 9,
    spEffective: 6,
    netSpEffective: 5,
    spTotalCommitment: 100,
    spUsedCommitment: 70,
    riEffective: 4,
    netRiEffective: 3,
    riUnusedUpfront: 2,
    netRiUnusedUpfront: 1.5,
    riUnusedRecurring: 1,
    netRiUnusedRecurring: 0.5,
    reservationArn: '',
  };
  const cost = (basis: CostBasis, o: Partial<CostInputs>) => lineItemCost(basis, { ...base, ...o });
  const ALL: CostBasis[] = ['UnblendedCost', 'NetUnblendedCost', 'AmortizedCost', 'NetAmortizedCost'];

  it('always drops credits and refunds', () => {
    for (const b of ALL) {
      expect(cost(b, { lineItemType: 'Credit' })).toBeNull();
      expect(cost(b, { lineItemType: 'Refund' })).toBeNull();
      expect(cost(b, { lineItemType: ' refund ' })).toBeNull();
    }
  });

  it('unblended and net unblended ignore the line item type', () => {
    for (const t of ['Usage', 'Tax', 'Fee', 'RIFee', 'DiscountedUsage', 'SavingsPlanCoveredUsage', 'SavingsPlanRecurringFee', 'SavingsPlanNegation', 'SavingsPlanUpfrontFee', 'BundledDiscount']) {
      expect(cost('UnblendedCost', { lineItemType: t })).toBe(10);
      expect(cost('NetUnblendedCost', { lineItemType: t })).toBe(9);
    }
    // the net column is absent (no discounts on the account) or empty: fall back to unblended
    expect(cost('NetUnblendedCost', { netUnblended: undefined })).toBe(10);
    expect(cost('UnblendedCost', { unblended: undefined })).toBe(0);
  });

  it('applies the amortization rule for every line item type', () => {
    const cases: [string, Partial<CostInputs>, number, number][] = [
      // type, overrides, AmortizedCost, NetAmortizedCost
      ['Usage', {}, 10, 9],
      ['Tax', {}, 10, 9],
      ['BundledDiscount', {}, 10, 9],
      ['SavingsPlanCoveredUsage', {}, 6, 5],
      ['SavingsPlanRecurringFee', {}, 30, 30],
      ['SavingsPlanNegation', {}, 0, 0],
      ['SavingsPlanUpfrontFee', {}, 0, 0],
      ['DiscountedUsage', {}, 4, 3],
      ['RIFee', {}, 3, 2],
      ['Fee', { reservationArn: 'arn:aws:ec2:us-east-1:1:reserved-instances/abc' }, 0, 0],
      ['Fee', { reservationArn: '' }, 10, 9],
      ['Fee', { reservationArn: undefined }, 10, 9],
    ];
    for (const [lineItemType, o, amortized, net] of cases) {
      expect([lineItemType, cost('AmortizedCost', { lineItemType, ...o })]).toEqual([lineItemType, amortized]);
      expect([lineItemType, cost('NetAmortizedCost', { lineItemType, ...o })]).toEqual([lineItemType, net]);
    }
    // case-insensitive type names
    expect(cost('AmortizedCost', { lineItemType: 'savingsplancoveredusage' })).toBe(6);
  });

  it('falls back to the plain columns when a net column is missing, and to 0 when both are', () => {
    expect(cost('NetAmortizedCost', { lineItemType: 'SavingsPlanCoveredUsage', netSpEffective: undefined })).toBe(6);
    expect(cost('NetAmortizedCost', { lineItemType: 'DiscountedUsage', netRiEffective: undefined })).toBe(4);
    expect(cost('NetAmortizedCost', { lineItemType: 'RIFee', netRiUnusedUpfront: undefined, netRiUnusedRecurring: undefined })).toBe(3);
    expect(cost('NetAmortizedCost', { lineItemType: 'Usage', netUnblended: undefined })).toBe(10);
    expect(cost('AmortizedCost', { lineItemType: 'SavingsPlanCoveredUsage', spEffective: undefined })).toBe(0);
    expect(cost('AmortizedCost', { lineItemType: 'RIFee', riUnusedUpfront: undefined })).toBe(1);
    expect(cost('AmortizedCost', { lineItemType: 'SavingsPlanRecurringFee', spUsedCommitment: undefined })).toBe(100);
  });
});

describe('CSV parser', () => {
  it('parses plain rows with LF, CRLF and no trailing newline', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('keeps empty fields and skips blank lines', () => {
    expect(parseCsv('a,,c\n,,\n\n\r\nx,y,\n')).toEqual([['a', '', 'c'], ['', '', ''], ['x', 'y', '']]);
    expect(parseCsv('""\n')).toEqual([['']]); // a quoted empty value is a row, not a blank line
  });

  it('handles quoted fields with commas, newlines and doubled quotes', () => {
    expect(parseCsv('id,desc\n1,"a, b"\n2,"line1\nline2"\n3,"say ""hi"""\n4,"",z\n')).toEqual([
      ['id', 'desc'],
      ['1', 'a, b'],
      ['2', 'line1\nline2'],
      ['3', 'say "hi"'],
      ['4', '', 'z'],
    ]);
    expect(parseCsv('"a","b\r\nc",d\r\n')).toEqual([['a', 'b\r\nc', 'd']]);
    // a quote in the middle of an unquoted field is literal; an unterminated quote ends with the input
    expect(parseCsv('5" disk,x\n')).toEqual([['5" disk', 'x']]);
    expect(parseCsv('a,"unterminated')).toEqual([['a', 'unterminated']]);
  });

  it('strips a byte order mark', () => {
    expect(parseCsv('﻿a,b\n')).toEqual([['a', 'b']]);
  });

  it('gives the same rows whatever the chunk boundaries', () => {
    const text = 'id,desc,n\r\n1,"a, ""quoted"" b",2\r\n2,"multi\r\nline",3\n3,,\n4,"",x';
    const whole = parseCsv(text);
    expect(whole).toHaveLength(5);
    for (let size = 1; size <= 7; size++) {
      const rows: string[][] = [];
      const p = new CsvParser((r) => rows.push(r));
      for (let i = 0; i < text.length; i += size) p.write(text.slice(i, i + size));
      p.end();
      expect(rows).toEqual(whole);
    }
  });
});

describe('aggregation and folding', () => {
  const item = (o: Partial<Parameters<MonthAggregator['add']>[0]>) => ({ day: '2026-10-03', account: '1', productCode: 'AmazonEC2', productName: 'Amazon Elastic Compute Cloud', usageType: 'BoxUsage', operation: 'RunInstances', region: 'us-east-1', resourceId: 'i-1', lineItemType: 'Usage', cost: 1, usage: 1, ...o });

  it('collapses hourly lines into days and keeps the total', () => {
    const agg = new MonthAggregator('2026-10');
    agg.add(item({}));
    agg.add(item({ cost: 2, usage: 3 }));
    agg.add(item({ day: '2026-10-04' }));
    agg.add(item({ resourceId: '' }));
    const rows = agg.rows();
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.day === '2026-10-03' && r.resource === 'i-1')).toMatchObject({ cost: 3, usage: 4, product: 'AmazonEC2' });
    expect(agg.total).toBe(5);
    expect(agg.lines).toBe(4);
    expect(agg.productNames()).toEqual({ AmazonEC2: 'Amazon Elastic Compute Cloud' });
  });

  it('books tax under the Tax service and out-of-month dates on the nearest day', () => {
    const agg = new MonthAggregator('2026-10');
    agg.add(item({ lineItemType: 'Tax', resourceId: '', usageType: '', cost: 0.3 }));
    agg.add(item({ day: '2026-09-30', cost: 4 }));
    agg.add(item({ day: '2026-11-02', cost: 5 }));
    const rows = agg.rows();
    expect(rows.find((r) => r.product === 'Tax')).toMatchObject({ cost: 0.3, resource: '' });
    expect(rows.find((r) => r.cost === 4)!.day).toBe('2026-10-01');
    expect(rows.find((r) => r.cost === 5)!.day).toBe('2026-10-31');
    expect(agg.productNames().Tax).toBe('Tax');
  });

  const row = (resource: string, cost: number, o: Partial<AggRow> = {}): AggRow => ({ day: '2026-10-03', account: '1', product: 'AmazonS3', usageType: 'TimedStorage', operation: 'Put', region: 'us-east-1', resource, cost, usage: 1, ...o });
  const sum = (rows: AggRow[]) => rows.reduce((a, r) => a + r.cost, 0);
  const usage = (rows: AggRow[]) => rows.reduce((a, r) => a + r.usage, 0);

  it('keeps the resources behind 99.5% of each group and folds the long tail, preserving totals', () => {
    // two buckets worth 99.9%, then 400 tiny ones worth 0.1% together
    const rows = [row('big', 990), row('medium', 9), ...Array.from({ length: 400 }, (_, i) => row(`tiny-${i}`, 0.0025)), row('', 7)];
    const folded = foldResources(rows);
    expect(sum(folded)).toBeCloseTo(sum(rows), 9);
    expect(usage(folded)).toBe(usage(rows));
    const ids = new Set(folded.map((r) => r.resource));
    expect(ids.has('big')).toBe(true);
    expect(ids.has('medium')).toBe(true);
    expect(ids.has('')).toBe(true); // lines without a resource id are never folded
    expect(ids.has(OTHER_RESOURCES)).toBe(true);
    expect(ids.size).toBeLessThan(250);
    expect(folded.find((r) => r.resource === '')!.cost).toBe(7);
    // rows folded into the same key are merged
    expect(folded.filter((r) => r.resource === OTHER_RESOURCES)).toHaveLength(1);
  });

  it('judges each (account, product, usage type, region) group on its own', () => {
    const rows = [row('huge', 1_000_000), row('small-but-alone', 0.01, { usageType: 'Requests' }), row('other-region', 0.02, { region: 'eu-west-1' })];
    const ids = foldResources(rows).map((r) => r.resource);
    expect(ids).toEqual(['huge', 'small-but-alone', 'other-region']);
  });

  it('caps the number of resources per month, largest first, and still reconciles', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`r${i}`, i + 1, { usageType: `u${i}` }));
    const folded = foldResources(rows, { maxResources: 10 });
    const kept = folded.filter((r) => r.resource !== OTHER_RESOURCES).map((r) => r.resource);
    expect(kept).toHaveLength(10);
    expect(kept).toContain('r49');
    expect(kept).not.toContain('r0');
    expect(sum(folded)).toBe(sum(rows));
    expect(foldResources(rows, { maxResources: 0 }).every((r) => r.resource === OTHER_RESOURCES)).toBe(true);
  });

  it('folds resources that cost nothing and ranks negative costs by size', () => {
    const folded = foldResources([row('free-a', 0), row('free-b', 0), row('discounted', -50), row('x', 0.01)]);
    expect(folded.map((r) => r.resource).sort()).toEqual([OTHER_RESOURCES, 'discounted']);
    expect(sum(folded)).toBeCloseTo(-49.99, 9);
  });

  it('dictionary-encodes a month and validates what it reads back', () => {
    const rows = [row('b', 2, { day: '2026-10-05' }), row('a', 1), row('a', 3, { day: '2026-10-05' }), row('zero', 0, { usage: 0 })];
    const data = encodeMonth('2026-10', 'UnblendedCost', rows, { AmazonS3: 'Amazon Simple Storage Service', Unused: 'x' });
    expect(data.day).toEqual([3, 5, 5]); // ordered by day; the all-zero row is dropped
    expect(data.dict.resource).toEqual(['a', 'b']);
    expect(data.cols.resource).toEqual([0, 1, 0]);
    expect(data.dict.product).toEqual(['AmazonS3']);
    expect(data.productNames).toEqual({ AmazonS3: 'Amazon Simple Storage Service' });
    expect(monthTotal(data)).toBe(6);
    expect(isMonthData(JSON.parse(JSON.stringify(data)))).toBe(true);
    expect(isMonthData({ ...data, cost: [1] })).toBe(false);
    expect(isMonthData({ v: 2 })).toBe(false);
    expect(isMonthData(null)).toBe(false);
  });
});

describe('resolveService', () => {
  const known = buildKnownServices([
    { keys: [EC2_COMPUTE, 'USE1-BoxUsage:t3.micro'], date: '2026-11-01', cost: 1 },
    { keys: [EC2_OTHER, 'USE1-EBS:VolumeUsage.gp3'], date: '2026-11-01', cost: 1 },
    { keys: ['AmazonCloudWatch', 'USE1-CW:Requests'], date: '2026-11-01', cost: 1 },
    { keys: ['Amazon Simple Storage Service', 'USE1-DataTransfer-Out-Bytes'], date: '2026-11-01', cost: 1 },
    { keys: [EC2_OTHER, 'USE1-DataTransfer-Out-Bytes'], date: '2026-11-01', cost: 1 },
    { keys: ['Amazon Relational Database Service', 'USE1-DataTransfer-Out-Bytes'], date: '2026-11-02', cost: 1 },
    { keys: ['Some Marketplace Thing', 'MP:Hours'], date: '2026-11-01', cost: 1 },
    { keys: ['Another Marketplace Thing', 'MP:Hours'], date: '2026-11-01', cost: 1 },
    { keys: [EC2_OTHER, 'USE1-NatGateway-Hours'], date: '2026-11-01', cost: 1 },
  ]);

  it('builds the usage type map from Cost Explorer rows and round-trips it through JSON', () => {
    expect(known.get('USE1-DataTransfer-Out-Bytes')!.size).toBe(3);
    expect(known.get('USE1-BoxUsage:t3.micro')).toEqual(new Set([EC2_COMPUTE]));
    expect(knownServicesFromJson(JSON.parse(JSON.stringify(knownServicesToJson(known))))).toEqual(known);
    expect(knownServicesFromJson(null).size).toBe(0);
  });

  it('uses the single Cost Explorer service of a usage type', () => {
    expect(resolveService('AmazonEC2', 'Amazon Elastic Compute Cloud', 'USE1-BoxUsage:t3.micro', known)).toBe(EC2_COMPUTE);
    expect(resolveService('AmazonEC2', 'Amazon Elastic Compute Cloud', 'USE1-EBS:VolumeUsage.gp3', known)).toBe(EC2_OTHER);
    expect(resolveService('AmazonCloudWatch', 'AmazonCloudWatch', 'USE1-CW:Requests', known)).toBe('AmazonCloudWatch');
    expect(resolveService('SomeSeller', 'Whatever', 'USE1-NatGateway-Hours', known)).toBe(EC2_OTHER);
    // ...unless the product code is a well-known one that belongs elsewhere
    expect(resolveService('AmazonS3', 'Amazon Simple Storage Service', 'USE1-NatGateway-Hours', known)).toBe('Amazon Simple Storage Service');
  });

  it('chooses by product code when several services share the usage type', () => {
    expect(resolveService('AmazonS3', 'Amazon Simple Storage Service', 'USE1-DataTransfer-Out-Bytes', known)).toBe('Amazon Simple Storage Service');
    expect(resolveService('AmazonEC2', 'Amazon Elastic Compute Cloud', 'USE1-DataTransfer-Out-Bytes', known)).toBe(EC2_OTHER);
    expect(resolveService('AmazonRDS', 'Amazon Relational Database Service', 'USE1-DataTransfer-Out-Bytes', known)).toBe('Amazon Relational Database Service');
    // not in the table: the product name when it is one of the candidates, else a stable pick
    expect(resolveService('xyz', 'Some Marketplace Thing', 'MP:Hours', known)).toBe('Some Marketplace Thing');
    expect(resolveService('xyz', 'Unrelated', 'MP:Hours', known)).toBe('Another Marketplace Thing');
  });

  it('falls back to the table, the product name, then the product code for unseen usage types', () => {
    const none = new Map<string, Set<string>>();
    expect(resolveService('AmazonEC2', 'Amazon Elastic Compute Cloud', 'EUW1-BoxUsage:m5.large', none)).toBe(EC2_COMPUTE);
    expect(resolveService('AmazonEC2', 'Amazon Elastic Compute Cloud', 'EUW1-SpotUsage:m5.large', none)).toBe(EC2_COMPUTE);
    expect(resolveService('AmazonEC2', 'Amazon Elastic Compute Cloud', 'EUW1-EBS:SnapshotUsage', none)).toBe(EC2_OTHER);
    expect(resolveService('AmazonS3', '', 'x', none)).toBe('Amazon Simple Storage Service');
    expect(resolveService('awskms', 'AWS Key Management Service', 'x', none)).toBe('AWS Key Management Service');
    expect(resolveService('AWSELB', 'Elastic Load Balancing', 'x', none)).toBe('Amazon Elastic Load Balancing');
    for (const [code, name] of [['AmazonCloudWatch', 'AmazonCloudWatch'], ['AmazonRDS', 'Amazon Relational Database Service'], ['AmazonDynamoDB', 'Amazon DynamoDB'], ['AWSLambda', 'AWS Lambda'], ['AmazonVPC', 'Amazon Virtual Private Cloud'], ['AmazonECS', 'Amazon Elastic Container Service'], ['AmazonEKS', 'Amazon Elastic Container Service for Kubernetes'], ['AmazonElastiCache', 'Amazon ElastiCache'], ['AmazonES', 'Amazon OpenSearch Service'], ['AWSCloudTrail', 'AWS CloudTrail'], ['AWSConfig', 'AWS Config'], ['AmazonRoute53', 'Amazon Route 53'], ['AmazonCloudFront', 'Amazon CloudFront'], ['AmazonBedrock', 'Amazon Bedrock']]) {
      expect(resolveService(code, 'ignored', 'x', none)).toBe(name);
    }
    expect(resolveService('NewService', 'AWS Shiny New Service', 'x', none)).toBe('AWS Shiny New Service');
    expect(resolveService('NewService', '', 'x', none)).toBe('NewService');
    expect(resolveService('', '', '', none)).toBe('Unknown');
    expect(resolveService('Tax', 'Tax', '', known)).toBe('Tax');
  });
});
