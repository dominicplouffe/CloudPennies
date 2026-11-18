// Tiny JSON-on-disk cache. All failures are swallowed: the cache is an optimisation, never a requirement.
import { promises as fs } from 'node:fs';
import path from 'node:path';

interface Entry<T> {
  savedAt: number;
  value: T;
}

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, '_');

export async function readCache<T>(dir: string, name: string): Promise<Entry<T> | null> {
  try {
    const raw = await fs.readFile(path.join(dir, safeName(name) + '.json'), 'utf8');
    const e = JSON.parse(raw) as Entry<T>;
    return typeof e?.savedAt === 'number' && 'value' in e ? e : null;
  } catch {
    return null;
  }
}

export async function writeCache<T>(dir: string, name: string, value: T, now = Date.now()): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, safeName(name) + '.json');
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ savedAt: now, value } satisfies Entry<T>), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch {
    /* ignore */
  }
}

/** Remove query-cache entries older than maxAgeMs (snapshots are kept). */
export async function pruneCache(dir: string, maxAgeMs: number, now = Date.now()): Promise<void> {
  try {
    for (const f of await fs.readdir(dir)) {
      if (!f.startsWith('q-') || !f.endsWith('.json')) continue;
      const p = path.join(dir, f);
      const st = await fs.stat(p);
      if (now - st.mtimeMs > maxAgeMs) await fs.unlink(p);
    }
  } catch {
    /* ignore */
  }
}

export const snapshotFile = (dir: string, accountId: string) => path.join(dir, `snapshot-${safeName(accountId)}.json`);

export async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export async function writeJsonFile(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(value), { mode: 0o600 });
  await fs.rename(tmp, file);
}
