// Per-account scan history on disk (one small JSON file per account). Lives in its own
// directory so neither the cache prune nor disconnect() removes it. No Electron imports.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { HistoryEntry } from '../src/core/types';
import { appendHistory } from '../src/core/history';

/** Account ids are 12 digits; anything else is reduced to a safe file name. */
export function historyFile(dir: string, accountId: string): string {
  const safe = String(accountId).replace(/[^A-Za-z0-9_-]/g, '') || 'unknown';
  return path.join(dir, `history-${safe}.json`);
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function isEntry(v: unknown): v is HistoryEntry {
  if (!isRecord(v)) return false;
  return (
    typeof v.at === 'string' &&
    typeof v.today === 'string' &&
    typeof v.last30 === 'number' &&
    typeof v.mtd === 'number' &&
    typeof v.projected === 'number' &&
    isRecord(v.insights) &&
    isRecord(v.anomalies) &&
    isRecord(v.expirations)
  );
}

/** Oldest first. A missing, unreadable or corrupt file is an empty history; this never throws. */
export async function readHistory(dir: string, accountId: string): Promise<HistoryEntry[]> {
  try {
    const raw: unknown = JSON.parse(await fs.readFile(historyFile(dir, accountId), 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isEntry).sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
}

/** Atomic (temp file + rename), readable by the current user only. */
export async function writeHistory(dir: string, accountId: string, history: HistoryEntry[]): Promise<void> {
  const file = historyFile(dir, accountId);
  await fs.mkdir(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(history), { mode: 0o600 });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
  await fs.chmod(file, 0o600).catch(() => undefined);
}

/** Append one scan (one entry per calendar day is kept) and persist. Returns the new history. */
export async function recordScan(dir: string, accountId: string, history: HistoryEntry[], entry: HistoryEntry): Promise<HistoryEntry[]> {
  const next = appendHistory(history, entry);
  await writeHistory(dir, accountId, next);
  return next;
}
