// Local store of imported report months: one gzip JSON file per month + a small index, and the
// query engine that answers CostQuery from them.
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';
import type { CostBasis, CostQuery, CostResult, CostRow, CurMonth, Dim } from '../../../src/core/types';
import { isMonthData, monthTotal, type MonthData, type StoredDim } from './aggregate';
import { shiftMonth } from './paths';
import { knownServicesFromJson, knownServicesToJson, resolveService, type KnownServices } from './services';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export interface IndexedMonth extends CurMonth {
  /** identifies the source files this month was built from (see fingerprintOf) */
  fingerprint: string;
  basis: CostBasis;
  /** last day with data, YYYY-MM-DD */
  dataThrough: string;
}

export interface CurIndex {
  v: 1;
  exportId: string;
  exportName: string;
  months: IndexedMonth[];
  updatedAt: string;
}

/** Which export the account's queries are answered from. */
export interface CurPointer {
  exportId: string;
  exportName: string;
  dir: string;
}

const safe = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, '_');

export const exportIdHash = (exportId: string): string => createHash('sha256').update(exportId).digest('hex').slice(0, 16);

/** `<cache dir>/cur/<account id>` */
export const curAccountDir = (cacheDir: string, accountId: string): string => path.join(cacheDir, 'cur', safe(accountId));
/** `<cache dir>/cur/<account id>/<export id hash>` */
export const curStoreDir = (cacheDir: string, accountId: string, exportId: string): string => path.join(curAccountDir(cacheDir, accountId), exportIdHash(exportId));

let tmpCounter = 0;

