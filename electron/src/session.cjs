/**
 * D-03: Electron 最小ホスト — partition のプロキシ設定と Cookie 設定。
 *
 * デスクトップ方式ではアカウントごとに session.fromPartition で
 * セッションを分離する（DESKTOP_DESIGN.md §3）。プロキシは
 * partition の session.setProxy()、認証は partition の
 * session.cookies に auth_token / ct0 を設定する。
 *
 * session オブジェクトは引数で受ける（テストでは偽物に差し替え）。
 * Cookie の値そのものは返り値・ログに含めない（DESKTOP_DESIGN.md §6）。
 */
'use strict';

const X_COOKIE_URL = 'https://x.com/';
const X_COOKIE_DOMAIN = '.x.com';
const X_COOKIE_PATH = '/';
const SESSION_COOKIE_NAMES = ['auth_token', 'ct0'];
const PROXY_SCHEMES = ['http', 'https', 'socks5'];

/** ポートが 1〜65535 の整数か。 */
function isValidPort(port) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * プロキシ設定を Electron の setProxy 形式に変換する。
 * proxy が null / undefined なら直接接続（proxyRules: 'direct://'）。
 * 形：{ scheme: 'http'|'https'|'socks5', host, port,
 *       username?, password?, bypass?: string[] }
 */
function buildProxyRules(proxy) {
  if (proxy === null || proxy === undefined) {
    return { proxyRules: 'direct://' };
  }
  if (typeof proxy !== 'object' || Array.isArray(proxy)) {
    throw new Error('プロキシ設定が不正です。オブジェクトで指定してください。');
  }
  const { scheme, host, port, username, password, bypass } = proxy;
  if (!PROXY_SCHEMES.includes(scheme)) {
    throw new Error(`プロキシの scheme が不正です：${String(scheme)}（http / https / socks5 のみ）。`);
  }
  if (typeof host !== 'string' || host.length === 0 || /\s/.test(host)) {
    throw new Error('プロキシの host が不正です。');
  }
  if (!isValidPort(port)) {
    throw new Error('プロキシの port が不正です。1〜65535 の整数で指定してください。');
  }
  let auth = '';
  if (username !== undefined || password !== undefined) {
    if (typeof username !== 'string' || username.length === 0) {
      throw new Error('プロキシの username が不正です。');
    }
    if (typeof password !== 'string') {
      throw new Error('プロキシの password が不正です。');
    }
    auth = `${encodeURIComponent(username)}:${encodeURIComponent(password)}@`;
  }
  const rules = { proxyRules: `${scheme}://${auth}${host}:${port}` };
  if (bypass !== undefined) {
    if (!Array.isArray(bypass) || bypass.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      throw new Error('プロキシの bypass が不正です。文字列の配列で指定してください。');
    }
    if (bypass.length > 0) rules.proxyBypassRules = bypass.join(';');
  }
  return rules;
}

/** session にプロキシ設定を適用し、適用した rules を返す。 */
async function applyProxy(sess, proxy) {
  if (!sess || typeof sess.setProxy !== 'function') {
    throw new Error('この session は setProxy に対応していません。');
  }
  const rules = buildProxyRules(proxy);
  await sess.setProxy(rules);
  return rules;
}

/** セッション Cookie 1件を検証する。管理するのは auth_token / ct0 のみ。 */
function validateSessionCookie(cookie) {
  if (!cookie || typeof cookie !== 'object' || Array.isArray(cookie)) {
    throw new Error('Cookie が不正です。オブジェクトで指定してください。');
  }
  const { name, value, domain, path } = cookie;
  if (!SESSION_COOKIE_NAMES.includes(name)) {
    throw new Error(`設定できる Cookie は auth_token / ct0 のみです：${String(name)}`);
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Cookie ${name} の値が不正です。空でない文字列で指定してください。`);
  }
  if (domain !== undefined && domain !== 'x.com' && domain !== X_COOKIE_DOMAIN) {
    throw new Error(`Cookie ${name} の domain が不正です：${String(domain)}（x.com / .x.com のみ）。`);
  }
  if (path !== undefined && (typeof path !== 'string' || !path.startsWith('/'))) {
    throw new Error(`Cookie ${name} の path が不正です：${String(path)}`);
  }
}

/**
 * session.cookies に auth_token / ct0 を設定する。
 * 値を返り値に含めない。設定した Cookie 名の配列を返す。
 */
async function setSessionCookies(sess, cookies) {
  if (!sess || !sess.cookies || typeof sess.cookies.set !== 'function') {
    throw new Error('この session は cookies.set に対応していません。');
  }
  if (!Array.isArray(cookies)) {
    throw new Error('Cookie は配列で指定してください。');
  }
  const names = [];
  for (const cookie of cookies) {
    validateSessionCookie(cookie);
    await sess.cookies.set({
      url: X_COOKIE_URL,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain ?? X_COOKIE_DOMAIN,
      path: cookie.path ?? X_COOKIE_PATH,
      secure: true,
      // auth_token は JS から読めない実 Cookie と同じ扱い、ct0 は JS から読む。
      httpOnly: cookie.name === 'auth_token',
      sameSite: 'lax',
    });
    names.push(cookie.name);
  }
  return names;
}

/**
 * セッションの状態を読む。Cookie の値は返さない。
 * { hasAuthToken, hasCt0, cookieNames } を返す。
 */
async function getSessionStatus(sess) {
  if (!sess || !sess.cookies || typeof sess.cookies.get !== 'function') {
    throw new Error('この session は cookies.get に対応していません。');
  }
  const cookies = await sess.cookies.get({ url: X_COOKIE_URL });
  const names = cookies.map((cookie) => cookie.name);
  return {
    hasAuthToken: names.includes('auth_token'),
    hasCt0: names.includes('ct0'),
    cookieNames: names,
  };
}

/**
 * プロキシと Cookie の検証：プロキシを適用し、x.com に対する
 * 解決結果と Cookie の有無を返す。値は含めない。
 * resolveProxy が無い session では適用した rules をそのまま返す。
 */
async function verifySession(sess, proxy) {
  try {
    const rules = await applyProxy(sess, proxy);
    let resolved = rules.proxyRules;
    if (typeof sess.resolveProxy === 'function') {
      resolved = await sess.resolveProxy(X_COOKIE_URL);
    }
    const status = await getSessionStatus(sess);
    return { ok: true, proxy: resolved, ...status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * session を設定する。proxy が undefined ならプロキシは触らず、
 * cookies が空・未指定なら Cookie は触らない（D-02 の動作を保つ）。
 */
async function configureSession(sess, { proxy = undefined, cookies = undefined } = {}) {
  if (proxy !== undefined) await applyProxy(sess, proxy);
  if (cookies !== undefined && cookies.length > 0) await setSessionCookies(sess, cookies);
}

module.exports = {
  X_COOKIE_URL,
  X_COOKIE_DOMAIN,
  SESSION_COOKIE_NAMES,
  PROXY_SCHEMES,
  buildProxyRules,
  applyProxy,
  validateSessionCookie,
  setSessionCookies,
  getSessionStatus,
  verifySession,
  configureSession,
};
