// Orchestration: pick an export, bring the local store up to date month by month, report status.
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { S3Client } from '@aws-sdk/client-s3';
import type { CostBasis, CurExport, CurMonth, CurStatus, Settings } from '../../../src/core/types';
import { errMessage } from '../errors';
import type { Creds } from '../resources';
import { encodeMonth, foldResources, MonthAggregator } from './aggregate';
import { listCurExports, pickExport, type ExportListing } from './exports';
import { CurError, describeMissing, downloadObject, locateMonth, type LocatedMonth } from './locate';
import { monthsToImport } from './paths';
import { readDataFile } from './reader';
import { mergeKnownServices, type KnownServices } from './services';
import { curAccountDir, curStoreDir, fingerprintOf, openCurStore, readPointer, writeAtomic, writePointer } from './store';

/** A month whose data files add up to more than this (compressed) is skipped rather than downloaded. */
export const MAX_MONTH_BYTES = 3 * 1024 ** 3;

export const NO_EXPORT_MESSAGE =
  'No Cost and Usage Report export was found on this account, so resource-level cost history is limited to the 14 days Cost Explorer keeps. ' +
  'To get full history, create a Data Export (CUR 2.0) with resource IDs in Billing and Cost Management → Data Exports; docs/CUR.md has the steps.';

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (month: string): string => MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;

export interface CurProblem {
  message: string;
  missingPermission?: string;
  /** true when nothing is wrong, the account simply has no export yet */
  info?: boolean;
}

export interface CurImportOptions {
  credentials: Creds;
  accountId: string;
  cacheDir: string;
  settings: Pick<Settings, 'costBasis' | 'curExportId' | 'curMonths'>;
  now?: () => Date;
  /** progress text, e.g. "Importing the Cost and Usage Report (November)" */
  onStep?: (step: string) => void;
  /** usage type -> Cost Explorer services from the scan in progress; persisted for later queries */
  known?: KnownServices;
  /** directory for downloads (default: the OS temp dir) */
  tmpRoot?: string;
  /** override of MAX_MONTH_BYTES (tests) */
  maxMonthBytes?: number;
}

export interface CurImportResult {
  exports: CurExport[];
  selected: CurExport | null;
  /** everything stored locally after this run */
  months: CurMonth[];
  /** months (re)imported by this run */
  imported: string[];
  /** at most one problem to show; absent when everything worked */
  problem?: CurProblem;
}

interface ListingCache {
  savedAt: string;
  exports: CurExport[];
  error?: ExportListing['error'];
}

const listingFile = (cacheDir: string, accountId: string) => path.join(curAccountDir(cacheDir, accountId), 'exports.json');
const lastImportFile = (cacheDir: string, accountId: string) => path.join(curAccountDir(cacheDir, accountId), 'last-import.json');

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function saveQuietly(file: string, value: unknown): Promise<void> {
  try {
    await writeAtomic(file, JSON.stringify(value));
  } catch {
    /* a status file that cannot be written is not worth failing for */
  }
}

async function refreshListing(credentials: Creds, cacheDir: string, accountId: string, now: Date): Promise<ExportListing> {
  const listing = await listCurExports(credentials);
  await saveQuietly(listingFile(cacheDir, accountId), { savedAt: now.toISOString(), exports: listing.exports, ...(listing.error ? { error: listing.error } : {}) } satisfies ListingCache);
  return listing;
}

function unusableMessage(exports: CurExport[]): string {
  const first = exports[0];
  return exports.length === 1
    ? `The Cost and Usage Report export "${first.name}" cannot be used. ${first.reason ?? ''} See docs/CUR.md.`.replace(/\s+/g, ' ')
    : `None of the ${exports.length} Cost and Usage Report exports on this account can be used (for example "${first.name}": ${first.reason ?? 'unsupported'}). See docs/CUR.md.`;
}

