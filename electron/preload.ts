// Preload: the only bridge between the sandboxed renderer and the main process.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Bridge, ScanProgress, Snapshot, UpdateStatus } from '../src/core/types';

const bridge: Bridge = {
  platform: process.platform,
  getConnection: () => ipcRenderer.invoke('cp:getConnection'),
  listProfiles: () => ipcRenderer.invoke('cp:listProfiles'),
  connect: (input) => ipcRenderer.invoke('cp:connect', input),
  disconnect: () => ipcRenderer.invoke('cp:disconnect'),
  getSettings: () => ipcRenderer.invoke('cp:getSettings'),
  saveSettings: (s) => ipcRenderer.invoke('cp:saveSettings', s),
  loadSnapshot: () => ipcRenderer.invoke('cp:loadSnapshot'),
  scan: () => ipcRenderer.invoke('cp:scan'),
  onScanProgress: (cb) => {
    const listener = (_e: IpcRendererEvent, p: ScanProgress) => cb(p);
    ipcRenderer.on('cp:scanProgress', listener);
    return () => {
      ipcRenderer.removeListener('cp:scanProgress', listener);
    };
  },
  query: (q) => ipcRenderer.invoke('cp:query', q),
  saveFile: (defaultName, content) => ipcRenderer.invoke('cp:saveFile', defaultName, content),
  openExternal: (url) => ipcRenderer.invoke('cp:openExternal', url),
  getHistory: () => ipcRenderer.invoke('cp:getHistory'),
  setSlackWebhook: (url) => ipcRenderer.invoke('cp:setSlackWebhook', url),
  hasSlackWebhook: () => ipcRenderer.invoke('cp:hasSlackWebhook'),
  testNotifications: () => ipcRenderer.invoke('cp:testNotifications'),
  getCurStatus: (refresh) => ipcRenderer.invoke('cp:getCurStatus', refresh === true),
  importCur: () => ipcRenderer.invoke('cp:importCur'),
  getAppInfo: () => ipcRenderer.invoke('cp:getAppInfo'),
  checkForUpdates: () => ipcRenderer.invoke('cp:checkForUpdates'),
  installUpdate: () => ipcRenderer.invoke('cp:installUpdate'),
  onUpdateStatus: (cb) => {
    const listener = (_e: IpcRendererEvent, s: UpdateStatus) => cb(s);
    ipcRenderer.on('cp:updateStatus', listener);
    return () => {
      ipcRenderer.removeListener('cp:updateStatus', listener);
    };
  },
  onNavigate: (cb) => {
    const listener = (_e: IpcRendererEvent, target: { page: 'anomalies' | 'commitments' | 'savings' | 'briefing'; focusId?: string }) => cb(target);
    ipcRenderer.on('cp:navigate', listener);
    return () => {
      ipcRenderer.removeListener('cp:navigate', listener);
    };
  },
  onSnapshotUpdated: (cb) => {
    const listener = (_e: IpcRendererEvent, snapshot: Snapshot) => cb(snapshot);
    ipcRenderer.on('cp:snapshotUpdated', listener);
    return () => {
      ipcRenderer.removeListener('cp:snapshotUpdated', listener);
    };
  },
};

contextBridge.exposeInMainWorld('cloudpennies', bridge);
