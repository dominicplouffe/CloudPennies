// Pure S3 key builders and manifest parsing for the three Cost and Usage Report layouts.
//
//  CUR 2.0 (Data Exports):  <prefix>/<name>/metadata/BILLING_PERIOD=YYYY-MM/<name>-Manifest.json
//                           <prefix>/<name>/data/BILLING_PERIOD=YYYY-MM/<files>
//  Legacy CSV:              <prefix>/<name>/YYYYMMDD-YYYYMMDD/<name>-Manifest.json  (reportKeys)
//  Legacy Parquet:          <prefix>/<name>/<name>/year=YYYY/month=M/<files>.parquet
//
// These layouts follow the AWS documentation; they could not be checked against a real bucket, which is
// why the importer falls back to listing when a manifest is not where it is expected (see locate.ts).
import type { CurExport } from '../../../src/core/types';

/** '' | 'a/b' — no leading/trailing slashes, no empty segments. */
export function normalizePrefix(prefix: string | undefined | null): string {
  return String(prefix ?? '')
    .trim()
    .split('/')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join('/');
}

export function joinKey(...parts: (string | undefined | null)[]): string {
  return parts
    .map((p) => normalizePrefix(p))
    .filter((p) => p.length > 0)
    .join('/');
}

/** `<prefix>/<name>` — everything an export writes lives under this key prefix. */
export const exportRoot = (prefix: string, name: string): string => joinKey(prefix, name);

const MONTH = /^(\d{4})-(\d{2})$/;

function parts(month: string): { y: number; m: number } {
  const x = MONTH.exec(month);
  if (!x) throw new Error(`Invalid month: ${month}`);
  return { y: Number(x[1]), m: Number(x[2]) };
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** 'YYYY-MM' -> 'YYYY-MM' of the month `n` months away */
export function shiftMonth(month: string, n: number): string {
  const { y, m } = parts(month);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

/** The last `count` billing months ending with the month of `today` (ISO date), oldest first. */
export function monthsToImport(today: string, count: number): string[] {
  const current = today.slice(0, 7);
  const out: string[] = [];
  for (let i = Math.max(1, Math.floor(count)) - 1; i >= 0; i--) out.push(shiftMonth(current, -i));
  return out;
}

/** Number of days in a 'YYYY-MM' month. */
export function daysInMonth(month: string): number {
  const { y, m } = parts(month);
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

// ── CUR 2.0 ──

export const cur2MetadataPrefix = (prefix: string, name: string, month: string): string =>
  `${joinKey(prefix, name, 'metadata', `BILLING_PERIOD=${month}`)}/`;

export const cur2ManifestKey = (prefix: string, name: string, month: string): string =>
  `${cur2MetadataPrefix(prefix, name, month)}${name}-Manifest.json`;

export const cur2DataPrefix = (prefix: string, name: string, month: string): string => `${joinKey(prefix, name, 'data', `BILLING_PERIOD=${month}`)}/`;

// ── legacy ──

/** '2026-11' -> '20261101-20261201' */
export function legacyPeriod(month: string): string {
  const { y, m } = parts(month);
  const next = shiftMonth(month, 1);
  return `${y}${pad(m)}01-${next.replace('-', '')}01`;
}

export const legacyPeriodPrefix = (prefix: string, name: string, month: string): string => `${joinKey(prefix, name, legacyPeriod(month))}/`;

export const legacyManifestKey = (prefix: string, name: string, month: string): string => `${legacyPeriodPrefix(prefix, name, month)}${name}-Manifest.json`;

/** Parquet reports are partitioned Hive-style, with an unpadded month number. */
export function legacyParquetPrefix(prefix: string, name: string, month: string): string {
  const { y, m } = parts(month);
  return `${joinKey(prefix, name, name, `year=${y}`, `month=${m}`)}/`;
}

// ── per-export dispatch ──

export interface MonthLocations {
  /** where the manifest should be */
  manifestKey: string;
  /** prefix to list for other manifests of the same month (versioned deliveries keep one per execution) */
  manifestPrefix: string;
  /** prefix to list for the data files when no manifest can be read */
  dataPrefix: string;
  /** `<prefix>/<name>/` — listed to describe the bucket when nothing is found */
  rootPrefix: string;
}

export function monthLocations(exp: Pick<CurExport, 'kind' | 'format' | 'prefix' | 'name'>, month: string): MonthLocations {
  const root = exportRoot(exp.prefix, exp.name);
  const rootPrefix = root ? `${root}/` : '';
  if (exp.kind === 'cur2') {
    return {
      manifestKey: cur2ManifestKey(exp.prefix, exp.name, month),
      manifestPrefix: cur2MetadataPrefix(exp.prefix, exp.name, month),
      dataPrefix: cur2DataPrefix(exp.prefix, exp.name, month),
      rootPrefix,
    };
  }
  return {
    manifestKey: legacyManifestKey(exp.prefix, exp.name, month),
    manifestPrefix: legacyPeriodPrefix(exp.prefix, exp.name, month),
    dataPrefix: exp.format === 'parquet' ? legacyParquetPrefix(exp.prefix, exp.name, month) : legacyPeriodPrefix(exp.prefix, exp.name, month),
    rootPrefix,
  };
}

// ── files ──

export type DataFileKind = 'parquet' | 'csv';

/** What a key is, judged by its extension; null for anything that is not report data (manifests, SQL, zip...). */
export function dataFileKind(key: string): DataFileKind | null {
  const k = key.toLowerCase();
  if (k.endsWith('.parquet')) return 'parquet';
  if (k.endsWith('.csv.gz') || k.endsWith('.csv')) return 'csv';
  return null;
}

export const isManifestKey = (key: string): boolean => /-manifest\.json$/i.test(key);

export const parentDir = (key: string): string => {
  const i = key.lastIndexOf('/');
  return i < 0 ? '' : key.slice(0, i + 1);
};

/** 's3://bucket/a/b' -> 'a/b'; plain keys lose a leading slash. */
export function toKey(ref: string, _bucket?: string): string {
  const m = /^s3:\/\/([^/]+)\/(.*)$/i.exec(ref.trim());
  if (m) return m[2];
  return ref.trim().replace(/^\/+/, '');
}

export interface Manifest {
  /** data file keys, in manifest order */
  files: string[];
  /** assemblyId (legacy) or executionId (CUR 2.0): changes whenever the month is re-delivered */
  id?: string;
}

/**
 * Read the data file list out of a manifest. Legacy manifests carry `reportKeys` (+ `assemblyId`);
 * CUR 2.0 manifests carry `dataFiles` (s3:// URIs, + `executionId`). Unknown shapes yield no files,
 * in which case the importer lists the data prefix instead.
 */
export function parseManifest(json: unknown, bucket?: string): Manifest {
  const o = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const raw = [o.dataFiles, o.reportKeys, o.DataFiles, o.files].find((x) => Array.isArray(x) && x.length > 0) as unknown[] | undefined;
  const files: string[] = [];
  for (const item of raw ?? []) {
    let ref: unknown = item;
    if (item && typeof item === 'object') {
      const r = item as Record<string, unknown>;
      ref = r.key ?? r.Key ?? r.path ?? r.uri ?? r.url;
    }
    if (typeof ref !== 'string' || !ref.trim()) continue;
    const key = toKey(ref, bucket);
    if (dataFileKind(key)) files.push(key);
  }
  const id = [o.assemblyId, o.executionId, o.ExecutionId, o.reportId].find((x) => typeof x === 'string' && x) as string | undefined;
  return { files: [...new Set(files)], ...(id ? { id } : {}) };
}
