// Pure decision logic behind scheduled scans, alerts, Slack and the history file. No Electron, no network.
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  alertsSlackText,
  batchNotifications,
  digestDue,
  FAILURE_BACKOFF_MS,
  isoWeekKey,
  pickPreviousEntry,
  shouldScan,
  validateSlackWebhook,
} from '../electron/backgroundLogic';
import { historyFile, readHistory, recordScan, writeHistory } from '../electron/history';
import { postToSlack } from '../electron/slack';
import type { Alert, HistoryEntry } from '../src/core/types';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-11-18T12:00:00Z');

const entry = (at: string, over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  at,
  today: at.slice(0, 10),
  last30: 100,
  mtd: 50,
  projected: 120,
  insights: {},
  anomalies: {},
  expirations: {},
  esrPct: 0,
  coveragePct: 0,
  ...over,
});

const alert = (n: number): Alert => ({ kind: 'anomaly', title: `Alert ${n}`, body: `Body ${n}`, page: 'anomalies', focusId: `a${n}` });

describe('shouldScan', () => {
  const base = { connected: true, autoScanHours: 24, lastScanAt: NOW - 25 * HOUR, lastFailureAt: null, now: NOW };

  it('scans when the last snapshot is older than the interval', () => {
    expect(shouldScan(base)).toBe(true);
    expect(shouldScan({ ...base, lastScanAt: NOW - 24 * HOUR })).toBe(true);
  });
  it('does not scan when the snapshot is fresh enough', () => {
    expect(shouldScan({ ...base, lastScanAt: NOW - 23 * HOUR })).toBe(false);
    expect(shouldScan({ ...base, autoScanHours: 6, lastScanAt: NOW - 5 * HOUR })).toBe(false);
    expect(shouldScan({ ...base, autoScanHours: 6, lastScanAt: NOW - 7 * HOUR })).toBe(true);
  });
  it('scans when there has never been a scan', () => {
    expect(shouldScan({ ...base, lastScanAt: null })).toBe(true);
  });
  it('never scans when disconnected, switched off, or already scanning', () => {
    expect(shouldScan({ ...base, connected: false })).toBe(false);
    expect(shouldScan({ ...base, autoScanHours: 0 })).toBe(false);
    expect(shouldScan({ ...base, autoScanHours: Number.NaN })).toBe(false);
    expect(shouldScan({ ...base, scanning: true })).toBe(false);
  });
  it('backs off for an hour after a failure', () => {
    expect(shouldScan({ ...base, lastFailureAt: NOW - 10 * 60_000 })).toBe(false);
    expect(shouldScan({ ...base, lastFailureAt: NOW - FAILURE_BACKOFF_MS + 1 })).toBe(false);
    expect(shouldScan({ ...base, lastFailureAt: NOW - FAILURE_BACKOFF_MS })).toBe(true);
    expect(shouldScan({ ...base, lastScanAt: null, lastFailureAt: NOW - 59 * 60_000 })).toBe(false);
  });
  it('is not confused by a clock that moved backwards', () => {
    expect(shouldScan({ ...base, lastFailureAt: NOW + 5 * HOUR })).toBe(true);
    expect(shouldScan({ ...base, lastScanAt: NOW + 5 * HOUR })).toBe(false);
  });
});

describe('pickPreviousEntry', () => {
  const cur = entry('2026-11-18T12:00:00.000Z');

  it('returns null for the first scan', () => {
    expect(pickPreviousEntry([], cur)).toBeNull();
  });
  it('picks the latest earlier scan, whatever the order on disk', () => {
    const a = entry('2026-11-15T08:00:00.000Z');
    const b = entry('2026-11-17T08:00:00.000Z');
    expect(pickPreviousEntry([b, a], cur)).toBe(b);
  });
  it('uses an earlier scan from the same day, so a re-scan does not repeat alerts', () => {
    const yesterday = entry('2026-11-17T08:00:00.000Z');
    const thisMorning = entry('2026-11-18T07:00:00.000Z');
    expect(pickPreviousEntry([yesterday, thisMorning], cur)).toBe(thisMorning);
  });
  it('ignores the same scan and anything newer', () => {
    const same = entry(cur.at);
    const newer = entry('2026-11-19T00:00:00.000Z');
    expect(pickPreviousEntry([same, newer], cur)).toBeNull();
    const older = entry('2026-11-10T00:00:00.000Z');
    expect(pickPreviousEntry([older, same, newer], cur)).toBe(older);
  });
});

