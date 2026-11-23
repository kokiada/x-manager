/**
 * D-05: 投稿実行の検証 — ページ文脈 fetch による投稿。
 *
 * DESKTOP_DESIGN.md §4 の実行方式：partition に属する WebContents で
 * x.com を開き、そのページ文脈で fetch する。拡張方式の postTweet
 * （extension/src/xClient.js）と等価の投稿で、GraphQL の CreateTweet
 * を呼び、投稿 ID と投稿 URL だけを返す。
 *
 * ページ文脈では Cookie が自動で送られるため、auth_token をスクリプト
 * に渡さない（DESKTOP_DESIGN.md §6）。ct0 はページ文脈から
 * document.cookie で読む（D-04 と同じ読み方）。返り値・ログに
 * トークンの値は含めない。authorization は X の Web 版共通の公開
 * bearer トークン（全利用者で同じ値。xClient.js と同じ）で、秘密ではない。
 *
 * x-client-transaction-id の扱い（D-05 の確定事項）：生成器を流用する。
 * DOM 実装には戻さない。理由は次のとおり。
 *  - 生成器（extension/src/transactionId.js）は既に実績がある
 *    （2026-11-22 15:15 に 3-1 の通常投稿が成功。生成テストも通過）。
 *  - DOM 実装の前提が不安定：loading-x-anim は読み込み中の一時要素で、
 *    読み込み済みページの DOM に残っている保証がない。生成器は
 *    /i/jf/ を取り直して確実にシェル HTML を得る。
 *  - ページ文脈では生成器の fetch が実ブラウザのものになり、Service
 *    Worker 固有の癖（再読み込みしないと新コードが効かない、生成器の
 *    fetch が abort する等）が消える。生成ロジック自体は変えず、
 *    動かす場所だけ Service Worker からページ文脈に移す。
 *  - 実装を一本化でき、DOM 版へのフォークの保守コストが無い。
 * 生成に失敗したらヘッダ無しで送る（拡張と同じフォールバック）。
 * 403 のときは付けたかどうかで文言を変え、切り分けに残す。
 *
 * queryId は引数で受ける。未指定なら queryIds.js のフォールバック値
 * を使う。ライブ解決（バンドル走査）は Phase 1（D-06 以降）で
 * DesktopExecutor 側に持たせる想定で、D-05 の範囲外とする。
 * clientIdentity の固定 ID は付けない。ページ文脈では Referer・
 * Origin が通常の閲覧と同じ形で付き、実ブラウザ文脈のため不要
 * （DESKTOP_DESIGN.md §5。D-02〜D-05 の実測での確認事項）。
 *
 * webContents は引数で受ける（テストでは偽物に差し替え）。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHostWindow, X_URL } = require('./host.cjs');

const GRAPHQL_BASE = 'https://x.com/i/api/graphql';
/** Web 版共通の公開 bearer トークン（秘密ではない。xClient.js と同じ値）。 */
const BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
/** queryIds.js のフォールバック値（2026-02 時点の公開情報）。 */
const CREATE_TWEET_FALLBACK_QUERY_ID = 'bDE2rBtZb3uyrczSZ_pI9g';
const POST_TWEET_TIMEOUT_MS = 30000;
const POST_TWEET_FETCH_TIMEOUT_MS = 20000;
const TRANSACTION_ID_TIMEOUT_MS = 15000;

/**
 * GraphQL の feature flags。xClient.js の FEATURES と同じ値。
 * 変えたときは両方をそろえること。
 */
const FEATURES = {
  creator_subscriptions_tweet_preview_api_enabled: true,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  rweb_tipjar_consumption_enabled: true,
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_jetfuel_frame_enabled: true,
  responsive_web_grok_analyze_button_fetch_trends_enabled: false,
  responsive_web_grok_analyze_post_followups_enabled: false,
  responsive_web_grok_share_attachment_enabled: false,
  premium_content_api_read_enabled: false,
  profile_label_improvements_pcf_label_in_post_enabled: true,
  rweb_video_timestamps_enabled: true,
  responsive_web_grok_image_annotation_enabled: true,
};

/**
 * CreateTweet の variables を作る。xClient.postTweet と同じ形：
 * media は possibly_sensitive: false を必ず付ける（存在しない
 * フィールド possibly_media を送ると 422 になる。2026-11-22 の 3-1）。
 */
function buildPostTweetVariables(text, { replyToId, mediaIds, communityId, replyPermission } = {}) {
  const variables = {
    tweet_text: text,
    reply: replyToId
      ? { in_reply_to_status_id: replyToId, exclude_reply_user_ids: [] }
      : undefined,
    media: {
      media_entities: (mediaIds || []).map((id) => ({ media_id: id, tagged_users: [] })),
      possibly_sensitive: false,
    },
    dark: false,
    semantic_annotation_ids: [],
  };
  if (communityId) variables.community_id = communityId;
  if (replyPermission && replyPermission !== 'everyone') {
    variables.reply_settings = replyPermission;
  }
  return variables;
}

