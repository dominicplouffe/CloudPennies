// CloudPennies — Electron main process.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { CostQuery, CostResult, CredentialInput, ScanProgress, Settings, Snapshot } from '../src/core/types';
import { errMessage } from './aws/errors';
import { createLiveSource, loadCachedSnapshot } from './aws/source';
import * as creds from './credentials';

const DEV_URL = process.env.VITE_DEV_SERVER_URL;
const INDEX_HTML = path.join(__dirname, '../dist/index.html');
const isMac = process.platform === 'darwin';

let win: BrowserWindow | null = null;

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

function createWindow(): void {
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
  win.once('ready-to-show', () => win?.show());
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
  const settings = await creds.getSettings();
  return createLiveSource({ credentials: conn.credentials, identity: conn.identity, settings, cacheDir: creds.cacheDir() });
}

let scanInFlight: Promise<{ ok: true; snapshot: Snapshot } | { ok: false; error: string }> | null = null;

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
  handle('cp:connect', (input: CredentialInput) => creds.connect(input));
  handle('cp:disconnect', () => creds.disconnect());
  handle('cp:getSettings', () => creds.getSettings());
  handle('cp:saveSettings', (s: Settings) => creds.saveSettings(s));

  handle('cp:loadSnapshot', async (): Promise<Snapshot | null> => {
    const conn = await creds.getConnection();
    if (!conn.connected || !conn.accountId) return null;
    return loadCachedSnapshot(creds.cacheDir(), conn.accountId);
  });

  handle('cp:scan', () => {
    scanInFlight ??= (async () => {
      try {
        const source = await liveSource();
        if (!source) return { ok: false as const, error: 'Connect an AWS account first.' };
        const snapshot = await source.scan((p: ScanProgress) => {
          if (win && !win.isDestroyed()) win.webContents.send('cp:scanProgress', p);
        });
        return { ok: true as const, snapshot };
      } catch (e) {
        return { ok: false as const, error: errMessage(e) || 'The scan failed.' };
      } finally {
        scanInFlight = null;
      }
    })();
    return scanInFlight;
  });

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
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });

  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });

  void app.whenReady().then(() => {
    app.setName('CloudPennies');
    buildMenu();
    registerIpc();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (!isMac) app.quit();
  });
}
