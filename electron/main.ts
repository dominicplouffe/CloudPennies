// CloudPennies — Electron main process.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SETTINGS, type CostQuery, type CostResult, type CredentialInput, type Settings, type Snapshot } from '../src/core/types';
import { createLiveSource, loadCachedSnapshot } from './aws/source';
import * as background from './background';
import * as creds from './credentials';
import { TRAY_ICON_DATA_URL } from './trayIcon';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const INDEX_HTML = path.join(__dirname, '../dist/index.html');
const isMac = process.platform === 'darwin';

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
/** set once the user really quits (menu, tray, Cmd+Q), so the close handler stops hiding the window */
let quitting = false;
/** in-memory copy of the saved settings; the window close handler has to decide synchronously */
let settings: Settings = DEFAULT_SETTINGS;
/** started by the OS at login: stay in the tray instead of opening a window */
const startHidden = process.argv.includes('--hidden');

/** Closing the window only hides it when there is a way to get it back (tray, or the Dock on macOS). */
const keepsRunningInBackground = (): boolean => settings.runInBackground && (isMac || tray !== null);

const isHttpUrl = (url: string): boolean => {
  try {
    const p = new URL(url).protocol;
    return p === 'https:' || p === 'http:';
  } catch {
    return false;
  }
};

/** true for the app's own pages (dev server or the bundled index.html) */
function isAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (DEV_URL) return u.origin === new URL(DEV_URL).origin;
    return u.protocol === 'file:' && path.normalize(decodeURIComponent(u.pathname)).endsWith(path.join('dist', 'index.html'));
  } catch {
    return false;
  }
}

function createWindow(show = true): void {
  win = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1080,
    minHeight: 700,
    title: 'CloudPennies',
    backgroundColor: '#f6f4ef',
    show: false,
    ...(isMac ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });
  if (show) win.once('ready-to-show', () => win?.show());
  win.on('close', (event) => {
    if (quitting || !keepsRunningInBackground()) return;
    event.preventDefault();
    win?.hide();
  });
  win.on('closed', () => {
    win = null;
  });

  // External links open in the system browser; the app window never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isHttpUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    if (isHttpUrl(url)) void shell.openExternal(url);
  });

  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(INDEX_HTML);
}

/** Show and focus the main window, creating it if it was closed. */
function showWindow(): void {
  if (!win || win.isDestroyed()) {
    createWindow();
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quitApp(): void {
  quitting = true;
  app.quit();
}

// ── tray / background / login item ──

function createTray(): void {
  if (tray) return;
  try {
    let image = nativeImage.createFromDataURL(TRAY_ICON_DATA_URL);
    if (isMac) image = image.resize({ width: 18, height: 18 });
    const t = new Tray(image);
    t.setToolTip('CloudPennies');
    t.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open CloudPennies', click: () => showWindow() },
        { label: 'Scan now', click: () => void background.runScan('background') },
        { type: 'separator' },
        { label: 'Quit', click: () => quitApp() },
      ]),
    );
    if (!isMac) t.on('click', () => showWindow());
    tray = t;
  } catch (e) {
    // e.g. a Linux desktop without a status-notifier host; closing the window then quits as usual
    tray = null;
    console.warn('[cloudpennies] no system tray available:', e instanceof Error ? e.message : String(e));
  }
}

function destroyTray(): void {
  tray?.destroy();
  tray = null;
}

/** Apply the settings that live outside the renderer: tray and start-at-login. */
function applySettings(next: Settings): void {
  settings = next;
  if (settings.runInBackground) createTray();
  else {
    destroyTray();
    // a window that was hidden to the tray would otherwise be unreachable
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  }
  applyLoginItem();
}

function applyLoginItem(): void {
  // Do not register a development run (the bare Electron binary) to start with the computer.
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: settings.launchAtLogin,
      // with "run in background" a login start goes straight to the tray (Windows; ignored elsewhere)
      args: settings.launchAtLogin && settings.runInBackground ? ['--hidden'] : [],
    });
  } catch {
    /* not supported on this platform (e.g. some Linux setups) */
  }
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' } as MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC ──

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DIM = /^(SERVICE|USAGE_TYPE|REGION|LINKED_ACCOUNT|OPERATION|PURCHASE_TYPE|INSTANCE_TYPE|RECORD_TYPE|TAG:.+)$/;

