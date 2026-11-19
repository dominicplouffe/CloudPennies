// Finding one billing month's data files in the export's S3 bucket.
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GetObjectCommand, ListObjectsV2Command, type S3Client } from '@aws-sdk/client-s3';
import type { CurExport } from '../../../src/core/types';
import { classifyError, errMessage, errName, isAccessDenied } from '../errors';
import { dataFileKind, isManifestKey, legacyPeriod, monthLocations, parentDir, parseManifest, type DataFileKind } from './paths';

/** A failure with a message fit for the user, and the IAM action that would fix it when it is a permission problem. */
export class CurError extends Error {
  constructor(
    message: string,
    readonly missingPermission?: string,
  ) {
    super(message);
    this.name = 'CurError';
  }
}

export interface S3Object {
  key: string;
  size?: number;
  etag?: string;
  lastModified?: number;
}

export interface MonthFile extends S3Object {
  kind: DataFileKind;
}

export interface LocatedMonth {
  files: MonthFile[];
  /** assemblyId / executionId from the manifest, when one was read */
  manifestId?: string;
  /** how the files were found (for diagnostics) */
  via: 'manifest' | 'listing' | 'discovery';
}

const isNotFound = (e: unknown): boolean => {
  const status = (e as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
  return /NoSuchKey|NotFound/i.test(errName(e)) || status === 404;
};
const isNoBucket = (e: unknown): boolean => /NoSuchBucket/i.test(errName(e));

/** Turn an S3 failure into a CurError that says what was being done. */
export function s3Error(e: unknown, bucket: string, action: 's3:GetObject' | 's3:ListBucket'): CurError {
  if (e instanceof CurError) return e;
  if (isNoBucket(e)) return new CurError(`The S3 bucket "${bucket}" that the export delivers to does not exist.`);
  if (isAccessDenied(e)) {
    return new CurError(
      action === 's3:GetObject'
        ? `CloudPennies is not allowed to read the report files in the S3 bucket "${bucket}" (s3:GetObject).`
        : `CloudPennies is not allowed to list the report files in the S3 bucket "${bucket}" (s3:ListBucket).`,
      action,
    );
  }
  const w = classifyError('cost-and-usage-report', e, action);
  return new CurError(`Could not read the S3 bucket "${bucket}": ${w.message}`, w.missingPermission);
}

async function bodyToBuffer(body: unknown, limit: number): Promise<Buffer> {
  if (body === undefined || body === null) return Buffer.alloc(0);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : Buffer.from(chunk);
    size += b.length;
    if (size > limit) throw new Error('The file is larger than expected.');
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

const MANIFEST_LIMIT = 32 * 1024 * 1024;

/** GetObject as parsed JSON; null when the key does not exist. Throws the raw SDK error otherwise. */
async function getJson(s3: S3Client, bucket: string, key: string): Promise<unknown | null> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const text = (await bodyToBuffer(r.Body, MANIFEST_LIMIT)).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** ListObjectsV2 under a prefix, up to `max` keys. */
export async function listPrefix(s3: S3Client, bucket: string, prefix: string, max: number): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let ContinuationToken: string | undefined;
  try {
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: Math.min(1000, max - out.length), ContinuationToken }));
      for (const o of r.Contents ?? []) {
        if (!o.Key) continue;
        out.push({ key: o.Key, size: o.Size, etag: o.ETag, lastModified: o.LastModified instanceof Date ? o.LastModified.getTime() : undefined });
      }
      ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
    } while (ContinuationToken && out.length < max);
  } catch (e) {
    throw s3Error(e, bucket, 's3:ListBucket');
  }
  return out;
}

/** Download an object to a local file without buffering it in memory. */
export async function downloadObject(s3: S3Client, bucket: string, key: string, file: string): Promise<void> {
  try {
    const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = r.Body as unknown;
    if (body === undefined || body === null) throw new Error(`S3 returned no data for ${key}`);
    const source = body instanceof Readable ? body : Readable.from(body instanceof Uint8Array || typeof body === 'string' ? [body] : (body as AsyncIterable<Uint8Array>));
    await pipeline(source, createWriteStream(file, { mode: 0o600 }));
  } catch (e) {
    throw s3Error(e, bucket, 's3:GetObject');
  }
}

/**
 * Data files among `objects`. When they sit in several directories (one per delivery when the export
 * keeps old versions), only the directory with the most recent file is used.
 */
export function newestDataFiles(objects: readonly S3Object[]): MonthFile[] {
  const byDir = new Map<string, MonthFile[]>();
  for (const o of objects) {
    const kind = dataFileKind(o.key);
    if (!kind) continue;
    const dir = parentDir(o.key);
    const list = byDir.get(dir);
    if (list) list.push({ ...o, kind });
    else byDir.set(dir, [{ ...o, kind }]);
  }
  let best: MonthFile[] = [];
  let bestTime = -Infinity;
  for (const [dir, list] of [...byDir].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const t = Math.max(...list.map((f) => f.lastModified ?? 0));
    if (t >= bestTime) {
      bestTime = t;
      best = list;
    }
    void dir;
  }
  return best.sort((a, b) => (a.key < b.key ? -1 : 1));
}