/** Download, read and aggregate every file of a month. Temp files are removed whatever happens. */
async function buildMonth(
  s3: S3Client,
  exp: CurExport,
  month: string,
  located: LocatedMonth,
  basis: CostBasis,
  tmpDir: string,
): Promise<MonthAggregator> {
  const agg = new MonthAggregator(month);
  let n = 0;
  for (const f of located.files) {
    const tmp = path.join(tmpDir, `${month}-${++n}.${f.kind === 'parquet' ? 'parquet' : 'csv.gz'}`);
    try {
      await downloadObject(s3, exp.bucket, f.key, tmp);
      await readDataFile(f.kind, tmp, basis, (item) => agg.add(item), f.key);
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined);
    }
  }
  return agg;
}

/**
 * Bring the local store up to date. Never throws: whatever goes wrong ends up in `problem`
 * (one message, with the missing IAM action when it is a permission problem).
 */
export async function importCur(opts: CurImportOptions): Promise<CurImportResult> {
  const now = opts.now ?? (() => new Date());
  const { credentials, accountId, cacheDir, settings } = opts;
  const step = (s: string) => {
    try {
      opts.onStep?.(s);
    } catch {
      /* a broken listener must not break the import */
    }
  };
  const result: CurImportResult = { exports: [], selected: null, months: [], imported: [] };
  const finish = async (problem?: CurProblem): Promise<CurImportResult> => {
    if (problem) result.problem = problem;
    await saveQuietly(lastImportFile(cacheDir, accountId), { at: now().toISOString(), ...(result.problem && !result.problem.info ? { problem: result.problem } : {}) });
    return result;
  };

  let s3: S3Client | null = null;
  let tmpDir: string | null = null;
  try {
    step('Looking for a Cost and Usage Report');
    const listing = await refreshListing(credentials, cacheDir, accountId, now());
    result.exports = listing.exports;
    const exp = pickExport(listing.exports, settings.curExportId);
    result.selected = exp;
    if (!exp) {
      if (listing.error) return await finish(listing.error);
      if (!listing.exports.length) return await finish({ message: NO_EXPORT_MESSAGE, info: true });
      return await finish({ message: unusableMessage(listing.exports) });
    }

    const store = openCurStore(curStoreDir(cacheDir, accountId, exp.id));
    const today = now().toISOString().slice(0, 10);
    const currentMonth = today.slice(0, 7);
    const months = monthsToImport(today, settings.curMonths);
    const basis = settings.costBasis;
    // followRegionRedirects: the region recorded on the export is normally right, but a bucket can live anywhere
    s3 = new S3Client({ region: exp.region || 'us-east-1', credentials, maxAttempts: 4, followRegionRedirects: true });
    tmpDir = await fs.mkdtemp(path.join(opts.tmpRoot ?? os.tmpdir(), 'cloudpennies-cur-'));

    const notes: string[] = [];
    let fatal: CurError | null = null;
    let found = 0;
    // newest first: if something stops the import half way, the most useful months are already there
    for (const month of [...months].reverse()) {
      step(`Importing the Cost and Usage Report (${monthName(month)})`);
      try {
        const located = await locateMonth(s3, exp, month);
        if (!located) continue;
        found++;
        const bytes = located.files.reduce((a, f) => a + (f.size ?? 0), 0);
        if (bytes > (opts.maxMonthBytes ?? MAX_MONTH_BYTES)) {
          notes.push(`${monthName(month)} was skipped because its report files are very large (${(bytes / 1024 ** 3).toFixed(1)} GB compressed).`);
          continue;
        }
        const fingerprint = fingerprintOf(located.files, located.manifestId);
        if (!(await store.needsImport(month, fingerprint, basis))) continue;
        const agg = await buildMonth(s3, exp, month, located, basis, tmpDir);
        const data = encodeMonth(month, basis, foldResources(agg.rows()), agg.productNames());
        await store.writeMonth(data, { exportId: exp.id, exportName: exp.name, fingerprint, complete: month < currentMonth, now: now() });
        result.imported.push(month);
      } catch (e) {
        if (e instanceof CurError && (e.missingPermission || /does not exist/.test(e.message))) {
          fatal = e; // the same failure would repeat for every other month
          break;
        }
        notes.push(`${monthName(month)} could not be imported: ${e instanceof CurError ? e.message : errMessage(e)}`);
      }
    }

    await store.prune(months);
    await store.setComplete((m) => m < currentMonth);
    if (opts.known?.size) await store.saveServices(mergeKnownServices(await store.loadServices(), opts.known)).catch(() => undefined);
    result.months = await store.months();
    if (result.months.length) await writePointer(cacheDir, accountId, exp.id, exp.name);

    if (fatal) return await finish({ message: fatal.message, ...(fatal.missingPermission ? { missingPermission: fatal.missingPermission } : {}) });
    if (!found && !notes.length) {
      let message: string;
      try {
        message = await describeMissing(s3, exp, months);
      } catch (e) {
        message = errMessage(e);
      }
      return await finish({ message });
    }
    const parts = [...notes];
    if (listing.error) parts.push(listing.error.message);
    if (parts.length) return await finish({ message: parts.join(' '), ...(listing.error?.missingPermission ? { missingPermission: listing.error.missingPermission } : {}) });
    return await finish();
  } catch (e) {
    const err = e instanceof CurError ? e : new CurError(`The Cost and Usage Report could not be imported: ${errMessage(e)}`);
    return await finish({ message: err.message, ...(err.missingPermission ? { missingPermission: err.missingPermission } : {}) });
  } finally {
    s3?.destroy();
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface CurStatusOptions {
  credentials: Creds;
  accountId: string;
  cacheDir: string;
  settings: Pick<Settings, 'curExportId'>;
  /** list the exports again instead of using the cached listing */
  refresh?: boolean;
  now?: () => Date;
}

export const EMPTY_CUR_STATUS: CurStatus = { exports: [], selected: null, months: [] };

/** Bridge.getCurStatus. Never throws; failures are reported in `lastError`. */
export async function curStatus(opts: CurStatusOptions): Promise<CurStatus> {
  const { cacheDir, accountId } = opts;
  try {
    let listing: ExportListing | null = null;
    if (!opts.refresh) {
      const cached = await readJson<ListingCache>(listingFile(cacheDir, accountId));
      if (cached && Array.isArray(cached.exports)) listing = { exports: cached.exports, ...(cached.error ? { error: cached.error } : {}) };
    }
    listing ??= await refreshListing(opts.credentials, cacheDir, accountId, (opts.now ?? (() => new Date()))());
    const selected = pickExport(listing.exports, opts.settings.curExportId);
    let months: CurMonth[] = [];
    if (selected) months = await openCurStore(curStoreDir(cacheDir, accountId, selected.id)).months();
    const last = await readJson<{ problem?: CurProblem }>(lastImportFile(cacheDir, accountId));
    const problem = listing.error ?? last?.problem;
    return {
      exports: listing.exports,
      selected: selected?.id ?? null,
      months,
      ...(problem?.message ? { lastError: problem.message } : {}),
      ...(problem?.missingPermission ? { missingPermission: problem.missingPermission } : {}),
    };
  } catch (e) {
    return { ...EMPTY_CUR_STATUS, lastError: errMessage(e) };
  }
}

/** CurImportResult -> CurStatus (what Bridge.importCur returns). */
export function statusOf(r: CurImportResult): CurStatus {
  return {
    exports: r.exports,
    selected: r.selected?.id ?? null,
    months: r.months,
    ...(r.problem && !r.problem.info ? { lastError: r.problem.message } : {}),
    ...(r.problem?.missingPermission ? { missingPermission: r.problem.missingPermission } : {}),
  };
}

export { readPointer };
