// Pure auto-update decisions. No Electron, no network.
import { describe, expect, it, vi } from 'vitest';
import {
  RELEASE_URL,
  UNSUPPORTED_MESSAGE,
  canSelfUpdate,
  errorText,
  nextStatus,
  planAfterFound,
  shouldAutoCheck,
  unsupportedStatus,
  type UpdaterContext,
  type UpdaterEnv,
  type UpdaterEvent,
} from '../electron/updaterLogic';
import type { UpdateStatus } from '../src/core/types';

vi.mock('electron', () => ({ app: { getPath: () => '/nonexistent' }, safeStorage: { isEncryptionAvailable: () => false } }));

const mac: UpdaterEnv = { packaged: true, platform: 'darwin', appImage: false };
const win: UpdaterEnv = { packaged: true, platform: 'win32', appImage: false };
const appImage: UpdaterEnv = { packaged: true, platform: 'linux', appImage: true };
const tarball: UpdaterEnv = { packaged: true, platform: 'linux', appImage: false };
const source: UpdaterEnv = { packaged: false, platform: 'darwin', appImage: false };

const ctx = (env: UpdaterEnv, autoUpdate = true): UpdaterContext => ({ env, autoUpdate });
const run = (events: UpdaterEvent[], c: UpdaterContext, start: UpdateStatus = { state: 'idle' }): UpdateStatus => events.reduce((s, e) => nextStatus(s, e, c), start);

describe('what a build may do', () => {
  it('only a packaged build checks by itself, and only with the setting on', () => {
    expect(shouldAutoCheck(mac, true)).toBe(true);
    expect(shouldAutoCheck(tarball, true)).toBe(true);
    expect(shouldAutoCheck(mac, false)).toBe(false);
    expect(shouldAutoCheck(source, true)).toBe(false);
  });

  it('macOS, Windows and an AppImage can replace themselves; other Linux packages and source runs cannot', () => {
    expect(canSelfUpdate(mac)).toBe(true);
    expect(canSelfUpdate(win)).toBe(true);
    expect(canSelfUpdate(appImage)).toBe(true);
    expect(canSelfUpdate(tarball)).toBe(false);
    expect(canSelfUpdate(source)).toBe(false);
    expect(canSelfUpdate({ packaged: true, platform: 'freebsd', appImage: false })).toBe(false);
  });

  it('downloads only when the setting is on and the build can install the result', () => {
    expect(planAfterFound(mac, true)).toBe('download');
    expect(planAfterFound(win, true)).toBe('download');
    expect(planAfterFound(appImage, true)).toBe('download');
    expect(planAfterFound(mac, false)).toBe('manual');
    expect(planAfterFound(tarball, true)).toBe('manual');
    expect(planAfterFound(source, true)).toBe('manual');
  });
});

