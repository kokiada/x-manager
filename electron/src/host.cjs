/**
 * D-02: Electron 最小ホスト — ウィンドウ生成とスモーク実行。
 *
 * electron モジュールは引数で受ける（テストでは偽物に差し替え）。
 * 最小ホストは x.com を開くのが既定。--url で https の URL を
 * 指定できる（表示確認用。手元環境では x.com への通信が遮断
 * されるため、疎通確認は到達可能な https ページで行う）。
 */
'use strict';

const fs = require('node:fs');
const { partitionName } = require('./partition.cjs');
const { configureSession } = require('./session.cjs');

const X_URL = 'https://x.com/';
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const SMOKE_TIMEOUT_MS = 30000;
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

/** コマンドライン引数を読む。既定は smoke アカウント・x.com・通常起動。 */
function parseArgs(argv) {
  let accountId = 'smoke';
  let url = X_URL;
  let smoke = false;
  let proxy = null;
  let verifySession = false;
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
    } else {
      throw new Error(`未知のフラグです：${arg}`);
    }
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`URLが不正です：${url}`);
  }
  if (parsed.protocol !== 'https:') {
    throw new Error(`URLは https である必要があります：${url}`);
  }
  // アカウントIDの検証は partitionName に任せるが、ここでも早めに弾く。
  partitionName(accountId);
  return { accountId, url, smoke, proxy, verifySession };
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

module.exports = {
  X_URL,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  SMOKE_TIMEOUT_MS,
  parseArgs,
  parseProxyArg,
  createHostWindow,
  runSmoke,
};
