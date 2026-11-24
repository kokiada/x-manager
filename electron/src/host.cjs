/**
 * D-02: Electron 最小ホスト — ウィンドウ生成とスモーク実行。
 *
 * electron モジュールは引数で受ける（テストでは偽物に差し替え）。
 * 最小ホストは x.com を開くのが既定。--url で https の URL を
 * 指定できる（表示確認用。手元環境では x.com への通信が遮断
 * されるため、疎通確認は到達可能な https ページで行う）。
 *
 * P1-01: --app でビルド済みアプリ（dist/index.html）を、
 * --app-dev で開発サーバー（http://localhost:5173/）を、
 * preload ブリッジ付きで開く。--hello-check はアプリ画面で
 * hello ハンドシェイクを実ホストで確かめる（結果を JSON で出す）。
 * ビルド済みアプリは file:// で読むため、vite の base は './'
 * にしてある（絶対パスのアセットでは file:// で読めない）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { partitionName } = require('./partition.cjs');
const { configureSession } = require('./session.cjs');
const { DESKTOP_HOST_SOURCE, PROTOCOL_VERSION } = require('./bridge.cjs');

const X_URL = 'https://x.com/';
/** P1-01: 開発サーバーで動くアプリ画面の URL（`npm run dev`）。 */
const APP_DEV_URL = 'http://localhost:5173/';
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const SMOKE_TIMEOUT_MS = 30000;
const HELLO_CHECK_TIMEOUT_MS = SMOKE_TIMEOUT_MS;
const PROXY_URL_SCHEMES = ['http:', 'https:', 'socks5:'];

/** --proxy の値をプロキシ設定に変換する。port 必須。 */
function parseProxyArg(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`プロキシの URL が不正です：${value}`);
  }
  if (!PROXY_URL_SCHEMES.includes(parsed.protocol)) {
    throw new Error(`プロキシの scheme が不正です：${parsed.protocol}（http / https / socks5 のみ）。`);
  }
  if (!parsed.hostname) {
    throw new Error(`プロキシの host がありません：${value}`);
  }
  const port = Number(parsed.port);
  if (!parsed.port || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`プロキシの port が不正です：${value}`);
  }
  const proxy = { scheme: parsed.protocol.slice(0, -1), host: parsed.hostname, port };
  if (parsed.username) proxy.username = decodeURIComponent(parsed.username);
  if (parsed.password) proxy.password = decodeURIComponent(parsed.password);
  return proxy;
}

/** P1-01: ビルド済みアプリ（dist/index.html）の file:// URL を返す。無ければビルドを促す。 */
function appFileUrl(repoRoot = path.join(__dirname, '..', '..')) {
  const indexPath = path.join(repoRoot, 'dist', 'index.html');
  if (!fs.existsSync(indexPath)) {
    throw new Error(`ビルド済みアプリが見つかりません：${indexPath}。先に npm run build を実行してください。`);
  }
  return pathToFileURL(indexPath).href;
}

/** コマンドライン引数を読む。既定は smoke アカウント・x.com・通常起動。 */
function parseArgs(argv) {
  let accountId = 'smoke';
  let url = X_URL;
  let urlFlag = false;
  let smoke = false;
  let proxy = null;
  let verifySession = false;
  let readCheck = false;
  let postCheck = false;
  let postText = null;
  let appMode = null;
  let helloCheck = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--account') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--account の値がありません。');
      accountId = value;
      i += 1;
    } else if (arg === '--url') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--url の値がありません。');
      url = value;
      urlFlag = true;
      i += 1;
    } else if (arg === '--proxy') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--proxy の値がありません。');
      proxy = parseProxyArg(value);
      i += 1;
    } else if (arg === '--smoke') {
      smoke = true;
    } else if (arg === '--verify-session') {
      verifySession = true;
    } else if (arg === '--read-check') {
      readCheck = true;
    } else if (arg === '--post-check') {
      postCheck = true;
    } else if (arg === '--text') {
      const value = argv[i + 1];
      if (value === undefined) throw new Error('--text の値がありません。');
      postText = value;
      i += 1;
    } else if (arg === '--app') {
      if (appMode !== null) throw new Error('--app と --app-dev は同時に指定できません。');
      appMode = 'built';
    } else if (arg === '--app-dev') {
      if (appMode !== null) throw new Error('--app と --app-dev は同時に指定できません。');
      appMode = 'dev';
    } else if (arg === '--hello-check') {
      helloCheck = true;
    } else {
      throw new Error(`未知のフラグです：${arg}`);
    }
  }
  if (postCheck && !postText) {
    throw new Error('--post-check には --text が必要です。');
  }
  if (appMode !== null && urlFlag) {
    throw new Error('--app / --app-dev と --url は同時に指定できません。');
  }
  if (helloCheck && appMode === null) {
    throw new Error('--hello-check には --app または --app-dev が必要です。');
  }
  if (appMode === 'built') {
    url = appFileUrl();
  } else if (appMode === 'dev') {
    url = APP_DEV_URL;
  }
  // --url / 既定の URL は https 必須。アプリの URL
  // （file:// のビルド済みアプリ、http://localhost:5173）は
  // ここでは弾かない（ホストが開く自前の画面のため）。
  if (appMode === null) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`URLが不正です：${url}`);
    }
    if (parsed.protocol !== 'https:') {
      throw new Error(`URLは https である必要があります：${url}`);
    }
  }
  // アカウントIDの検証は partitionName に任せるが、ここでも早めに弾く。
  partitionName(accountId);
  return { accountId, url, smoke, proxy, verifySession, readCheck, postCheck, postText, appMode, helloCheck };
}

