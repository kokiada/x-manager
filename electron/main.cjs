/**
 * x-manager — Electron shell.
 *
 * The app itself is the Vite web build (dist/). This process serves it
 * over plain HTTP on 127.0.0.1 (NOT file://) and opens it in a
 * BrowserWindow, for two reasons:
 *
 * 1. The Chrome extension's content scripts only match http(s) pages
 *    (http://localhost/*, http://127.0.0.1/*), so file:// would break
 *    the extension link. Serving on 127.0.0.1 keeps the extension
 *    working exactly as it does in the browser dev flow.
 * 2. The extension is loaded into this session automatically
 *    (session.loadExtension), so the user never has to install it
 *    into Chrome by hand. Its tokens live in this session's
 *    chrome.storage.local, on the user's PC only.
 *
 * Port: 47831 by default; if it is taken, the next free port is used.
 * The server binds 127.0.0.1 only — nothing is exposed to the LAN.
 */
'use strict';

const { app, BrowserWindow, Menu, dialog, ipcMain, session } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const BASE_PORT = 47831;
const PORT_SCAN_LIMIT = 50;
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;

let mainWindow = null;
let popupWindow = null;
let extensionId = null;
let server = null;
let serverPort = null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
};

function distDir() {
  return path.join(app.getAppPath(), 'dist');
}

function extensionDir() {
  // Packaged builds carry the extension unpacked in resources/
  // (see electron-builder extraResources); in dev it is the repo's
  // extension/ folder next to this file's parent.
  if (app.isPackaged) return path.join(process.resourcesPath, 'extension');
  return path.join(__dirname, '..', 'extension');
}

function sendFile(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

/** Static server for dist/ with an SPA fallback to index.html. */
function createServer(root) {
  return http.createServer((req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === '/') pathname = '/index.html';
      const filePath = path.join(root, pathname);
      // Never serve outside dist/.
      if (!filePath.startsWith(root + path.sep) && filePath !== root) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      fs.stat(filePath, (err, stat) => {
        if (!err && stat.isFile()) {
          sendFile(res, filePath);
          return;
        }
        // SPA fallback: unknown paths render the app shell.
        const indexPath = path.join(root, 'index.html');
        fs.stat(indexPath, (indexErr) => {
          if (indexErr) {
            res.writeHead(404);
            res.end('Not found');
            return;
          }
          sendFile(res, indexPath);
        });
      });
    } catch {
      res.writeHead(500);
      res.end('Internal error');
    }
  });
}

function listenOnFreePort(srv, port) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      if (err.code === 'EADDRINUSE' && port < BASE_PORT + PORT_SCAN_LIMIT) {
        srv.removeListener('error', onError);
        resolve(listenOnFreePort(srv, port + 1));
      } else {
        reject(err);
      }
    };
    srv.once('error', onError);
    srv.listen(port, '127.0.0.1', () => {
      srv.removeListener('error', onError);
      resolve(port);
    });
  });
}

async function loadExtension() {
  const dir = extensionDir();
  if (!fs.existsSync(path.join(dir, 'manifest.json'))) {
    console.warn(`[x-manager] extension not found at ${dir}; running without it.`);
    return null;
  }
  try {
    const ext = await session.defaultSession.loadExtension(dir, {
      allowFileAccess: true,
    });
    console.log(`[x-manager] extension loaded: ${ext.name} (${ext.id})`);
    return ext.id;
  } catch (err) {
    console.error('[x-manager] failed to load extension:', err);
    return null;
  }
}

function openExtensionPopup() {
  if (!extensionId) {
    dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'x-manager',
      message: '拡張が読み込まれていません。',
      detail:
        '実行役の拡張が読み込めなかったため、連携画面を開けません。アプリを再起動するか、Chrome 版の拡張を手動で読み込んでください。',
    });
    return;
  }
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.focus();
    return;
  }
  popupWindow = new BrowserWindow({
    width: 380,
    height: 600,
    title: 'x-manager 実行役 — アカウント連携',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true },
  });
  popupWindow.loadURL(`chrome-extension://${extensionId}/src/popup.html`);
  popupWindow.on('closed', () => {
    popupWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: '拡張',
      submenu: [
        {
          label: '連携画面を開く（auth_token 登録）',
          click: openExtensionPopup,
        },
        { type: 'separator' },
        {
          label: '開発者ツール',
          accelerator: 'Ctrl+Shift+I',
          click: () => {
            if (mainWindow) mainWindow.webContents.toggleDevTools();
          },
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createMainWindow(url) {
  mainWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    title: 'x-manager',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadURL(url);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

async function start() {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  await app.whenReady();

  const root = distDir();
  if (!fs.existsSync(path.join(root, 'index.html'))) {
    dialog.showErrorBox(
      'x-manager',
      'Webアプリのビルド（dist/）が見つかりません。\n先に `npm run build` を実行してください。',
    );
    app.quit();
    return;
  }

  server = createServer(root);
  try {
    serverPort = await listenOnFreePort(server, BASE_PORT);
  } catch (err) {
    dialog.showErrorBox('x-manager', `ローカルサーバーを起動できませんでした。\n${err.message}`);
    app.quit();
    return;
  }
  console.log(`[x-manager] serving dist/ at http://127.0.0.1:${serverPort}/`);

  extensionId = await loadExtension();

  ipcMain.handle('open-extension-popup', () => {
    openExtensionPopup();
  });

  buildMenu();
  createMainWindow(`http://127.0.0.1:${serverPort}/`);
}

app.on('window-all-closed', () => {
  // This app targets Windows; quit when the last window closes.
  app.quit();
});

app.on('before-quit', () => {
  if (server) server.close();
});

start().catch((err) => {
  console.error('[x-manager] startup failed:', err);
  app.quit();
});
