// Auto-update decisions, kept free of Electron so they can be unit-tested (see tests/updater.test.ts).
import type { UpdateStatus } from '../src/core/types';

/** where a new version can always be downloaded by hand */
export const RELEASE_URL = 'https://github.com/dominicplouffe/CloudPennies/releases/latest';

export const FIRST_CHECK_MS = 20_000;
export const CHECK_INTERVAL_MS = 12 * 60 * 60_000;

export interface UpdaterEnv {
  /** app.isPackaged */
  packaged: boolean;
  /** process.platform */
  platform: string;
  /** Linux only: running from an AppImage (process.env.APPIMAGE is set) */
  appImage: boolean;
}

export const UNSUPPORTED_MESSAGE = 'Updates are only available in an installed copy of CloudPennies. This one is running from source.';

/** Running from source: nothing is checked at all. */
export function unsupportedStatus(): UpdateStatus {
  return { state: 'unsupported', message: UNSUPPORTED_MESSAGE };
}

/** Whether this build can look for updates at all. */
export function canCheck(env: UpdaterEnv): boolean {
  return env.packaged;
}

/** Whether this build can replace itself with a downloaded update. On Linux only an AppImage can. */
export function canSelfUpdate(env: UpdaterEnv): boolean {
  if (!env.packaged) return false;
  if (env.platform === 'darwin' || env.platform === 'win32') return true;
  return env.platform === 'linux' && env.appImage;
}

/** Whether the app looks for updates by itself (after start, then every CHECK_INTERVAL_MS). */
export function shouldAutoCheck(env: UpdaterEnv, autoUpdate: boolean): boolean {
  return canCheck(env) && autoUpdate;
}

/**
 * What to do once a newer version was found: download it here, or only point at the releases page.
 * With automatic updates turned off nothing is ever downloaded, not even after a manual check.
 */
export function planAfterFound(env: UpdaterEnv, autoUpdate: boolean): 'download' | 'manual' {
  return autoUpdate && canSelfUpdate(env) ? 'download' : 'manual';
}

/** A short, single-line reason from whatever the updater threw. Never includes a stack trace or response headers. */
export function errorText(e: unknown): string {
  const code = typeof (e as { code?: unknown } | null)?.code === 'string' ? (e as { code: string }).code : '';
  const raw = e instanceof Error ? e.message : typeof e === 'string' ? e : '';
  if (/^ERR_UPDATER_(CHANNEL_FILE_NOT_FOUND|LATEST_VERSION_NOT_FOUND|NO_PUBLISHED_VERSIONS)$/.test(code) || /\b404\b/.test(raw.split('\n')[0] ?? '')) {
    return 'No published update information was found on GitHub.';
  }
  if (/net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ERR_INTERNET_DISCONNECTED|ERR_PROXY/i.test(`${code} ${raw}`)) {
    return 'GitHub could not be reached. Check your internet connection.';
  }
  const first = (raw.split('\n').find((l) => l.trim()) ?? '').trim();
  if (!first) return 'Unknown error.';
  return first.length > 200 ? `${first.slice(0, 197)}...` : first;
}

function manualStatus(version: string | undefined, message: string): UpdateStatus {
  return { state: 'available', ...(version ? { version } : {}), releaseUrl: RELEASE_URL, message };
}

/** A newer version exists and `planAfterFound` said not to download it: say why and where to get it. */
export function manualReason(env: UpdaterEnv, autoUpdate: boolean): string {
  if (!canSelfUpdate(env)) {
    return env.platform === 'linux'
      ? 'This copy of CloudPennies cannot update itself (only the AppImage can). Download the new version from the releases page.'
      : 'This copy of CloudPennies cannot update itself. Download the new version from the releases page.';
  }
  if (!autoUpdate) return 'Automatic updates are turned off. Download the new version from the releases page.';
  return 'Download the new version from the releases page.';
}

/** The download or the installation failed after an update was found: offer the manual download instead of a dead end. */
export function failedUpdateMessage(env: UpdaterEnv, e: unknown): string {
  const why = errorText(e);
  if (env.platform === 'darwin') {
    return `The update could not be installed automatically. That is expected when this copy of CloudPennies is not signed by Apple. Download the new version from the releases page. (${why})`;
  }
  return `The update could not be installed automatically. Download the new version from the releases page. (${why})`;
}

export type UpdaterEvent =
  | { type: 'checking' }
  /** the check finished and this is the newest version */
  | { type: 'not-available' }
  /** the check found a newer version */
  | { type: 'found'; version: string }
  | { type: 'progress'; percent: number }
  /** downloaded and handed to the platform installer: a restart installs it */
  | { type: 'downloaded' }
  /** anything the updater reported or threw: while checking, downloading or installing */
  | { type: 'error'; error: unknown };

export interface UpdaterContext {
  env: UpdaterEnv;
  /** settings.autoUpdate at the time of the event */
  autoUpdate: boolean;
}

const clampPercent = (p: number): number => (Number.isFinite(p) ? Math.min(100, Math.max(0, Math.round(p))) : 0);

/**
 * The next status after an updater event. The rule that matters: once a newer version is known
 * (available, downloading or ready), an error never ends in "error" but falls back to
 * "available" with the releases page, because the user can still update by hand.
 */
export function nextStatus(prev: UpdateStatus, event: UpdaterEvent, ctx: UpdaterContext): UpdateStatus {
  if (!canCheck(ctx.env)) return unsupportedStatus();
  switch (event.type) {
    case 'checking':
      return { state: 'checking' };
    case 'not-available':
      return { state: 'up-to-date' };
    case 'found':
      return planAfterFound(ctx.env, ctx.autoUpdate) === 'download'
        ? { state: 'downloading', version: event.version, percent: 0 }
        : manualStatus(event.version, manualReason(ctx.env, ctx.autoUpdate));
    case 'progress':
      // late progress events must not undo "ready" or a fallback
      if (prev.state !== 'downloading') return prev;
      return { ...prev, percent: Math.max(prev.percent ?? 0, clampPercent(event.percent)) };
    case 'downloaded':
      if (prev.state !== 'downloading') return prev;
      return { state: 'ready', ...(prev.version ? { version: prev.version } : {}) };
    case 'error':
      if (prev.state === 'downloading' || prev.state === 'ready') return manualStatus(prev.version, failedUpdateMessage(ctx.env, event.error));
      // a later failed check does not take away what is already known
      if (prev.state === 'available') return prev;
      return { state: 'error', message: errorText(event.error) };
  }
}
