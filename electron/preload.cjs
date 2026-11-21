/**
 * Preload for the x-manager Electron window.
 * Exposes the smallest possible bridge: a flag so the web app can
 * tell it is running inside Electron, and a way to open the
 * extension's link (auth_token registration) window.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  openExtensionPopup: () => ipcRenderer.invoke('open-extension-popup'),
});
