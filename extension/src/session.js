/**
 * アカウント別セッションの切替。
 *
 * X のセッションはブラウザ全体で共有される Cookie（auth_token・ct0）で
 * 決まるため、2つのアカウントのジョブが交ざると Cookie の取り違えに
 * なる。`withSession` は全ジョブを1本の直列キューに並べ、ジョブごとに
 * そのアカウントの Cookie をセットしてから実行する。
 *
 * 注意：Cookie は拡張とユーザーの x.com タブで共有される。実行中は
 * x.com のタブを操作しないこと。別プロファイルで拡張を動かすのが
 * いちばん安全（docs/REAL_X_DESIGN.md 参照）。
 *
 * deps: { sessions, chrome, fetchImpl, forceRefreshCt0?, ct0TimeoutMs?, queueTimeoutMs? }
 *  - sessions: sessionStore.js と同じ get / setCt0 を持つもの
 *  - chrome: chrome.cookies を持つもの（実物 or テスト用スタブ）
 *  - fetchImpl: ct0 取得のための fetch（実物 or テスト用スタブ）
 *  - ct0TimeoutMs: ct0 取得のタイムアウト（既定10秒）
 *  - queueTimeoutMs: 1ジョブの実行タイムアウト（既定28秒）。
 *    時間切れでも直列キューが詰まらないよう、待っているジョブを
 *    切り離す。遅れて動き出した処理は、Cookie の書き換えや
 *    Xへの実行を行わない（cancelled フラグで止める）。
 */
'use strict';

/* global self */

const X_COOKIE_URL = 'https://x.com';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

let queue = Promise.resolve();

const XManagerSession = {
  /**
   * `chrome.cookies`（set/get）が使えるかどうか。拡張の再読み込み
   * 直後や Service Worker の異常状態では `chrome.cookies` 自体が
   * undefined になることがあり、そのまま `.set` を読むと生の
   * TypeError（`Cannot read properties of undefined (reading 'set')`）
   * が画面に出てしまう。ジョブ実行前にここで確かめる。
   */
  cookiesApiAvailable(chromeApi) {
    return !!(
      chromeApi &&
      chromeApi.cookies &&
      typeof chromeApi.cookies.set === 'function' &&
      typeof chromeApi.cookies.get === 'function'
    );
  },

  /**
   * アカウントのセッションで fn({authToken, ct0}) を直列に実行する。
   * セッションが無ければ no_session、Cookie API が使えなければ
   * extension_broken、ct0 が取れなければ x_error を投げる。
   *
   * 1ジョブの実行が時間切れ（既定28秒）になっても、直列キューが
   * 詰まらないよう切り離す。アプリ側のジョブタイムアウト（30秒）
   * より先に、ここで時間切れのエラーを返す。
   */
  withSession(accountId, fn, deps) {
    const task = queue.then(() => runSessionWithTimeout(accountId, fn, deps));
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  },
};

/** 1ジョブの実行にタイムアウトを付け、時間切れでもキューを進める。 */
async function runSessionWithTimeout(accountId, fn, deps) {
  const errors = self.XManagerErrors;
  const timeoutMs =
    typeof deps.queueTimeoutMs === 'number' ? deps.queueTimeoutMs : 28_000;
  const cancelled = { value: false };
  const work = runSession(accountId, fn, { ...deps, cancelled });
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          cancelled.value = true;
          reject(
            errors.makeError(
              'unknown',
              '拡張の処理が時間切れになりました。拡張を再読み込みしてから再試行してください。',
            ),
          );
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runSession(accountId, fn, deps) {
  const errors = self.XManagerErrors;
  const session = await deps.sessions.get(accountId);
  if (!session || !session.authToken) {
    throw errors.makeError(
      'no_session',
      'このアカウントは拡張に連携されていません。ポップアップから auth_token を登録してください。',
    );
  }
  // Cookie API が使えないまま進むと `chrome.cookies.set` で生の
  // TypeError になる。ここで止めて、再読み込みを促す文言を返す。
  // 文言はアプリ側の EXTENSION_COOKIES_UNAVAILABLE_MESSAGE と同じ。
  if (!XManagerSession.cookiesApiAvailable(deps.chrome)) {
    throw errors.makeError(
      'extension_broken',
      '拡張のCookie機能が使えません。拡張を再読み込みしてください（chrome://extensions で「更新」→アプリを再起動）。それでも直らなければ、拡張の権限が無効になっている可能性があります。',
    );
  }
  await setCookie(deps.chrome, 'auth_token', session.authToken, { httpOnly: true });

  let ct0 = deps.forceRefreshCt0 ? null : session.ct0 || null;
  if (!ct0) {
    ct0 = await acquireCt0(deps);
    if (ct0 && deps.sessions.setCt0) {
      await deps.sessions.setCt0(accountId, ct0).catch(() => {});
    }
  }
  if (!ct0) {
    throw errors.makeError(
      'x_error',
      'Xのセッション確認（ct0）に失敗しました。x.com にログインし直してから、ポップアップで auth_token を登録し直してください。',
    );
  }
  // 時間切れで切り離された後の処理は、Cookie の書き換えも Xへの
  // 実行もしない（遅れて別アカウントの操作になるのを防ぐ）。
  if (deps.cancelled && deps.cancelled.value) return undefined;
  await setCookie(deps.chrome, 'ct0', ct0, { httpOnly: false });
  if (deps.cancelled && deps.cancelled.value) return undefined;

  return fn({ authToken: session.authToken, ct0 });
}

async function setCookie(chromeApi, name, value, { httpOnly }) {
  await chromeApi.cookies.set({
    url: X_COOKIE_URL,
    name,
    value,
    domain: '.x.com',
    path: '/',
    secure: true,
    httpOnly,
    sameSite: 'no_restriction',
    expirationDate: Math.floor((Date.now() + ONE_YEAR_MS) / 1000),
  });
}

/**
 * auth_token をセットした状態で x.com を一度開き、X が返す ct0 を読む。
 * fetch は拡張の Cookie を送るので、auth_token に対応する ct0 が付く。
 * 取得にはタイムアウト（既定10秒）を付ける。fetch が終わらない
 * ままでは、直列キューが詰まって後のジョブが全部止まるため。
 */
async function acquireCt0(deps) {
  const timeoutMs =
    typeof deps.ct0TimeoutMs === 'number' ? deps.ct0TimeoutMs : 10_000;
  try {
    await withTimeout(
      deps.fetchImpl(X_COOKIE_URL + '/', { credentials: 'include' }),
      timeoutMs,
      'ct0 の取得が時間切れになりました',
    );
  } catch {
    // 開けなくても Cookie が付いている場合があるので、読み取りは試す
  }
  try {
    const cookie = await deps.chrome.cookies.get({ url: X_COOKIE_URL, name: 'ct0' });
    return cookie ? cookie.value : null;
  } catch {
    return null;
  }
}

/** Promise にタイムアウトを付ける（fetch の signal に頼らない）。 */
async function withTimeout(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (typeof self !== 'undefined') {
  self.XManagerSession = XManagerSession;
}