describe('validateSlackWebhook', () => {
  it('accepts a Slack incoming webhook and normalizes it', () => {
    expect(validateSlackWebhook('  https://hooks.slack.com/services/T000/B000/XXXX \n')).toEqual({ ok: true, url: 'https://hooks.slack.com/services/T000/B000/XXXX' });
    expect(validateSlackWebhook('https://hooks.slack.com:443/services/T000/B000/XXXX').ok).toBe(true);
  });
  it.each([
    ['another host', 'https://evil.example.com/x'],
    ['http', 'http://hooks.slack.com/services/T000/B000/XXXX'],
    ['a lookalike subdomain', 'https://hooks.slack.com.evil.example/services/T000/B000/XXXX'],
    ['a host suffix', 'https://evilhooks.slack.com/services/T000/B000/XXXX'],
    ['userinfo trick', 'https://hooks.slack.com@evil.example/services/T000/B000/XXXX'],
    ['credentials', 'https://user:pw@hooks.slack.com/services/T000/B000/XXXX'],
    ['another port', 'https://hooks.slack.com:8443/services/T000/B000/XXXX'],
    ['another path', 'https://hooks.slack.com/workflows/T000/B000/XXXX'],
    ['an empty service path', 'https://hooks.slack.com/services/'],
    ['path traversal', 'https://hooks.slack.com/services/../x'],
    ['a query string', 'https://hooks.slack.com/services/T000/B000/XXXX?next=https://evil.example'],
    ['not a URL', 'hooks.slack.com/services/T000/B000/XXXX'],
    ['javascript', 'javascript:alert(1)'],
    ['empty', '   '],
  ])('rejects %s', (_name, url) => {
    const r = validateSlackWebhook(url);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/hooks\.slack\.com\/services/);
  });
  it('rejects non-strings and absurdly long input', () => {
    expect(validateSlackWebhook(null).ok).toBe(false);
    expect(validateSlackWebhook({ toString: () => 'https://hooks.slack.com/services/T/B/X' }).ok).toBe(false);
    expect(validateSlackWebhook('https://hooks.slack.com/services/' + 'a'.repeat(600)).ok).toBe(false);
  });
});

describe('weekly digest', () => {
  const d = (y: number, m: number, day: number, h = 9) => new Date(y, m - 1, day, h);

  it('computes ISO weeks, including year boundaries', () => {
    expect(isoWeekKey(d(2026, 11, 16))).toBe('2026-W47'); // Monday
    expect(isoWeekKey(d(2026, 11, 22, 23))).toBe('2026-W47'); // Sunday
    expect(isoWeekKey(d(2026, 11, 23, 0))).toBe('2026-W48'); // next Monday
    expect(isoWeekKey(d(2026, 1, 1))).toBe('2026-W01');
    expect(isoWeekKey(d(2027, 1, 1))).toBe('2026-W53'); // a Friday in the last week of 2026
    expect(isoWeekKey(d(2024, 12, 30))).toBe('2025-W01'); // a Monday that belongs to 2025
    expect(isoWeekKey(d(2021, 1, 3))).toBe('2020-W53');
  });
  it('is due once per ISO week', () => {
    const base = { weeklyDigest: true, hasWebhook: true };
    expect(digestDue({ ...base, lastDigestWeek: null, now: d(2026, 11, 18) })).toBe('2026-W47');
    expect(digestDue({ ...base, lastDigestWeek: '2026-W47', now: d(2026, 11, 22) })).toBeNull(); // Sunday, same week
    expect(digestDue({ ...base, lastDigestWeek: '2026-W47', now: d(2026, 11, 23, 0) })).toBe('2026-W48'); // Monday
    expect(digestDue({ ...base, lastDigestWeek: '2026-W46', now: d(2026, 11, 19) })).toBe('2026-W47'); // app was closed on Monday
  });
  it('needs both the setting and a webhook', () => {
    const now = d(2026, 11, 18);
    expect(digestDue({ weeklyDigest: false, hasWebhook: true, lastDigestWeek: null, now })).toBeNull();
    expect(digestDue({ weeklyDigest: true, hasWebhook: false, lastDigestWeek: null, now })).toBeNull();
  });
});