/** Keys under the export root that belong to `month` in any of the known layouts. */
export function keysOfMonth(objects: readonly S3Object[], month: string): S3Object[] {
  const [y, m] = month.split('-');
  const markers = [`/BILLING_PERIOD=${month}/`, `/${legacyPeriod(month)}/`, `/year=${y}/month=${Number(m)}/`, `/year=${y}/month=${m}/`];
  return objects.filter((o) => markers.some((mk) => `/${o.key}`.includes(mk)));
}

const LIST_CAP = 2000;
/** how many keys of the export root are listed to work out an unexpected layout */
export const DISCOVERY_CAP = 500;

/** Sizes and ETags come from listing the directories the manifest points into. */
async function describeFiles(s3: S3Client, bucket: string, keys: string[]): Promise<MonthFile[]> {
  const dirs = [...new Set(keys.map(parentDir))];
  const seen = new Map<string, S3Object>();
  for (const dir of dirs.slice(0, 20)) for (const o of await listPrefix(s3, bucket, dir, LIST_CAP)) seen.set(o.key, o);
  return keys.map((key) => ({ ...(seen.get(key) ?? { key }), kind: dataFileKind(key) as DataFileKind }));
}

/**
 * Locate the data files of one month: the manifest where the layout says it is, else any manifest of
 * that month, else the data files themselves, else whatever under the export root carries the month in
 * its path. null when the bucket has nothing for the month (e.g. it predates the export).
 */
export async function locateMonth(s3: S3Client, exp: CurExport, month: string): Promise<LocatedMonth | null> {
  const loc = monthLocations(exp, month);
  const bucket = exp.bucket;

  // 1. the manifest at its documented place
  let manifestDenied = false;
  let manifest: ReturnType<typeof parseManifest> | null = null;
  try {
    const json = await getJson(s3, bucket, loc.manifestKey);
    if (json) manifest = parseManifest(json, bucket);
  } catch (e) {
    // Without s3:ListBucket, S3 answers "access denied" for a key that does not exist; listing tells the two apart.
    if (isNoBucket(e) || !isAccessDenied(e)) throw s3Error(e, bucket, 's3:GetObject');
    manifestDenied = true;
  }

  // 2. another manifest for the month (one per delivery when old versions are kept)
  let listed: S3Object[] | null = null;
  if (!manifest?.files.length) {
    listed = await listPrefix(s3, bucket, loc.manifestPrefix, LIST_CAP);
    if (manifestDenied && listed.some((o) => o.key === loc.manifestKey)) throw s3Error(Object.assign(new Error('Access Denied'), { name: 'AccessDenied' }), bucket, 's3:GetObject');
    const manifests = listed.filter((o) => isManifestKey(o.key) && o.key !== loc.manifestKey).sort((a, b) => (b.lastModified ?? 0) - (a.lastModified ?? 0) || (a.key < b.key ? 1 : -1));
    for (const m of manifests.slice(0, 3)) {
      try {
        const json = await getJson(s3, bucket, m.key);
        if (json) manifest = parseManifest(json, bucket);
      } catch (e) {
        throw s3Error(e, bucket, 's3:GetObject');
      }
      if (manifest?.files.length) break;
    }
  }
  if (manifest?.files.length) {
    return { files: await describeFiles(s3, bucket, manifest.files), ...(manifest.id ? { manifestId: manifest.id } : {}), via: 'manifest' };
  }

  // 3. the data files where the layout puts them
  const dataObjects = loc.dataPrefix === loc.manifestPrefix && listed ? listed : await listPrefix(s3, bucket, loc.dataPrefix, LIST_CAP);
  const files = newestDataFiles(dataObjects);
  if (files.length) return { files, via: 'listing' };

  // 4. anything under the export root that names the month
  const root = await listPrefix(s3, bucket, loc.rootPrefix, DISCOVERY_CAP);
  const found = newestDataFiles(keysOfMonth(root, month));
  return found.length ? { files: found, via: 'discovery' } : null;
}

/** Where the importer looked, for the error shown when no month could be found. */
export async function describeMissing(s3: S3Client, exp: CurExport, months: string[]): Promise<string> {
  const loc = monthLocations(exp, months[months.length - 1]);
  let sample = '';
  try {
    const root = await listPrefix(s3, exp.bucket, loc.rootPrefix, DISCOVERY_CAP);
    sample = root.length
      ? ` That location holds other files (for example ${root
          .slice(0, 3)
          .map((o) => o.key)
          .join(', ')}); please report this layout so CloudPennies can learn to read it.`
      : ' That location is empty: a new export delivers its first files within 24 hours.';
  } catch (e) {
    sample = ` (${errMessage(e)})`;
  }
  return `No report files were found for ${months.join(', ')} in s3://${exp.bucket}/${loc.rootPrefix} (expected ${loc.manifestKey}).${sample}`;
}
