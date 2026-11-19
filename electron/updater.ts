// In-app updates from GitHub Releases (electron-updater). The renderer owns the UI: nothing here shows a dialog.
// Decisions live in updaterLogic.ts; this file only wires them to electron-updater.
import { app, type BrowserWindow } from 'electron';
import { autoUpdater, type AppUpdater } from 'electron-updater';
import type { AppInfo, Settings, UpdateStatus } from '../src/core/types';
import { CHECK_INTERVAL_MS, FIRST_CHECK_MS, canSelfUpdate, nextStatus, planAfterFound, shouldAutoCheck, unsupportedStatus, type UpdaterContext, type UpdaterEnv, type UpdaterEvent } from './updaterLogic';

export interface UpdaterDeps {
  getWindow(): BrowserWindow | null;
  /** the current (in-memory) settings */
  getSettings(): Settings;
  /** tell the app whether a real quit is under way, so the close-to-tray handler lets the window close */
  setQuitting(quitting: boolean): void;
}

let deps: UpdaterDeps | null = null;
let updater: AppUpdater | null = null;
let status: UpdateStatus = { state: 'idle' };
/** installUpdate() was called and the app is expected to quit */
let installing = false;
let checkInFlight: Promise<UpdateStatus> | null = null;
let firstTimer: NodeJS.Timeout | null = null;
let intervalTimer: NodeJS.Timeout | null = null;

const env = (): UpdaterEnv => ({ packaged: app.isPackaged, platform: process.platform, appImage: !!process.env.APPIMAGE });
const context = (): UpdaterContext => ({ env: env(), autoUpdate: deps?.getSettings().autoUpdate ?? true });

export function getAppInfo(): AppInfo {
  return { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform };
}

function apply(event: UpdaterEvent): UpdateStatus {
  const next = nextStatus(status, event, context());
  if (next !== status) {
    status = next;
    const win = deps?.getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('cp:updateStatus', status);
  }
  return status;
}

const log = (what: string, e: unknown): void => {
  console.warn(`[cloudpennies] updater: ${what}: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
};

/** electron-updater creates its updater on first access; that only ever happens in a packaged app. */
function getUpdater(): AppUpdater {
  if (updater) return updater;
  const u = autoUpdater;
  // downloads are started here, after updaterLogic decided (settings, platform)
  u.autoDownload = false;
  u.autoInstallOnAppQuit = true;
  u.allowDowngrade = false;
  u.logger = {
    info: () => undefined,
    debug: () => undefined,
    warn: (m: unknown) => log('warning', m),
    error: (m: unknown) => log('error', m),
  };
  // A Linux build that is not an AppImage cannot replace itself, and electron-updater then refuses even to
  // check. This flag only lifts that refusal (the configuration is still the packaged app-update.yml), so
  // the app can say that a newer version exists. It never downloads in that case: see planAfterFound.
  if (!canSelfUpdate(env())) u.forceDevUpdateConfig = true;
  u.on('download-progress', (p) => apply({ type: 'progress', percent: p.percent }));
  // Also covers failures reported outside a promise: Squirrel.Mac rejecting an unsigned app, a failed install.
  u.on('error', (e) => {
    if (installing) {
      installing = false;
      deps?.setQuitting(false);
    }
    if (status.state === 'downloading' || status.state === 'ready') apply({ type: 'error', error: e });
  });
  updater = u;
  return u;
}

async function download(u: AppUpdater): Promise<void> {
  try {
    // On macOS this resolves only after Squirrel accepted the update, so "ready" is not announced for an
    // update that an unsigned app could never install.
    await u.downloadUpdate();
    apply({ type: 'downloaded' });
  } catch (e) {
    log('download failed', e);
    apply({ type: 'error', error: e });
  }
}

/**
 * Bridge.checkForUpdates. Resolves once the check is done (a download continues on its own and is
 * reported over cp:updateStatus). Never rejects.
 */
export function checkForUpdates(): Promise<UpdateStatus> {
  if (!app.isPackaged) return Promise.resolve(unsupportedStatus());
  if (checkInFlight) return checkInFlight;
  // nothing to gain from checking again while an update is on its way or waiting for a restart
  if (status.state === 'downloading' || status.state === 'ready') return Promise.resolve(status);
  const p = (async (): Promise<UpdateStatus> => {
    try {
      const u = getUpdater();
      apply({ type: 'checking' });
      const result = await u.checkForUpdates();
      if (!result || !result.isUpdateAvailable) return apply({ type: 'not-available' });
      const ctx = context();
      const found = apply({ type: 'found', version: result.updateInfo.version });
      if (found.state === 'downloading' && planAfterFound(ctx.env, ctx.autoUpdate) === 'download') void download(u);
      return found;
    } catch (e) {
      log('check failed', e);
      return apply({ type: 'error', error: e });
    }
  })();
  checkInFlight = p;
  void p.finally(() => {
    if (checkInFlight === p) checkInFlight = null;
  });
  return p;
}

/** Bridge.installUpdate: quit and install the downloaded update. Does nothing unless one is ready. */
export function installUpdate(): void {
  if (!app.isPackaged || !updater || status.state !== 'ready') return;
  // quitAndInstall closes the windows before "before-quit" fires: without this the close-to-tray handler would hide the window instead
  installing = true;
  deps?.setQuitting(true);
  try {
    updater.quitAndInstall();
  } catch (e) {
    installing = false;
    deps?.setQuitting(false);
    log('install failed', e);
    apply({ type: 'error', error: e });
  }
}

function autoCheck(): void {
  if (shouldAutoCheck(env(), deps?.getSettings().autoUpdate ?? true)) void checkForUpdates();
}

/** Start the automatic checks (packaged builds only; each one re-reads the autoUpdate setting). */
export function initUpdater(d: UpdaterDeps): void {
  deps = d;
  stopUpdater();
  if (!app.isPackaged) return;
  firstTimer = setTimeout(autoCheck, FIRST_CHECK_MS);
  intervalTimer = setInterval(autoCheck, CHECK_INTERVAL_MS);
  firstTimer.unref();
  intervalTimer.unref();
}

export function stopUpdater(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (intervalTimer) clearInterval(intervalTimer);
  firstTimer = intervalTimer = null;
}