describe('notification batching', () => {
  it('shows nothing without alerts', () => {
    expect(batchNotifications([])).toEqual([]);
    expect(alertsSlackText('Acme', [])).toBeNull();
  });
  it('shows up to three alerts individually', () => {
    const alerts = [alert(1), alert(2), alert(3)];
    const plans = batchNotifications(alerts);
    expect(plans.map((p) => p.title)).toEqual(['Alert 1', 'Alert 2', 'Alert 3']);
    expect(plans[0]).toEqual({ title: 'Alert 1', body: 'Body 1', alert: alerts[0] });
  });
  it('collapses more than three into one summary', () => {
    const plans = batchNotifications([alert(1), alert(2), alert(3), alert(4), alert(5)]);
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('5 things need attention in your AWS bill');
    expect(plans[0].body).toContain('Alert 1');
    expect(plans[0].body).toContain('2 more');
    expect(plans[0].alert).toBeUndefined();
  });
  it('puts every alert in one Slack message', () => {
    const text = alertsSlackText('Acme (1234)', [alert(1), alert(2), alert(3), alert(4)]);
    expect(text?.split('\n')).toHaveLength(5);
    expect(text).toContain('Acme (1234)');
    expect(text).toContain('Alert 4');
  });
});

describe('history store', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'cp-history-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('returns an empty list for a missing or corrupt file', async () => {
    expect(await readHistory(path.join(dir, 'nope'), '123456789012')).toEqual([]);
    writeFileSync(historyFile(dir, '123456789012'), '{not json');
    expect(await readHistory(dir, '123456789012')).toEqual([]);
    writeFileSync(historyFile(dir, '123456789012'), '{"a":1}');
    expect(await readHistory(dir, '123456789012')).toEqual([]);
  });
  it('drops malformed entries and keeps the good ones in order', async () => {
    const a = entry('2026-11-16T08:00:00.000Z');
    const b = entry('2026-11-17T08:00:00.000Z');
    writeFileSync(historyFile(dir, '1'), JSON.stringify([b, null, { at: 5 }, 'x', a]));
    expect(await readHistory(dir, '1')).toEqual([a, b]);
  });
  it('writes atomically with private permissions, one entry per day', async () => {
    const sub = path.join(dir, 'history');
    let h = await recordScan(sub, '123456789012', [], entry('2026-11-17T08:00:00.000Z'));
    h = await recordScan(sub, '123456789012', h, entry('2026-11-18T07:00:00.000Z'));
    h = await recordScan(sub, '123456789012', h, entry('2026-11-18T12:00:00.000Z', { last30: 7 }));
    expect(h.map((e) => e.at)).toEqual(['2026-11-17T08:00:00.000Z', '2026-11-18T12:00:00.000Z']);
    expect(await readHistory(sub, '123456789012')).toEqual(h);
    expect(readdirSync(sub)).toEqual(['history-123456789012.json']); // no temp file left behind
    if (process.platform !== 'win32') expect(statSync(historyFile(sub, '123456789012')).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(historyFile(sub, '123456789012'), 'utf8'))).toHaveLength(2);
  });
  it('keeps accounts apart and never writes outside its directory', async () => {
    await writeHistory(dir, '111', [entry('2026-11-17T08:00:00.000Z')]);
    expect(await readHistory(dir, '222')).toEqual([]);
    expect(path.dirname(historyFile(dir, '../../etc/passwd'))).toBe(dir);
  });
});

describe('postToSlack', () => {
  const URL_OK = 'https://hooks.slack.com/services/T000/B000/XXXX';

  it('posts {text} as JSON and reports success as null', async () => {
    const f = vi.fn(async () => new Response('ok', { status: 200 }));
    expect(await postToSlack(URL_OK, 'hello', f as unknown as typeof fetch)).toBeNull();
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(URL_OK);
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ text: 'hello' });
  });
  it('never posts to a URL that is not a Slack webhook', async () => {
    const f = vi.fn();
    expect(await postToSlack('https://evil.example.com/x', 'hello', f as unknown as typeof fetch)).toMatch(/not valid/);
    expect(f).not.toHaveBeenCalled();
  });
  it('turns failures into messages that do not contain the URL', async () => {
    const gone = await postToSlack(URL_OK, 'x', (async () => new Response('no_service', { status: 404 })) as unknown as typeof fetch);
    const down = await postToSlack(URL_OK, 'x', (async () => {
      throw new Error(`connect ECONNREFUSED ${URL_OK}`);
    }) as unknown as typeof fetch);
    for (const msg of [gone, down]) {
      expect(typeof msg).toBe('string');
      expect(msg).not.toContain('XXXX');
      expect(msg).not.toContain('hooks.slack.com');
    }
  });
  it('gives up after 10 seconds', async () => {
    vi.useFakeTimers();
    try {
      const hang = ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => init.signal?.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
      const p = postToSlack(URL_OK, 'x', hang);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toMatch(/10 seconds/);
    } finally {
      vi.useRealTimers();
    }
  });
});
