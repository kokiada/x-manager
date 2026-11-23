/**
 * D-06: デスクトップブリッジ — preload。
 *
 * レンダラ（アプリ画面）に `window.xManagerDesktop.invoke` だけを
 * 公開する薄い層。nodeIntegration は無効のまま、contextBridge 経由で
 * ipcRenderer.invoke('xmanager:bridge', message) へ中継する。
 * トークンや Electron の実物はレンダラに渡さない。
 * （詳しくは docs/DESKTOP_BRIDGE.md）
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('xManagerDesktop', {
  invoke: (message) => ipcRenderer.invoke('xmanager:bridge', message),
});