/** Rebuild the query from untrusted renderer input so only well-formed values reach AWS. */
function sanitizeQuery(raw: unknown): CostQuery {
  const q = (raw ?? {}) as Partial<CostQuery>;
  if (typeof q.start !== 'string' || typeof q.end !== 'string' || !ISO_DATE.test(q.start) || !ISO_DATE.test(q.end)) throw new Error('Invalid date range');
  const groupBy = Array.isArray(q.groupBy) ? q.groupBy.filter((d) => typeof d === 'string' && DIM.test(d)) : [];
  if (groupBy.length > 2) throw new Error('At most two group-by dimensions are supported');
  const filters: NonNullable<CostQuery['filters']> = {};
  for (const [k, v] of Object.entries(q.filters ?? {})) {
    if (!DIM.test(k) || !Array.isArray(v)) continue;
    const vals = v.filter((x): x is string => typeof x === 'string');
    if (vals.length) filters[k as keyof typeof filters] = vals;
  }
  return { start: q.start, end: q.end, granularity: q.granularity === 'MONTHLY' ? 'MONTHLY' : 'DAILY', groupBy, filters };
}

async function liveSource() {
  const conn = await creds.resolveConnection();
  if (!conn) return null;
  return createLiveSource({ credentials: conn.credentials, identity: conn.identity, settings: await creds.getSettings(), cacheDir: creds.cacheDir() });
}

function registerIpc(): void {
  /** Only our own window's main frame may call into the main process. */
  const handle = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>) => {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      const frame = event.senderFrame;
      if (!win || event.sender !== win.webContents || !frame || frame !== win.webContents.mainFrame || !isAppUrl(frame.url)) {
        throw new Error('Blocked IPC call from an unexpected sender');
      }
      return fn(...(args as A));
    });
  };

  handle('cp:getConnection', () => creds.getConnection());
  handle('cp:listProfiles', () => creds.listProfiles());
  handle('cp:connect', async (input: CredentialInput) => {
    const r = await creds.connect(input);
    if (r.ok) background.resetBackgroundState();
    return r;
  });
  handle('cp:disconnect', async (): Promise<void> => {
    await creds.disconnect();
    background.resetBackgroundState();
  });
  handle('cp:getSettings', () => creds.getSettings());
  handle('cp:saveSettings', async (s: Settings): Promise<void> => {
    applySettings(await creds.saveSettings(s));
  });

  handle('cp:getHistory', () => background.getHistory());
  handle('cp:setSlackWebhook', (url: string | null) => creds.setSlackWebhook(url));
  handle('cp:hasSlackWebhook', () => creds.hasSlackWebhook());
  handle('cp:testNotifications', () => background.testNotifications());

  handle('cp:loadSnapshot', async (): Promise<Snapshot | null> => {
    const conn = await creds.getConnection();
    if (!conn.connected || !conn.accountId) return null;
    return loadCachedSnapshot(creds.cacheDir(), conn.accountId);
  });

  // shares one in-flight scan with the scheduler: a manual scan during a background one awaits that one
  handle('cp:scan', () => background.runScan('manual'));

  handle('cp:query', async (q: CostQuery): Promise<CostResult> => {
    const source = await liveSource();
    if (!source) throw new Error('Not connected to AWS');
    return source.query(sanitizeQuery(q));
  });

  handle('cp:saveFile', async (defaultName: string, content: string): Promise<boolean> => {
    if (!win || typeof content !== 'string') return false;
    const name = path.basename(String(defaultName || 'cloudpennies.txt'));
    const ext = path.extname(name).slice(1).toLowerCase();
    const r = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('downloads'), name),
      ...(ext ? { filters: [{ name: ext.toUpperCase(), extensions: [ext] }, { name: 'All files', extensions: ['*'] }] } : {}),
    });
    if (r.canceled || !r.filePath) return false;
    await fs.writeFile(r.filePath, content, 'utf8');
    return true;
  });

  handle('cp:openExternal', async (url: string): Promise<void> => {
    if (typeof url === 'string' && isHttpUrl(url)) await shell.openExternal(url);
  });
}

// ── lifecycle ──

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.on('before-quit', () => {
    quitting = true;
    background.stopScheduler();
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  void app.whenReady().then(async () => {
    app.setName('CloudPennies');
    buildMenu();
    registerIpc();
    background.initBackground({ getWindow: () => win, showWindow });
    const saved = await creds.getSettings().catch(() => DEFAULT_SETTINGS);
    applySettings(saved);
    const hidden = keepsRunningInBackground() && (startHidden || (isMac && app.getLoginItemSettings().wasOpenedAtLogin));
    createWindow(!hidden);
    background.startScheduler();
    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // With "run in background" the window is hidden rather than closed, so this only fires when it is off.
    if (!isMac) app.quit();
  });
}
