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
 * deps: { sessions, chrome, fetchImpl, forceRefreshCt0? }
 *  - sessions: sessionStore.js と同じ get / setCt0 を持つもの
 *  - chrome: chrome.cookies を持つもの（実物 or テスト用スタブ）
 *  - fetchImpl: ct0 取得のための fetch（実物 or テスト用スタブ）
 */
'use strict';

/* global self */

const X_COOKIE_URL = 'https://x.com';
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

let queue = Promise.resolve();

const XManagerSession = {
  /**
   * アカウントのセッションで fn({authToken, ct0}) を直列に実行する。
   * セッションが無ければ no_session、ct0 が取れなければ x_error を投げる。
   */
  withSession(accountId, fn, deps) {
    const task = queue.then(() => runSession(accountId, fn, deps));
    queue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  },
};

async function runSession(accountId, fn, deps) {
  const errors = self.XManagerErrors;
  const session = await deps.sessions.get(accountId);
  if (!session || !session.authToken) {
    throw errors.makeError(
      'no_session',
      'このアカウントは拡張に連携されていません。ポップアップから auth_token を登録してください。',
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
  await setCookie(deps.chrome, 'ct0', ct0, { httpOnly: false });

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
 */
async function acquireCt0(deps) {
  try {
    await deps.fetchImpl(X_COOKIE_URL + '/', { credentials: 'include' });
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

if (typeof self !== 'undefined') {
  self.XManagerSession = XManagerSession;
}