/**
 * partition 付きのウィンドウを作り、URL を開く。
 * proxy / cookies を渡すと、読み込み前に partition の session へ
 * 設定する（D-03）。渡さなければ D-02 どおり何も設定しない。
 * webPreferences は最小限＋安全側：nodeIntegration 無効、
 * contextIsolation 有効、sandbox 有効。
 */
async function createHostWindow(electron, { accountId, url, proxy = undefined, cookies = undefined }) {
  const partition = partitionName(accountId);
  const sess = electron.session.fromPartition(partition);
  await configureSession(sess, { proxy, cookies });
  const win = new electron.BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    title: 'x-manager — x.com',
    webPreferences: {
      partition,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // D-06: デスクトップブリッジの preload。レンダラに
      // window.xManagerDesktop.invoke だけを公開する。
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  await win.loadURL(url);
  return { window: win, session: sess };
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== null) clearTimeout(timer);
  });
}

/**
 * スモーク実行：ウィンドウを作って読み込み、タイトルと URL を返す。
 * 読み込み失敗時は例外を投げず { ok: false, error } を返す。
 * screenshotPath を渡すと capturePage の PNG を保存する。
 */
async function runSmoke(
  electron,
  { accountId, url, proxy = undefined, cookies = undefined, timeoutMs = SMOKE_TIMEOUT_MS, screenshotPath = null },
) {
  try {
    const { window: win } = await withTimeout(
      createHostWindow(electron, { accountId, url, proxy, cookies }),
      timeoutMs,
      '読み込みがタイムアウトしました',
    );
    const title = win.webContents.getTitle();
    const currentUrl = win.webContents.getURL();
    let screenshot = null;
    if (screenshotPath) {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(screenshotPath, image.toPNG());
      screenshot = screenshotPath;
    }
    return { ok: true, title, url: currentUrl, screenshot };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * P1-01: hello ハンドシェイク確認。アプリ画面を開き、ページ文脈で
 * window.xManagerDesktop.invoke に hello を送り、hello-ack が返る
 * ことを確かめる（preload → ipcMain → ブリッジハンドラの往復）。
 * 失敗時は例外を投げず { ok: false, error } を返す。
 * screenshotPath を渡すと capturePage の PNG を保存する。
 */
async function runHelloCheck(
  electron,
  { accountId, url, proxy = undefined, cookies = undefined, timeoutMs = HELLO_CHECK_TIMEOUT_MS, screenshotPath = null },
) {
  try {
    const { window: win } = await withTimeout(
      createHostWindow(electron, { accountId, url, proxy, cookies }),
      timeoutMs,
      '読み込みがタイムアウトしました',
    );
    const title = win.webContents.getTitle();
    const currentUrl = win.webContents.getURL();
    const ack = await withTimeout(
      win.webContents.executeJavaScript(
        `(() => { if (!window.xManagerDesktop) throw new Error('デスクトップブリッジが見つかりません（window.xManagerDesktop がありません）。'); return window.xManagerDesktop.invoke({ source: 'x-manager', kind: 'hello', version: ${PROTOCOL_VERSION} }); })()`,
      ),
      timeoutMs,
      'hello ハンドシェイクがタイムアウトしました',
    );
    if (
      typeof ack !== 'object' ||
      ack === null ||
      ack.source !== DESKTOP_HOST_SOURCE ||
      ack.kind !== 'hello-ack' ||
      ack.version !== PROTOCOL_VERSION ||
      typeof ack.hostVersion !== 'string' ||
      ack.hostVersion.length === 0
    ) {
      return { ok: false, error: 'デスクトップホストからの hello-ack の形が不正です。' };
    }
    let screenshot = null;
    if (screenshotPath) {
      const image = await win.webContents.capturePage();
      fs.writeFileSync(screenshotPath, image.toPNG());
      screenshot = screenshotPath;
    }
    return { ok: true, hostVersion: ack.hostVersion, title, url: currentUrl, screenshot };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

module.exports = {
  X_URL,
  APP_DEV_URL,
  HELLO_CHECK_TIMEOUT_MS,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  SMOKE_TIMEOUT_MS,
  appFileUrl,
  parseArgs,
  parseProxyArg,
  createHostWindow,
  runHelloCheck,
  runSmoke,
};
