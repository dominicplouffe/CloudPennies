// Preload: the only bridge between the sandboxed renderer and the main process.
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { Bridge, ScanProgress } from '../src/core/types';

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
};

contextBridge.exposeInMainWorld('cloudpennies', bridge);
