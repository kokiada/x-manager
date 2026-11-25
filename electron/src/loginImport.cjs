/**
 * P1-03: セッションの取り込み — ログイン→取り込みフロー。
 *
 * デスクトップ方式では auth_token を手入力で取得しない。アカウント
 * ごとの partition でログイン用ウィンドウを開き、ユーザーが x.com
 * に普通にログインすると、X が発行した auth_token / ct0 がその
 * partition の Cookie として保存される。ホストは Cookie の出現を
 * ポーリングで検知し、ログイン中のアカウントを読み取り（D-04 の
 * ページ文脈 fetch）で確定して { id, handle } だけを返す。
 *
 * セキュリティ：
 * - ログイン用ウィンドウにはブリッジの preload を付けない。
 *   x.com のページ文脈から `window.xManagerDesktop.invoke` に
 *   届いてはならないため。partition / contextIsolation /
 *   nodeIntegration 無効 / sandbox 有効は createHostWindow と同じ。
 * - 返り値・ログにトークンの値は含めない。Cookie の有無と
 *   ID・ハンドルだけを扱う。
 *
 * Electron の実物は引数・deps で受ける（テストでは偽物に差し替え）。
 */
'use strict';

const { partitionName } = require('./partition.cjs');
const { configureSession, getSessionStatus } = require('./session.cjs');
const { runReadCheck, READ_CHECK_TIMEOUT_MS } = require('./readCheck.cjs');

const LOGIN_URL = 'https://x.com/i/flow/login';
const LOGIN_IMPORT_TIMEOUT_MS = 300000;
const LOGIN_POLL_INTERVAL_MS = 2000;
const LOGIN_WINDOW_WIDTH = 1000;
const LOGIN_WINDOW_HEIGHT = 760;
const LOGIN_TIMEOUT_ERROR =
  'ログインが完了しませんでした（時間切れ）。x.com にログインしてからもう一度お試しください。';
const LOGIN_WINDOW_CLOSED_ERROR =
  'ログイン用ウィンドウが閉じられました。もう一度お試しください。';

/** ログイン用ウィンドウを作る（preload なし。理由は冒頭の注記参照）。 */
async function createLoginWindow(electron, { accountId, session: sess, url = LOGIN_URL }) {
  const win = new electron.BrowserWindow({
    width: LOGIN_WINDOW_WIDTH,
    height: LOGIN_WINDOW_HEIGHT,
    title: 'x-manager — X にログイン',
    webPreferences: {
      partition: partitionName(accountId),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // session は呼び出し側で partition から取り、proxy を設定済み。
  // ここではウィンドウの partition がその session と一致することだけ
  // を前提にする（BrowserWindow は webPreferences.partition で決まる）。
  void sess;
  // 読み込み失敗（証明書エラー・ネットワーク断など）でここが弾けると、
  // ログインの機会そのものが無くなる。ウィンドウは開いたままにし、
  // ユーザーが再読み込みできるようにする。ログインが完了しなければ
  // 待ち時間のタイムアウトで失敗が返る。
  try {
    await win.loadURL(url);
  } catch {
    // 読み込み失敗は結果にしない（ポーリングのタイムアウトに任せる）。
  }
  return win;
}

/**
 * auth_token の出現をポーリングで待つ。現れたら true、制限時間を
 * 過ぎたら false を返す。getStatus は { hasAuthToken } を返す非同期
 * 関数。now / sleep は注入可能（テストで時間を進めるため）。
 */
async function waitForAuthToken(
  getStatus,
  {
    timeoutMs = LOGIN_IMPORT_TIMEOUT_MS,
    intervalMs = LOGIN_POLL_INTERVAL_MS,
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const status = await getStatus();
    if (status && status.hasAuthToken) return true;
    if (now() >= deadline) return false;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - now())));
  }
}

/** ウィンドウを閉じる（既に閉じていても例外にしない）。 */
function closeWindow(win) {
  if (!win) return;
  try {
    if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
    if (typeof win.close === 'function') win.close();
  } catch {
    // 閉じられなくても結果は返す。
  }
}

/**
 * ログイン→取り込みを実行する。partition のセッションを用意し、
 * ログイン用ウィンドウを開いて x.com のログインフローを表示する。
 * ログイン完了（auth_token の出現）を検知したらウィンドウを閉じ、
 * ログイン中のアカウントを読み取りで確定する。
 *
 * 成功時は { ok: true, accountId, xUserId, handle }、
 * 失敗時は { ok: false, accountId, error } を返す。
 * トークンの値は結果に含めない。
 *
 * deps で差し替え可能：
 *  - createLoginWindow(electron, { accountId, session })
 *  - getSessionStatus(session)（既定は session.cjs のもの）
 *  - readIdentity(webContents)（既定は readCheck.cjs の runReadCheck）
 *  - now / sleep（waitForAuthToken へ渡す）
 */
async function runLoginImport(
  electron,
  { accountId, proxy = undefined, timeoutMs = LOGIN_IMPORT_TIMEOUT_MS, deps = {} } = {},
) {
  const createWindow = deps.createLoginWindow ?? createLoginWindow;
  const getStatus = deps.getSessionStatus ?? getSessionStatus;
  const readIdentity = deps.readIdentity ?? ((webContents) => runReadCheck(webContents));
  let win = null;
  try {
    const sess = electron.session.fromPartition(partitionName(accountId));
    await configureSession(sess, { proxy });
    win = await createWindow(electron, { accountId, session: sess });
    let loggedIn;
    try {
      loggedIn = await waitForAuthToken(
        async () => {
          if (win && typeof win.isDestroyed === 'function' && win.isDestroyed()) {
            throw new Error(LOGIN_WINDOW_CLOSED_ERROR);
          }
          return getStatus(sess);
        },
        { timeoutMs, now: deps.now, sleep: deps.sleep },
      );
    } catch (err) {
      if (err instanceof Error && err.message === LOGIN_WINDOW_CLOSED_ERROR) {
        return { ok: false, accountId, error: LOGIN_WINDOW_CLOSED_ERROR };
      }
      throw err;
    }
    if (!loggedIn) {
      return { ok: false, accountId, error: LOGIN_TIMEOUT_ERROR };
    }
    const identity = await readIdentity(win.webContents, {
      timeoutMs: READ_CHECK_TIMEOUT_MS,
    });
    if (!identity || !identity.ok) {
      return {
        ok: false,
        accountId,
        error:
          (identity && identity.error) ||
          'ログイン中のアカウントを確認できませんでした。x.com にログインし直すか、もう一度お試しください。',
      };
    }
    return { ok: true, accountId, xUserId: identity.id, handle: identity.handle };
  } catch (err) {
    return { ok: false, accountId, error: err instanceof Error ? err.message : String(err) };
  } finally {
    closeWindow(win);
  }
}

module.exports = {
  LOGIN_URL,
  LOGIN_IMPORT_TIMEOUT_MS,
  LOGIN_POLL_INTERVAL_MS,
  LOGIN_TIMEOUT_ERROR,
  LOGIN_WINDOW_CLOSED_ERROR,
  createLoginWindow,
  waitForAuthToken,
  runLoginImport,
};