/**
 * ページ文脈で実行する関数。document.cookie から ct0 を読み、
 * CreateTweet を fetch して { status, body }（body はテキスト）を
 * 返す。fetch 自体が失敗したときは { status: 0, error } を返す。
 * txId があれば x-client-transaction-id ヘッダを付ける。
 * ページ文脈のグローバル（document / fetch / AbortSignal）だけを
 * 使い、クロージャに依存しないこと。buildPostTweetScript が
 * toString() でソースを取り出してページに送る。
 * Referer / Origin はページ文脈の fetch が通常の閲覧と同じ形で
 * 付けるため、こちらでは付けない。
 */
async function pagePostTweet(url, body, txId, bearer, timeoutMs) {
  let ct0 = '';
  try {
    const match = /(?:^|;\s*)ct0=([^;]*)/.exec(document.cookie || '');
    ct0 = match ? decodeURIComponent(match[1]) : '';
  } catch {
    ct0 = '';
  }
  const headers = {
    authorization: `Bearer ${bearer}`,
    'x-csrf-token': ct0,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'content-type': 'application/json',
  };
  if (txId) headers['x-client-transaction-id'] = txId;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      credentials: 'include',
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { status: 0, error: err instanceof Error ? err.message : String(err) };
  }
  let responseBody = '';
  try {
    responseBody = await res.text();
  } catch {
    responseBody = '';
  }
  return { status: res.status, body: responseBody };
}

/**
 * ページ文脈で実行する投稿スクリプトを組み立てる。
 * executeJavaScript の返り値は構造化クローンで渡るため、
 * プレーンなオブジェクトだけを返す。
 * text が空ならスクリプトを作らずに投げる（投稿前に弾く）。
 */
function buildPostTweetScript({ queryId, text, txId = null, replyToId, mediaIds, communityId, replyPermission } = {}) {
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('投稿するテキストがありません。');
  }
  const url = `${GRAPHQL_BASE}/${queryId}/CreateTweet`;
  const body = JSON.stringify({
    variables: buildPostTweetVariables(text, { replyToId, mediaIds, communityId, replyPermission }),
    features: FEATURES,
  });
  // bearer は公開トークン（xClient.js と同じ値）。auth_token は
  // スクリプトに含めない（ページ文脈の Cookie に任せる）。
  return `(${pagePostTweet.toString()})(${JSON.stringify(url)}, ${JSON.stringify(body)}, ${JSON.stringify(txId)}, ${JSON.stringify(BEARER_TOKEN)}, ${POST_TWEET_FETCH_TIMEOUT_MS})`;
}

/**
 * transactionId.js のソースをディスクから読む。ページ文脈に載せて
 * 生成器として使う（Service Worker 用の移植版をそのまま流用）。
 */
function loadTransactionIdSource() {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', 'extension', 'src', 'transactionId.js'),
    'utf8',
  );
}

/**
 * ページ文脈でトランザクションIDを作るスクリプトを組み立てる。
 * 前提：ページに XManagerTransactionId が載っていること
 * （loadTransactionIdSource() のソースを実行した後）。
 * 生成できなければ null を返す（呼び出し側はヘッダ無しで送る）。
 */
