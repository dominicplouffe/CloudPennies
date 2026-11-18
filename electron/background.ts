// Scans (manual and scheduled), and what happens after each one: history, alerts, Slack.
import { Notification, type BrowserWindow } from 'electron';
import { analyze } from '../src/core/analysis';
import { diffAlerts, digestText, progress, summarize } from '../src/core/history';
import type { Alert, CurStatus, HistoryEntry, Report, ScanProgress, Settings, Snapshot } from '../src/core/types';
import { curStatus, EMPTY_CUR_STATUS, importCur as importCurData, statusOf } from './aws/cur/importer';
import { errMessage } from './aws/errors';
import { createLiveSource, loadCachedSnapshot } from './aws/source';
import { alertsSlackText, batchNotifications, digestDue, pickPreviousEntry, shouldScan } from './backgroundLogic';
import * as creds from './credentials';
import { readHistory, recordScan } from './history';
import { postToSlack } from './slack';

export type ScanResult = { ok: true; snapshot: Snapshot } | { ok: false; error: string };

export interface BackgroundDeps {
  getWindow(): BrowserWindow | null;
  /** show + focus the main window, creating it if needed */
  showWindow(): void;
}

const TICK_MS = 10 * 60_000;
const FIRST_TICK_MS = 30_000;

let deps: BackgroundDeps = { getWindow: () => null, showWindow: () => undefined };
let scanInFlight: Promise<ScanResult> | null = null;
export type CurImportOutcome = { ok: true; status: CurStatus } | { ok: false; error: string };
/** a report import started outside a scan; scans wait for it and it waits for scans (one lock, see runScan / importCur) */
let curInFlight: Promise<CurImportOutcome> | null = null;
let lastFailureAt: number | null = null;
/** time of the newest snapshot per account, so the scheduler does not re-read the snapshot file at every tick */
let lastScan: { accountId: string; at: number | null } | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;
/** notifications are kept referenced until dismissed, otherwise they can be collected before a click */
const liveNotifications = new Set<Notification>();

export function initBackground(d: BackgroundDeps): void {
  deps = d;
}

