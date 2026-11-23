/**
 * D-04: 読み取り実行の検証 — ページ文脈 fetch によるアカウントチェック。
 *
 * DESKTOP_DESIGN.md §4 の実行方式：partition に属する WebContents で
 * x.com を開き、そのページ文脈で fetch する。拡張方式の getCurrentUser
 * （extension/src/xClient.js）と等価の読み取りで、REST 1.1 の
 * `account/verify_credentials.json` を呼び、数値のユーザーIDと
 * ハンドルだけを返す。
 *
 * ページ文脈では Cookie が自動で送られるため、auth_token をスクリプト
 * に渡さない（DESKTOP_DESIGN.md §6）。ct0 はページ文脈から
 * document.cookie で読む（Web 版と同じ読み方）。返り値・ログに
 * トークンの値は含めない。
 *
 * webContents は引数で受ける（テストでは偽物に差し替え）。
 */
'use strict';

const { createHostWindow, X_URL } = require('./host.cjs');

const VERIFY_CREDENTIALS_URL =
  'https://api.x.com/1.1/account/verify_credentials.json?include_email=false&skip_status=true';
const READ_CHECK_TIMEOUT_MS = 30000;
const READ_CHECK_FETCH_TIMEOUT_MS = 20000;

/**
 * ページ文脈で実行する関数。document.cookie から ct0 を読み、
 * verify_credentials を fetch して { status, body }（body は
 * テキスト）を返す。fetch 自体が失敗したときは
 * { status: 0, error } を返す。ページ文脈のグローバル
 * （document / fetch / AbortSignal）だけを使い、クロージャに
 * 依存しないこと。buildReadCheckScript が toString() で
 * ソースを取り出してページに送る。
 */
async function pageReadCheck(url, timeoutMs) {
  let ct0 = '';
  try {
    const match = /(?:^|;\s*)ct0=([^;]*)/.exec(document.cookie || '');
    ct0 = match ? decodeURIComponent(match[1]) : '';
  } catch {
    ct0 = '';
  }
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      headers: {
        'x-csrf-token': ct0,
        'x-twitter-auth-type': 'OAuth2Session',
        'x-twitter-active-user': 'yes',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
  let body = '';
  try {
    body = await res.text();
  } catch {
    body = '';
  }
  return { status: res.status, body };
}

/**
 * ページ文脈で実行するスクリプトを組み立てる。
 * executeJavaScript の返り値は構造化クローンで渡るため、
 * プレーンなオブジェクトだけを返す。
 */
function buildReadCheckScript() {
  return `(${pageReadCheck.toString()})(${JSON.stringify(VERIFY_CREDENTIALS_URL)}, ${READ_CHECK_FETCH_TIMEOUT_MS})`;
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
 * verify_credentials の応答 JSON から { id, handle } を取り出す。
 * 拡張の getCurrentUser と同じ取り方：id_str（文字列）優先、
 * 無ければ id（数値）を文字列化、screen_name をハンドルにする。
 * どちらか欠けていればエラーを投げる。
 */
function parseVerifyCredentials(json) {
  const id =
    json && typeof json.id_str === 'string'
      ? json.id_str
      : json && typeof json.id === 'number'
        ? String(json.id)
        : '';
  const handle = json && typeof json.screen_name === 'string' ? json.screen_name : '';
  if (!id || !handle) {
    throw new Error(
      'ログイン中のアカウントを確認できませんでした。x.com にログインし直すか、手入力で登録してください。',
    );
  }
  return { id, handle };
}

/** X の応答本文から errors[0].message を取り出す（無ければ本文の先頭）。 */
function errorDetailFromBody(body) {
  if (!body) return '';
  try {
    const parsed = JSON.parse(body);
    const first = parsed && parsed.errors && parsed.errors[0];
    const message = typeof first === 'string' ? first : first && first.message;
    if (message) return `: ${String(message)}`;
  } catch {
    // JSON でなければ本文をそのまま使う。
  }
  return `: ${body.slice(0, 300)}`;
}

/**
 * ページ文脈 fetch の結果を判定する。拡張の requestJson /
 * getCurrentUser と同じ分類・文言にする。
 * { ok: true, id, handle } か { ok: false, error } を返す。
 */
function classifyReadCheckResult(result) {
  if (!result || typeof result !== 'object') {
    return { ok: false, error: 'Xからの応答を読み取れませんでした。ログイン状態を確認してください。' };
  }
  if (result.status === 0) {
    return {
      ok: false,
      error: `Xへの通信に失敗しました（${result.error || '不明なエラー'}）。ネットワークを確認してください。`,
    };
  }
  if (result.status === 429) {
    return {
      ok: false,
      error: 'Xの制限（レートリミット）にかかりました。しばらく待ってから再試行してください。',
    };
  }
  if (result.status === 401 || result.status === 403) {
    return {
      ok: false,
      error: 'ログイン中のアカウントを確認できませんでした。x.com にログインし直すか、手入力で登録してください。',
    };
  }
  if (typeof result.status !== 'number' || result.status < 200 || result.status >= 300) {
    return {
      ok: false,
      error: `Xからの応答が異常です（HTTP ${result.status}）${errorDetailFromBody(result.body)}。`,
    };
  }
  let json;
  try {
    json = JSON.parse(result.body);
  } catch {
    return { ok: false, error: 'Xからの応答を読み取れませんでした。ログイン状態を確認してください。' };
  }
  if (json && Array.isArray(json.errors) && json.errors.length > 0) {
    const first = json.errors[0];
    const message = typeof first === 'string' ? first : first.message || JSON.stringify(first);
    return { ok: false, error: `Xがエラーを返しました：${message}` };
  }
  try {
    const { id, handle } = parseVerifyCredentials(json);
    return { ok: true, id, handle };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 読み取りチェックを実行する：ページ文脈で verify_credentials を
 * fetch し、{ id, handle } だけを返す。失敗時は例外を投げず
 * { ok: false, error } を返す。
 */
async function runReadCheck(webContents, { timeoutMs = READ_CHECK_TIMEOUT_MS } = {}) {
  try {
    if (!webContents || typeof webContents.executeJavaScript !== 'function') {
      throw new Error('この webContents は executeJavaScript に対応していません。');
    }
    const result = await withTimeout(
      webContents.executeJavaScript(buildReadCheckScript()),
      timeoutMs,
      '読み取りチェックがタイムアウトしました',
    );
    return classifyReadCheckResult(result);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * アカウントの partition でウィンドウを開き、読み取りチェックを実行
 * してウィンドウを閉じる。proxy / cookies を渡すと読み込み前に
 * partition の session へ設定する（D-03）。
 */
async function runReadCheckForAccount(
  electron,
  { accountId, url = X_URL, proxy = undefined, cookies = undefined, timeoutMs = READ_CHECK_TIMEOUT_MS },
) {
  let win = null;
  try {
    const created = await createHostWindow(electron, { accountId, url, proxy, cookies });
    win = created.window;
    return await runReadCheck(win.webContents, { timeoutMs });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (win && typeof win.close === 'function') {
      try {
        win.close();
      } catch {
        // 閉じられなくても結果は返す。
      }
    }
  }
}

module.exports = {
  VERIFY_CREDENTIALS_URL,
  READ_CHECK_TIMEOUT_MS,
  READ_CHECK_FETCH_TIMEOUT_MS,
  buildReadCheckScript,
  parseVerifyCredentials,
  classifyReadCheckResult,
  runReadCheck,
  runReadCheckForAccount,
};
