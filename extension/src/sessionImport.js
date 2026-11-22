/**
 * ログイン中の X アカウントの安全な取り込み。
 *
 * 従来の連携は、利用者が開発者ツールで auth_token の値を探して
 * コピーし、ポップアップに貼る方式だった。値は画面・クリップボード・
 * チャットに出てしまうため、貼り間違えると漏れる。
 * このモジュールはコピペを無くす：拡張が自分の Cookie 権限で
 * `auth_token`（と `ct0`）を直接読み、X に本人確認をしてから
 * セッション保管庫へ入れる。トークンの値はこのモジュールの外に
 * 出さない（返り値はアカウントIDとハンドルだけ。ログにも出さない）。
 *
 * 取り込みの流れ：
 *   1. Cookie API が使えるか確認する（使えなければ extension_broken）
 *   2. `auth_token` の Cookie を読む。無ければ「Xにログインして
 *      いません」のエラー（未ログイン状態）
 *   3. `ct0` の Cookie を読む。無ければ x.com を一度開いてから
 *      もう一度読む（session.js の acquireCt0 と同じ考え方）
 *   4. `getCurrentUser`（verify_credentials）で数値のユーザーIDと
 *      ハンドルを確認する
 *   5. セッション保管庫へ保存する。キーは数値のユーザーID
 *      （アプリ側の「拡張の連携を取り込む」が、そのIDそのままで
 *      台帳へ追加する。ハンドルは本物が入るので仮ハンドルにならない）
 *
 * deps: { chrome, fetchImpl, sessions, resolveQueryId, getTransactionId?, timeoutMs? }
 *  - chrome: chrome.cookies を持つもの（実物 or テスト用スタブ）
 *  - fetchImpl: fetch（実物 or テスト用スタブ）
 *  - sessions: sessionStore.js と同じ set を持つもの
 *  - resolveQueryId / getTransactionId: xClient.js の createClient へ渡すもの
 *  - timeoutMs: 全体の締切（既定30秒）
 */
'use strict';

/* global self */

const X_HOME_URL = 'https://x.com';
const DEFAULT_TIMEOUT_MS = 30_000;

const XManagerSessionImport = {
  async importCurrentAccount(deps) {
    const errors = self.XManagerErrors;
    const timeoutMs =
      typeof deps.timeoutMs === 'number' ? deps.timeoutMs : DEFAULT_TIMEOUT_MS;
    let timer;
    try {
      return await Promise.race([
        runImport(deps),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(
              errors.makeError(
                'unknown',
                '取り込みが時間切れになりました。拡張を再読み込みしてから再試行してください。',
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  },
};

async function runImport(deps) {
  const errors = self.XManagerErrors;
  // Cookie API が使えないまま進むと `chrome.cookies.get` で生の
  // TypeError になる。ここで止めて、再読み込みを促す文言を返す。
  // 文言は session.js の extension_broken と同じ。
  if (!self.XManagerSession.cookiesApiAvailable(deps.chrome)) {
    throw errors.makeError(
      'extension_broken',
      '拡張のCookie機能が使えません。拡張を再読み込みしてください（chrome://extensions で「更新」→アプリを再起動）。それでも直らなければ、拡張の権限が無効になっている可能性があります。',
    );
  }
  const authToken = await readCookieValue(deps.chrome, 'auth_token');
  if (!authToken) {
    throw errors.makeError(
      'x_error',
      'Xにログインしていません。ChromeでXにログインしてから、もう一度お試しください。',
    );
  }
  let ct0 = await readCookieValue(deps.chrome, 'ct0');
  if (!ct0) {
    // Cookie だけ読めない場合があるので、x.com を一度開いてから
    // もう一度読む（session.js の acquireCt0 と同じ考え方）。
    try {
      await deps.fetchImpl(X_HOME_URL + '/', { credentials: 'include' });
    } catch {
      // 開けなくても Cookie が付いている場合があるので、読み取りは試す
    }
    ct0 = await readCookieValue(deps.chrome, 'ct0');
  }
  if (!ct0) {
    throw errors.makeError(
      'x_error',
      'Xのセッション確認（ct0）に失敗しました。x.com にログインし直してから、もう一度お試しください。',
    );
  }
  let clientIdentity = null;
  try {
    clientIdentity = deps.clientIdentity ? await deps.clientIdentity : null;
  } catch {
    clientIdentity = null;
  }
  const client = self.XManagerXClient.createClient({
    fetchImpl: deps.fetchImpl,
    resolveQueryId: deps.resolveQueryId,
    getTransactionId: deps.getTransactionId || null,
    clientIdentity,
  });
  const user = await client.getCurrentUser({ ct0 });
  // トークンは保管庫にだけ入れる。返り値には含めない。
  await deps.sessions.set(user.id, { authToken, handle: user.handle });
  return { accountId: user.id, handle: user.handle };
}

/** Cookie を1つ読む。読めなければ null（例外は握りつぶす）。 */
async function readCookieValue(chromeApi, name) {
  try {
    const cookie = await chromeApi.cookies.get({ url: X_HOME_URL, name });
    return cookie && typeof cookie.value === 'string' && cookie.value.length > 0
      ? cookie.value
      : null;
  } catch {
    return null;
  }
}

if (typeof self !== 'undefined') {
  self.XManagerSessionImport = XManagerSessionImport;
}