describe('status after updater events', () => {
  it('a source build is always unsupported', () => {
    expect(unsupportedStatus()).toEqual({ state: 'unsupported', message: UNSUPPORTED_MESSAGE });
    expect(nextStatus({ state: 'idle' }, { type: 'checking' }, ctx(source))).toEqual(unsupportedStatus());
    expect(nextStatus({ state: 'idle' }, { type: 'found', version: '9.9.9' }, ctx(source))).toEqual(unsupportedStatus());
  });

  it('checking, then up to date', () => {
    expect(run([{ type: 'checking' }], ctx(mac))).toEqual({ state: 'checking' });
    expect(run([{ type: 'checking' }, { type: 'not-available' }], ctx(mac))).toEqual({ state: 'up-to-date' });
  });

  it('found, downloading with progress, ready', () => {
    const c = ctx(win);
    let s = run([{ type: 'checking' }, { type: 'found', version: '1.2.0' }], c);
    expect(s).toEqual({ state: 'downloading', version: '1.2.0', percent: 0 });
    s = nextStatus(s, { type: 'progress', percent: 41.6 }, c);
    expect(s).toEqual({ state: 'downloading', version: '1.2.0', percent: 42 });
    // progress never goes backwards and stays within 0-100
    expect(nextStatus(s, { type: 'progress', percent: 10 }, c).percent).toBe(42);
    expect(nextStatus(s, { type: 'progress', percent: 250 }, c).percent).toBe(100);
    expect(nextStatus(s, { type: 'progress', percent: Number.NaN }, c).percent).toBe(42);
    s = nextStatus(s, { type: 'downloaded' }, c);
    expect(s).toEqual({ state: 'ready', version: '1.2.0' });
    // a straggling progress event does not undo "ready"
    expect(nextStatus(s, { type: 'progress', percent: 99 }, c)).toBe(s);
  });

  it('with automatic updates off a found version is only announced, with the releases page', () => {
    const s = run([{ type: 'checking' }, { type: 'found', version: '1.2.0' }], ctx(mac, false));
    expect(s.state).toBe('available');
    expect(s.version).toBe('1.2.0');
    expect(s.releaseUrl).toBe(RELEASE_URL);
    expect(s.message).toMatch(/turned off/);
  });

  it('a Linux build that is not an AppImage points at the releases page, whatever the setting', () => {
    for (const autoUpdate of [true, false]) {
      const s = run([{ type: 'checking' }, { type: 'found', version: '1.2.0' }], ctx(tarball, autoUpdate));
      expect(s).toMatchObject({ state: 'available', version: '1.2.0', releaseUrl: RELEASE_URL });
      expect(s.message).toMatch(/AppImage/);
    }
    expect(run([{ type: 'found', version: '1.2.0' }], ctx(appImage)).state).toBe('downloading');
  });

  it('an unsigned macOS build: the failed download becomes a manual download, not an error', () => {
    const c = ctx(mac);
    const signature = new Error('Could not get code signature for running application');
    const s = run([{ type: 'checking' }, { type: 'found', version: '1.2.0' }, { type: 'progress', percent: 100 }, { type: 'error', error: signature }], c);
    expect(s.state).toBe('available');
    expect(s.version).toBe('1.2.0');
    expect(s.releaseUrl).toBe(RELEASE_URL);
    expect(s.message).toMatch(/not signed by Apple/);
    expect(s.message).toContain('Could not get code signature');
    // the same failure reported twice (event + rejected promise) changes nothing, and neither does a late "downloaded"
    expect(nextStatus(s, { type: 'error', error: signature }, c)).toBe(s);
    expect(nextStatus(s, { type: 'downloaded' }, c)).toBe(s);
  });

  it('a failed install after "ready" also falls back to the manual download', () => {
    const c = ctx(win);
    const s = run([{ type: 'found', version: '1.2.0' }, { type: 'downloaded' }, { type: 'error', error: new Error('spawn EACCES') }], c);
    expect(s).toMatchObject({ state: 'available', version: '1.2.0', releaseUrl: RELEASE_URL });
    expect(s.message).not.toMatch(/Apple/);
  });

  it('a failed check is an error, unless a newer version is already known', () => {
    const c = ctx(mac);
    const offline = Object.assign(new Error('net::ERR_INTERNET_DISCONNECTED'), {});
    expect(run([{ type: 'checking' }, { type: 'error', error: offline }], c)).toEqual({ state: 'error', message: 'GitHub could not be reached. Check your internet connection.' });
    const known: UpdateStatus = { state: 'available', version: '1.2.0', releaseUrl: RELEASE_URL, message: 'x' };
    expect(nextStatus(known, { type: 'error', error: offline }, c)).toBe(known);
  });
});

describe('errorText', () => {
  it('names a missing release file plainly', () => {
    expect(errorText(Object.assign(new Error('Cannot find latest-mac.yml ...'), { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' }))).toBe('No published update information was found on GitHub.');
    expect(errorText(new Error('404 Not Found\nurl: https://github.com/...\nHeaders: {...}'))).toBe('No published update information was found on GitHub.');
  });

  it('keeps one short line and never a stack or headers', () => {
    const e = new Error(`sha512 checksum mismatch\n    at foo (bar.js:1:1)\nHeaders: {"authorization":"secret"}`);
    expect(errorText(e)).toBe('sha512 checksum mismatch');
    expect(errorText(new Error('x'.repeat(500))).length).toBe(200);
    expect(errorText(undefined)).toBe('Unknown error.');
    expect(errorText('plain text')).toBe('plain text');
  });
});

describe('settings', () => {
  it('autoUpdate defaults to on and only accepts booleans', async () => {
    const { sanitizeSettings } = await import('../electron/credentials');
    expect(sanitizeSettings({}).autoUpdate).toBe(true);
    expect(sanitizeSettings({ autoUpdate: false }).autoUpdate).toBe(false);
    expect(sanitizeSettings({ autoUpdate: 'no' }).autoUpdate).toBe(true);
  });
});