/** Write-then-rename, so a crash never leaves a half-written file behind under the real name. */
export async function writeAtomic(file: string, content: string | Buffer): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${++tmpCounter}.tmp`;
  try {
    await fs.writeFile(tmp, content, { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function readPointer(cacheDir: string, accountId: string): Promise<CurPointer | null> {
  const p = await readJson<CurPointer>(path.join(curAccountDir(cacheDir, accountId), 'current.json'));
  return p && typeof p.exportId === 'string' && typeof p.dir === 'string' && /^[a-f0-9]{16}$/.test(p.dir) ? p : null;
}

export async function writePointer(cacheDir: string, accountId: string, exportId: string, exportName: string): Promise<void> {
  const pointer: CurPointer = { exportId, exportName, dir: exportIdHash(exportId) };
  await writeAtomic(path.join(curAccountDir(cacheDir, accountId), 'current.json'), JSON.stringify(pointer));
}

/** Hash of what a month was built from: the manifest id (when there is one) and every file's key, ETag and size. */
export function fingerprintOf(files: { key: string; etag?: string; size?: number }[], manifestId?: string): string {
  const h = createHash('sha256');
  h.update(manifestId ?? '');
  for (const f of [...files].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) h.update(`\n${f.key}\t${f.etag ?? ''}\t${f.size ?? ''}`);
  return h.digest('hex').slice(0, 32);
}

const STORE_DIMS: Partial<Record<Dim, StoredDim | 'service'>> = {
  SERVICE: 'service',
  USAGE_TYPE: 'usageType',
  REGION: 'region',
  LINKED_ACCOUNT: 'account',
  OPERATION: 'operation',
  RESOURCE_ID: 'resource',
};

/** true when every dimension the query groups by or filters on exists in the store */
export function storeSupports(q: Pick<CostQuery, 'groupBy' | 'filters'>): boolean {
  const dims = [...q.groupBy, ...(Object.keys(q.filters ?? {}) as Dim[]).filter((d) => (q.filters?.[d]?.length ?? 0) > 0)];
  return dims.every((d) => STORE_DIMS[d] !== undefined);
}

const LRU_SIZE = 3;

export class CurStore {
  /** month -> decoded data, most recently used last */
  private readonly loaded = new Map<string, { ingestedAt: string; data: MonthData }>();
  private services: { mtimeMs: number; known: KnownServices } | null = null;

  constructor(readonly dir: string) {}

  private monthFile(month: string): string {
    return path.join(this.dir, `${safe(month)}.json.gz`);
  }

  async readIndex(): Promise<CurIndex | null> {
    const idx = await readJson<CurIndex>(path.join(this.dir, 'index.json'));
    if (!idx || idx.v !== 1 || !Array.isArray(idx.months)) return null;
    idx.months = idx.months
      .filter((m) => m && typeof m.month === 'string' && /^\d{4}-\d{2}$/.test(m.month) && typeof m.fingerprint === 'string')
      .sort((a, b) => (a.month < b.month ? -1 : 1));
    return idx;
  }

  private async writeIndex(idx: CurIndex): Promise<void> {
    idx.months.sort((a, b) => (a.month < b.month ? -1 : 1));
    await writeAtomic(path.join(this.dir, 'index.json'), JSON.stringify(idx));
  }

  /** The imported months as shown to the user. */
  async months(): Promise<CurMonth[]> {
    const idx = await this.readIndex();
    return (idx?.months ?? []).map(({ month, rows, cost, ingestedAt, complete }) => ({ month, rows, cost, ingestedAt, complete }));
  }

  /** false when the month is already stored from the same source files in the same cost basis */
  async needsImport(month: string, fingerprint: string, basis: CostBasis): Promise<boolean> {
    const m = (await this.readIndex())?.months.find((x) => x.month === month);
    if (!m || m.fingerprint !== fingerprint || m.basis !== basis) return true;
    try {
      await fs.access(this.monthFile(month));
      return false;
    } catch {
      return true;
    }
  }

  /** Store a month (data file first, then the index), replacing any earlier version. */
  async writeMonth(
    data: MonthData,
    meta: { exportId: string; exportName: string; fingerprint: string; complete: boolean; now: Date },
  ): Promise<IndexedMonth> {
    await writeAtomic(this.monthFile(data.month), await gzipAsync(Buffer.from(JSON.stringify(data), 'utf8')));
    const lastDay = data.day.reduce((a, d) => (d > a ? d : a), 1);
    const entry: IndexedMonth = {
      month: data.month,
      rows: data.day.length,
      cost: monthTotal(data),
      ingestedAt: meta.now.toISOString(),
      complete: meta.complete,
      fingerprint: meta.fingerprint,
      basis: data.basis,
      dataThrough: `${data.month}-${String(lastDay).padStart(2, '0')}`,
    };
    const idx = (await this.readIndex()) ?? { v: 1 as const, exportId: meta.exportId, exportName: meta.exportName, months: [], updatedAt: '' };
    idx.exportId = meta.exportId;
    idx.exportName = meta.exportName;
    idx.months = [...idx.months.filter((m) => m.month !== data.month), entry];
    idx.updatedAt = meta.now.toISOString();
    await this.writeIndex(idx);
    this.loaded.delete(data.month);
    return entry;
  }

  /** Mark stored months as complete/in progress without re-importing them. */
  async setComplete(isComplete: (month: string) => boolean): Promise<void> {
    const idx = await this.readIndex();
    if (!idx) return;
    let changed = false;
    for (const m of idx.months) {
      const c = isComplete(m.month);
      if (m.complete !== c) {
        m.complete = c;
        changed = true;
      }
    }
    if (changed) await this.writeIndex(idx);
  }

  /** Drop every month that is not in `keep` (retention). Returns the months removed. */
  async prune(keep: readonly string[]): Promise<string[]> {
    const idx = await this.readIndex();
    if (!idx) return [];
    const wanted = new Set(keep);
    const gone = idx.months.filter((m) => !wanted.has(m.month)).map((m) => m.month);
    if (!gone.length) return [];
    idx.months = idx.months.filter((m) => wanted.has(m.month));
    await this.writeIndex(idx);
    for (const month of gone) {
      this.loaded.delete(month);
      await fs.rm(this.monthFile(month), { force: true }).catch(() => undefined);
    }
    return gone;
  }

  async loadMonth(entry: Pick<IndexedMonth, 'month' | 'ingestedAt'>): Promise<MonthData | null> {
    const hit = this.loaded.get(entry.month);
    if (hit && hit.ingestedAt === entry.ingestedAt) {
      this.loaded.delete(entry.month);
      this.loaded.set(entry.month, hit);
      return hit.data;
    }
    let data: unknown;
    try {
      data = JSON.parse((await gunzipAsync(await fs.readFile(this.monthFile(entry.month)))).toString('utf8'));
    } catch {
      return null;
    }
    if (!isMonthData(data) || data.month !== entry.month) return null;
    this.loaded.delete(entry.month);
    this.loaded.set(entry.month, { ingestedAt: entry.ingestedAt, data });
    while (this.loaded.size > LRU_SIZE) this.loaded.delete(this.loaded.keys().next().value as string);
    return data;
  }

  // ── usage type -> Cost Explorer service map ──

  private servicesFile(): string {
    return path.join(this.dir, 'services.json');
  }

  async saveServices(known: KnownServices): Promise<void> {
    await writeAtomic(this.servicesFile(), JSON.stringify(knownServicesToJson(known)));
    this.services = null;
  }

  async loadServices(): Promise<KnownServices> {
    try {
      const st = await fs.stat(this.servicesFile());
      if (this.services && this.services.mtimeMs === st.mtimeMs) return this.services.known;
      const known = knownServicesFromJson(await readJson<unknown>(this.servicesFile()));
      this.services = { mtimeMs: st.mtimeMs, known };
      return known;
    } catch {
      return new Map();
    }
  }

  // ── queries ──

  /**
   * Answer a query from the imported months, or null when the store cannot:
   *  - the query touches a dimension the report data does not carry here (tags, purchase type, ...);
   *  - no month has been imported in this cost basis;
   *  - none of the requested period is covered.
   * A period that starts before the first imported month (or ends after the last one) is answered
   * for the covered part only.
   */
  async query(q: CostQuery, basis?: CostBasis): Promise<CostResult | null> {
    if (!storeSupports(q)) return null;
    const idx = await this.readIndex();
    const months = (idx?.months ?? []).filter((m) => !basis || m.basis === basis);
    if (!months.length) return null;
    const first = `${months[0].month}-01`;
    const last = months[months.length - 1];
    const coveredEnd = `${shiftMonth(last.month, 1)}-01`;
    const start = q.start > first ? q.start : first;
    const end = q.end < coveredEnd ? q.end : coveredEnd;
    if (!(start < end)) return null;
    // the newest month is usually still filling up: a period entirely after its last day of data is not covered
    if (start > last.dataThrough && start.slice(0, 7) === last.month) return null;

    const known = await this.loadServices();
    const monthly = q.granularity === 'MONTHLY';
    const out = new Map<string, CostRow>();
    const lastMonth = end.slice(8, 10) === '01' ? shiftMonth(end.slice(0, 7), -1) : end.slice(0, 7);

    for (const entry of months) {
      if (entry.month < start.slice(0, 7) || entry.month > lastMonth) continue;
      const data = await this.loadMonth(entry);
      if (!data) continue;
      const fromDay = start.slice(0, 7) === entry.month ? Number(start.slice(8, 10)) : 1;
      const toDay = end.slice(0, 7) === entry.month ? Number(end.slice(8, 10)) : 32; // exclusive

      // service per (product, usage type), resolved lazily
      const nUsage = data.dict.usageType.length;
      const serviceCache = new Map<number, string>();
      const serviceAt = (i: number): string => {
        const p = data.cols.product[i];
        const u = data.cols.usageType[i];
        const k = p * nUsage + u;
        let s = serviceCache.get(k);
        if (s === undefined) {
          const code = data.dict.product[p];
          s = resolveService(code, data.productNames[code] ?? '', data.dict.usageType[u], known);
          serviceCache.set(k, s);
        }
        return s;
      };
      const valueAt = (dim: Dim, i: number): string => {
        const d = STORE_DIMS[dim] as StoredDim | 'service';
        return d === 'service' ? serviceAt(i) : data.dict[d][data.cols[d][i]];
      };

      const filters = (Object.entries(q.filters ?? {}) as [Dim, string[] | undefined][])
        .filter(([, v]) => v && v.length)
        .map(([dim, v]) => {
          const d = STORE_DIMS[dim] as StoredDim | 'service';
          const wanted = new Set(v);
          if (d === 'service') return (i: number) => wanted.has(serviceAt(i));
          const ok = data.dict[d].map((x) => wanted.has(x));
          const col = data.cols[d];
          return (i: number) => ok[col[i]];
        });

      const n = data.day.length;
      rows: for (let i = 0; i < n; i++) {
        const day = data.day[i];
        if (day < fromDay || day >= toDay) continue;
        for (const f of filters) if (!f(i)) continue rows;
        const keys = q.groupBy.map((dim) => valueAt(dim, i));
        const date = monthly ? `${entry.month}-01` : `${entry.month}-${String(day).padStart(2, '0')}`;
        const k = `${date}\u0001${keys.join('\u0001')}`;
        const cur = out.get(k);
        if (cur) {
          cur.cost += data.cost[i];
          cur.usage = (cur.usage ?? 0) + data.usage[i];
        } else out.set(k, { keys, date, cost: data.cost[i], usage: data.usage[i] });
      }
    }
    const rows = [...out.values()].filter((r) => r.cost !== 0 || (r.usage ?? 0) !== 0);
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.cost - a.cost));
    return { rows };
  }
}

const stores = new Map<string, CurStore>();

/** One CurStore per directory for the life of the process, so its month cache survives across queries. */
export function openCurStore(dir: string): CurStore {
  let s = stores.get(dir);
  if (!s) stores.set(dir, (s = new CurStore(dir)));
  return s;
}

/** The store queries should use for an account (the export imported most recently), or null. */
export async function currentCurStore(cacheDir: string, accountId: string): Promise<{ store: CurStore; pointer: CurPointer } | null> {
  const pointer = await readPointer(cacheDir, accountId);
  if (!pointer) return null;
  return { store: openCurStore(path.join(curAccountDir(cacheDir, accountId), pointer.dir)), pointer };
}
