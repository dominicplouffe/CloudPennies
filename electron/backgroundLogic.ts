// Pure decision functions for background scans, alerts and Slack. No Electron imports, so
// everything here is unit-tested (tests/background.test.ts).
import type { Alert, HistoryEntry } from '../src/core/types';

const HOUR_MS = 3_600_000;

/** After a failed scan, wait at least this long before the scheduler tries again. */
export const FAILURE_BACKOFF_MS = HOUR_MS;

export interface ShouldScanInput {
  connected: boolean;
  /** Settings.autoScanHours; 0 = never */
  autoScanHours: number;
  /** epoch ms of the last successful scan (the cached snapshot), null when there is none */
  lastScanAt: number | null;
  /** epoch ms of the last failed attempt, null when the last attempt succeeded */
  lastFailureAt: number | null;
  /** epoch ms */
  now: number;
  /** a scan is already in flight */
  scanning?: boolean;
}

/** Should the scheduler start a scan at this tick? */
export function shouldScan(i: ShouldScanInput): boolean {
  if (!i.connected || i.scanning) return false;
  if (!Number.isFinite(i.autoScanHours) || i.autoScanHours <= 0) return false;
  // A failure timestamp in the future (clock moved back) must not block scans forever.
  if (i.lastFailureAt !== null && i.now >= i.lastFailureAt && i.now - i.lastFailureAt < FAILURE_BACKOFF_MS) return false;
  if (i.lastScanAt === null || !Number.isFinite(i.lastScanAt)) return true;
  if (i.lastScanAt > i.now) return false; // snapshot "from the future": the clock changed, wait for it to catch up
  return i.now - i.lastScanAt >= i.autoScanHours * HOUR_MS;
}

/**
 * The entry to diff a new scan against: the most recent EARLIER scan, taken from the history
 * before the new entry is appended. An earlier scan from the same day counts (otherwise every
 * re-scan would repeat that day's alerts); an entry with the same timestamp is the same scan
 * and is skipped. Returns null for the first scan.
 */
export function pickPreviousEntry(history: readonly HistoryEntry[], current: HistoryEntry): HistoryEntry | null {
  let best: HistoryEntry | null = null;
  for (const h of history) {
    if (!h || typeof h.at !== 'string' || h.at >= current.at) continue;
    if (!best || h.at > best.at) best = h;
  }
  return best;
}

export type WebhookValidation = { ok: true; url: string } | { ok: false; error: string };

const WEBHOOK_HELP = 'It should look like https://hooks.slack.com/services/T…/B…/… (create one in Slack under Apps → Incoming Webhooks).';

/** Accept only Slack incoming-webhook URLs, so the app can never be pointed at an arbitrary server. */
export function validateSlackWebhook(raw: unknown): WebhookValidation {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, error: `Paste a Slack webhook URL. ${WEBHOOK_HELP}` };
  const text = raw.trim();
  if (text.length > 512) return { ok: false, error: `That is too long to be a Slack webhook URL. ${WEBHOOK_HELP}` };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { ok: false, error: `That is not a valid URL. ${WEBHOOK_HELP}` };
  }
  if (u.protocol !== 'https:') return { ok: false, error: `Slack webhook URLs start with https://. ${WEBHOOK_HELP}` };
  if (u.hostname !== 'hooks.slack.com' || u.port !== '' || u.username !== '' || u.password !== '') {
    return { ok: false, error: `That is not a Slack webhook URL. ${WEBHOOK_HELP}` };
  }
  if (!/^\/services\/[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/.test(u.pathname) || u.search !== '' || u.hash !== '') {
    return { ok: false, error: `That Slack URL is not an incoming webhook. ${WEBHOOK_HELP}` };
  }
  return { ok: true, url: `https://hooks.slack.com${u.pathname}` };
}

/** ISO-8601 week of the date's local calendar day, e.g. "2026-W47". Weeks start on Monday. */
export function isoWeekKey(d: Date): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const weekday = (t.getUTCDay() + 6) % 7; // Monday = 0
  t.setUTCDate(t.getUTCDate() - weekday + 3); // the Thursday of this week decides the ISO year
  const year = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export interface DigestInput {
  weeklyDigest: boolean;
  hasWebhook: boolean;
  /** isoWeekKey of the last digest that was posted, null if never */
  lastDigestWeek: string | null;
  now: Date;
}

/**
 * The weekly digest goes out with the first successful scan of each ISO week (i.e. on or after
 * Monday). Returns the week key to remember once it has been posted, or null when none is due.
 */
export function digestDue(i: DigestInput): string | null {
  if (!i.weeklyDigest || !i.hasWebhook) return null;
  const week = isoWeekKey(i.now);
  return week === i.lastDigestWeek ? null : week;
}

export const MAX_NOTIFICATIONS = 3;

export interface NotificationPlan {
  title: string;
  body: string;
  /** the alert behind this notification; absent for the summary */
  alert?: Alert;
}

/** At most three desktop notifications per scan; more than that collapses into one summary. */
export function batchNotifications(alerts: readonly Alert[]): NotificationPlan[] {
  if (alerts.length <= MAX_NOTIFICATIONS) return alerts.map((alert) => ({ title: alert.title, body: alert.body, alert }));
  const shown = alerts.slice(0, MAX_NOTIFICATIONS).map((a) => a.title);
  const rest = alerts.length - shown.length;
  return [{ title: `${alerts.length} things need attention in your AWS bill`, body: `${shown.join(' · ')} · and ${rest} more` }];
}

/** One Slack message for all alerts of a scan; null when there is nothing to say. */
export function alertsSlackText(accountLabel: string, alerts: readonly Alert[]): string | null {
  if (!alerts.length) return null;
  return [`*CloudPennies — ${accountLabel}*`, ...alerts.map((a) => `• *${a.title}* — ${a.body}`)].join('\n');
}