function buildTransactionIdScript(graphqlUrl) {
  return `(async () => { try { const gen = self.XManagerTransactionId.createGenerator({ fetchImpl: fetch }); const id = await gen('POST', ${JSON.stringify(graphqlUrl)}); return typeof id === 'string' && id.length > 0 ? id : null; } catch { return null; } })()`;
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
 * ページ文脈でトランザクションIDを生成する。生成器の載せ込み・
 * 生成のどちらかが失敗しても例外を投げず null を返す。
 */
async function generateTransactionId(webContents, graphqlUrl, { timeoutMs = TRANSACTION_ID_TIMEOUT_MS } = {}) {
  try {
    if (!webContents || typeof webContents.executeJavaScript !== 'function') {
      return null;
    }
    await withTimeout(
      webContents.executeJavaScript(loadTransactionIdSource()),
      timeoutMs,
      'トランザクションID生成器の読み込みがタイムアウトしました',
    );
    const id = await withTimeout(
      webContents.executeJavaScript(buildTransactionIdScript(graphqlUrl)),
      timeoutMs,
      'トランザクションIDの生成がタイムアウトしました',
    );
    return typeof id === 'string' && id.length > 0 ? id : null;
  } catch {
    return null;
  }
}

/**
 * CreateTweet の応答 JSON から { postId, postUrl } を取り出す。
 * 拡張の postTweet と同じ取り方：TweetWithVisibilityResults なら
 * 中の tweet を見る。投稿 ID が読めなければエラーを投げる。
 */
function parseCreateTweet(json) {
  const result = json && json.data && json.data.create_tweet && json.data.create_tweet.tweet_results
    ? json.data.create_tweet.tweet_results.result
    : null;
  const tweet = result && result.__typename === 'TweetWithVisibilityResults' ? result.tweet : result;
  const postId = tweet && typeof tweet.rest_id === 'string' ? tweet.rest_id : '';
  if (!postId) {
    throw new Error('投稿の応答から投稿IDを読み取れませんでした。');
  }
  return { postId, postUrl: `https://x.com/i/status/${postId}` };
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
 * ページ文脈 fetch の結果を判定する。拡張の requestJson（書き込み系）
 * と同じ分類・文言にする。403 と errors 配列の文言には、
 * トランザクションIDを付けて送ったかどうかを含める。
 * { ok: true, postId, postUrl } か { ok: false, error } を返す。
 */
function classifyPostTweetResult(result, { txAttached = false } = {}) {
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
  if (result.status === 401) {
    return {
      ok: false,
      error: 'Xのセッションが切れています。x.com にログインし直してください。',
    };
  }
  if (result.status === 403) {
    return {
      ok: false,
      error: txAttached
        ? 'Xがこの操作を拒否しました（403）。トランザクションIDを付けて送っても拒否されたため、アカウントの制限か、X側の仕様変更の可能性があります。しばらく待ってから再試行してください。'
        : 'Xがこの操作を拒否しました（403）。トランザクションIDの生成に失敗したためヘッダ無しで送り、Xに拒否されました。ホストを再起動してから再試行してください。',
    };
  }
  if (result.status === 400 || result.status === 404) {
    return {
      ok: false,
      error: `Xがこの操作を受け付けませんでした（HTTP ${result.status}）。Xの更新で操作の query ID が変わった可能性があり、ホストの更新が必要です。`,
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
    const tidNote = txAttached
      ? '（トランザクションIDは付けて送りました）'
      : '（トランザクションIDの生成に失敗し、付けずに送りました）';
    return { ok: false, error: `Xがエラーを返しました：${message}${tidNote}` };
  }
  try {
    const { postId, postUrl } = parseCreateTweet(json);
    return { ok: true, postId, postUrl };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * 投稿チェックを実行する：トランザクションIDを生成して（失敗時は
 * ヘッダ無し）、ページ文脈で CreateTweet を fetch し、{ postId,
 * postUrl } だけを返す。失敗時は例外を投げず { ok: false, error }
 * を返す。text が空のときも { ok: false, error } を返す。
 */
async function runPostTweet(
  webContents,
  { queryId = CREATE_TWEET_FALLBACK_QUERY_ID, text, replyToId, mediaIds, communityId, replyPermission, timeoutMs = POST_TWEET_TIMEOUT_MS } = {},
) {
  try {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, error: '投稿するテキストがありません。' };
    }
    if (!webContents || typeof webContents.executeJavaScript !== 'function') {
      throw new Error('この webContents は executeJavaScript に対応していません。');
    }
    const graphqlUrl = `${GRAPHQL_BASE}/${queryId}/CreateTweet`;
    const txId = await generateTransactionId(webContents, graphqlUrl, {
      timeoutMs: Math.min(timeoutMs, TRANSACTION_ID_TIMEOUT_MS),
    });
    const script = buildPostTweetScript({ queryId, text, txId, replyToId, mediaIds, communityId, replyPermission });
    const result = await withTimeout(
      webContents.executeJavaScript(script),
      timeoutMs,
      '投稿チェックがタイムアウトしました',
    );
    return classifyPostTweetResult(result, { txAttached: txId !== null });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * アカウントの partition でウィンドウを開き、投稿チェックを実行
 * してウィンドウを閉じる。proxy / cookies を渡すと読み込み前に
 * partition の session へ設定する（D-03）。
 */
async function runPostTweetForAccount(
  electron,
  { accountId, queryId = CREATE_TWEET_FALLBACK_QUERY_ID, text, replyToId, mediaIds, communityId, replyPermission, url = X_URL, proxy = undefined, cookies = undefined, timeoutMs = POST_TWEET_TIMEOUT_MS },
) {
  let win = null;
  try {
    const created = await createHostWindow(electron, { accountId, url, proxy, cookies });
    win = created.window;
    return await runPostTweet(win.webContents, { queryId, text, replyToId, mediaIds, communityId, replyPermission, timeoutMs });
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
  GRAPHQL_BASE,
  BEARER_TOKEN,
  CREATE_TWEET_FALLBACK_QUERY_ID,
  POST_TWEET_TIMEOUT_MS,
  POST_TWEET_FETCH_TIMEOUT_MS,
  TRANSACTION_ID_TIMEOUT_MS,
  FEATURES,
  buildPostTweetVariables,
  buildPostTweetScript,
  buildTransactionIdScript,
  loadTransactionIdSource,
  generateTransactionId,
  parseCreateTweet,
  classifyPostTweetResult,
  runPostTweet,
  runPostTweetForAccount,
};
