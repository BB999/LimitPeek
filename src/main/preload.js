'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getSnapshot: () => ipcRenderer.invoke('get-snapshot'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  refreshNow: () => ipcRenderer.invoke('refresh-now'),
  saveSettings: (next) => ipcRenderer.invoke('save-settings', next),
  quit: () => ipcRenderer.send('quit-app'),
  reportHeight: (h) => ipcRenderer.send('report-height', h),
  onSnapshot: (cb) => ipcRenderer.on('snapshot', (_e, snap) => cb(snap)),
  onSettings: (cb) => ipcRenderer.on('settings', (_e, s) => cb(s)),

  // 自動更新
  getUpdateState: () => ipcRenderer.invoke('get-update-state'),
  checkUpdate: () => ipcRenderer.invoke('check-update'),
  applyUpdate: () => ipcRenderer.invoke('apply-update'),
  onUpdateState: (cb) => ipcRenderer.on('update-state', (_e, s) => cb(s)),

  // Tray 画像合成用（trayicon.html 専用）
  trayReady: () => ipcRenderer.send('tray-ready'),
  onRenderTray: (cb) => ipcRenderer.on('render-tray', (_e, payload) => cb(payload)),
  sendTrayImage: (payload) => ipcRenderer.send('tray-image', payload),
});