function send(channel: string, payload: unknown): void {
  const win = deps.getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const log = (what: string, e: unknown): void => {
  // AWS error messages carry ARNs at most; the Slack helper never returns the webhook URL.
  console.warn(`[cloudpennies] ${what}: ${typeof e === 'string' ? e : errMessage(e)}`);
};

export function isScanning(): boolean {
  return scanInFlight !== null;
}

/** A new account (or a reconnect) starts with a clean slate. */
export function resetBackgroundState(): void {
  lastFailureAt = null;
  lastScan = null;
}

/**
 * Run a scan, or join the one that is already running: manual and scheduled scans share this
 * single in-flight promise. After a background scan the window is handed the new snapshot.
 */
export function runScan(origin: 'manual' | 'background'): Promise<ScanResult> {
  if (scanInFlight) return scanInFlight;
  const p = (async (): Promise<ScanResult> => {
    try {
      // a scan imports the report itself, so it must not run next to a standalone import
      if (curInFlight) await curInFlight.catch(() => undefined);
      const conn = await creds.resolveConnection();
      if (!conn) return { ok: false, error: 'Connect an AWS account first.' };
      const settings = await creds.getSettings();
      const source = createLiveSource({ credentials: conn.credentials, identity: conn.identity, settings, cacheDir: creds.cacheDir() });
      const snapshot = await source.scan((progressEvent: ScanProgress) => send('cp:scanProgress', progressEvent));
      lastFailureAt = null;
      lastScan = { accountId: conn.identity.accountId, at: Date.now() };
      await afterScan(snapshot, settings);
      if (origin === 'background') send('cp:snapshotUpdated', snapshot);
      return { ok: true, snapshot };
    } catch (e) {
      lastFailureAt = Date.now();
      if (origin === 'background') log('scheduled scan failed', e);
      return { ok: false, error: errMessage(e) || 'The scan failed.' };
    }
  })();
  scanInFlight = p;
  void p.finally(() => {
    if (scanInFlight === p) scanInFlight = null;
  });
  return p;
}

/**
 * Bridge.importCur: import (or update) the Cost and Usage Report now, outside a scan. Shares the scan
 * lock: it waits for a running scan, and a scan started meanwhile waits for it. Progress goes out on
 * the scan-progress channel.
 */
export function importCur(): Promise<CurImportOutcome> {
  if (curInFlight) return curInFlight;
  const p = (async (): Promise<CurImportOutcome> => {
    try {
      if (scanInFlight) await scanInFlight.catch(() => undefined);
      const conn = await creds.resolveConnection();
      if (!conn) return { ok: false, error: 'Connect an AWS account first.' };
      const settings = await creds.getSettings();
      let done = 0;
      const total = settings.curMonths + 1;
      const r = await importCurData({
        credentials: conn.credentials,
        accountId: conn.identity.accountId,
        cacheDir: creds.cacheDir(),
        settings,
        onStep: (step) => send('cp:scanProgress', { step, done: Math.min(done++, total - 1), total } satisfies ScanProgress),
      });
      send('cp:scanProgress', { step: 'Done', done: total, total } satisfies ScanProgress);
      // nothing usable at all is a failure for someone who asked for an import; partial problems travel in the status
      if (r.problem && !r.months.length) return { ok: false, error: r.problem.message };
      return { ok: true, status: statusOf(r) };
    } catch (e) {
      return { ok: false, error: errMessage(e) || 'The import failed.' };
    }
  })();
  curInFlight = p;
  void p.finally(() => {
    if (curInFlight === p) curInFlight = null;
  });
  return p;
}

/** Bridge.getCurStatus: exports on the account and what is imported. Never throws. */
export async function getCurStatus(refresh?: boolean): Promise<CurStatus> {
  try {
    const conn = await creds.resolveConnection();
    if (!conn) return { ...EMPTY_CUR_STATUS };
    const settings = await creds.getSettings();
    return await curStatus({ credentials: conn.credentials, accountId: conn.identity.accountId, cacheDir: creds.cacheDir(), settings, refresh: refresh === true });
  } catch (e) {
    return { ...EMPTY_CUR_STATUS, lastError: errMessage(e) || 'The Cost and Usage Report status could not be read.' };
  }
}

/** History is written before the scan resolves; notifications and Slack run on their own. Never throws. */
async function afterScan(snapshot: Snapshot, settings: Settings): Promise<void> {
  try {
    const accountId = snapshot.meta.accountId;
    const report = analyze(snapshot, settings);
    const entry = summarize(snapshot, report);
    const before = await readHistory(creds.historyDir(), accountId);
    const previous = pickPreviousEntry(before, entry);
    let history: HistoryEntry[] = before;
    try {
      history = await recordScan(creds.historyDir(), accountId, before, entry);
    } catch (e) {
      log('could not save the scan history', e);
    }
    const alerts = diffAlerts(previous, entry);
    void announce(snapshot, report, history, alerts, settings).catch((e) => log('could not send alerts', e));
  } catch (e) {
    log('post-scan processing failed', e);
  }
}

async function announce(snapshot: Snapshot, report: Report, history: HistoryEntry[], alerts: Alert[], settings: Settings): Promise<void> {
  if (settings.notifications && alerts.length) showNotifications(alerts);

  const webhook = await creds.getSlackWebhook();
  if (!webhook) return;

  const alertText = alertsSlackText(snapshot.meta.accountLabel, alerts);
  if (alertText) {
    const err = await postToSlack(webhook, alertText);
    if (err) log('Slack alert not delivered', err);
  }

  const accountId = snapshot.meta.accountId;
  const state = await creds.getBackgroundState();
  const week = digestDue({ weeklyDigest: settings.weeklyDigest, hasWebhook: true, lastDigestWeek: state.digestWeek[accountId] ?? null, now: new Date() });
  if (week) {
    const err = await postToSlack(webhook, digestText(snapshot, report, progress(history, report)));
    if (err) log('Slack weekly digest not delivered', err); // not recorded, so the next scan this week tries again
    else await creds.saveBackgroundState({ digestWeek: { ...state.digestWeek, [accountId]: week } });
  }
}

function notificationsSupported(): boolean {
  try {
    return Notification.isSupported();
  } catch {
    return false;
  }
}

function showNotification(title: string, body: string, onClick: () => void): void {
  const n = new Notification({ title, body });
  liveNotifications.add(n);
  const release = () => liveNotifications.delete(n);
  n.on('click', () => {
    release();
    onClick();
  });
  n.on('close', release);
  n.on('failed', release);
  n.show();
  // some Linux notification daemons never report "close"
  setTimeout(release, 10 * 60_000).unref();
}

function showNotifications(alerts: Alert[]): void {
  if (!notificationsSupported()) return;
  for (const plan of batchNotifications(alerts)) {
    try {
      showNotification(plan.title, plan.body, () => void openFromNotification(plan.alert));
    } catch (e) {
      log('could not show a notification', e);
    }
  }
}

/**
 * A click brings the window forward, refreshes it with the latest snapshot, and opens the page
 * (and item) the alert is about. The summary notification has no single target and opens the briefing.
 */
async function openFromNotification(alert?: Alert): Promise<void> {
  deps.showWindow();
  try {
    const conn = await creds.getConnection();
    if (!conn.connected || !conn.accountId) return;
    const snapshot = await loadCachedSnapshot(creds.cacheDir(), conn.accountId);
    if (snapshot) send('cp:snapshotUpdated', snapshot);
  } catch (e) {
    log('could not refresh the window', e);
  }
  send('cp:navigate', alert ? { page: alert.page, focusId: alert.focusId } : { page: 'briefing' });
}

/** Bridge.testNotifications: null when everything that is configured worked, otherwise what went wrong. */
export async function testNotifications(): Promise<string | null> {
  const problems: string[] = [];
  if (notificationsSupported()) {
    try {
      showNotification('CloudPennies', 'Desktop notifications are working.', () => deps.showWindow());
    } catch {
      problems.push('The desktop notification could not be shown.');
    }
  } else {
    problems.push('Desktop notifications are not available on this computer.');
  }
  const webhook = await creds.getSlackWebhook();
  if (webhook) {
    const err = await postToSlack(webhook, 'CloudPennies test message — Slack notifications are working.');
    if (err) problems.push(err);
  }
  return problems.length ? problems.join(' ') : null;
}

/** Bridge.getHistory: the connected account's scans, oldest first; empty when not connected. */
export async function getHistory(): Promise<HistoryEntry[]> {
  try {
    const conn = await creds.getConnection();
    if (!conn.connected || !conn.accountId) return [];
    return await readHistory(creds.historyDir(), conn.accountId);
  } catch {
    return [];
  }
}

// ── scheduler ──

async function lastScanAt(accountId: string): Promise<number | null> {
  if (lastScan?.accountId === accountId) return lastScan.at;
  const snapshot = await loadCachedSnapshot(creds.cacheDir(), accountId);
  const t = snapshot ? Date.parse(snapshot.meta.generatedAt) : NaN;
  lastScan = { accountId, at: Number.isFinite(t) ? t : null };
  return lastScan.at;
}

/** One scheduler pass. Never throws; a failed scan is retried at a later tick (see FAILURE_BACKOFF_MS). */
export async function tick(): Promise<void> {
  try {
    if (scanInFlight) return;
    const settings = await creds.getSettings();
    if (settings.autoScanHours <= 0) return;
    const conn = await creds.getConnection();
    const connected = conn.connected && !!conn.accountId;
    const due = shouldScan({
      connected,
      autoScanHours: settings.autoScanHours,
      lastScanAt: connected && conn.accountId ? await lastScanAt(conn.accountId) : null,
      lastFailureAt,
      now: Date.now(),
      scanning: scanInFlight !== null,
    });
    if (due) await runScan('background');
  } catch (e) {
    log('scheduler check failed', e);
  }
}

export function startScheduler(): void {
  stopScheduler();
  firstTimer = setTimeout(() => void tick(), FIRST_TICK_MS);
  tickTimer = setInterval(() => void tick(), TICK_MS);
}

export function stopScheduler(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (tickTimer) clearInterval(tickTimer);
  firstTimer = tickTimer = null;
}
