/**
 * アプリからの実行ジョブを X 内部APIの呼び出しに振り分ける。
 *
 * 返すのは ExtensionExecutor が期待する data の中身（成功時）。
 * 失敗時は code 付きエラーを投げる（background が結果メッセージに写す）。
 *
 * ctx: { sessions, chrome, fetchImpl, resolveQueryId, getTransactionId?, pendingMedia? }
 *  - sessions: sessionStore.js と同じ get / setCt0
 *  - chrome: chrome.cookies（実物 or テスト用スタブ）
 *  - fetchImpl: fetch（実物 or テスト用スタブ）
 *  - pendingMedia: mediaStore.js の保管庫（チャンク転送した
 *    メディア本体）。executePost の media 参照から取り出す。
 */
'use strict';

/* global self */

const XManagerDispatch = {
  async handleJob(job, ctx) {
    const client = self.XManagerXClient.createClient({
      fetchImpl: ctx.fetchImpl,
      resolveQueryId: ctx.resolveQueryId,
      getTransactionId: ctx.getTransactionId || null,
      // テスト用の差し替え（実環境では既定値を使う）。
      mediaStatusDeadlineMs: ctx.mediaStatusDeadlineMs,
      mediaStatusPollMs: ctx.mediaStatusPollMs,
      mediaAppendChunkBytes: ctx.mediaAppendChunkBytes,
    });
    // メディア付きジョブはアップロード分の時間を取る。アプリ側の
    // ジョブタイムアウトより少し短くして、こちらが先に時間切れの
    // エラーを返す（キューが詰まらないようにする）。
    const queueTimeoutMs =
      job.method === 'executePost' && typeof job.timeoutMs === 'number'
        ? Math.max(10_000, job.timeoutMs - 5_000)
        : undefined;
    const withSession = (accountId, fn, opts) =>
      self.XManagerSession.withSession(accountId, fn, {
        sessions: ctx.sessions,
        chrome: ctx.chrome,
        fetchImpl: ctx.fetchImpl,
        ...(queueTimeoutMs !== undefined ? { queueTimeoutMs } : {}),
        ...(opts || {}),
      });

    switch (job.method) {
      case 'executePost':
        return withSession(job.accountId, (auth) => doPost(client, auth, job, ctx));
      case 'deletePost':
        return withSession(job.accountId, (auth) =>
          client.deleteTweet(auth, String(job.payload.postId)).then(() => ({})),
        );
      case 'executeAction':
        return withSession(job.accountId, (auth) => doAction(client, auth, job));
      case 'checkAccount':
        return withSession(job.accountId, (auth) => doCheckAccount(client, auth, job));
      case 'checkSearchBan':
        return doCheckSearchBan(client, withSession, job);
      case 'fetchPostAnalytics':
        return withSession(job.accountId, (auth) => doFetchPostAnalytics(client, auth, job));
      case 'fetchNotifications':
        return withSession(job.accountId, async (auth) => {
          const items = await client.getNotifications(auth);
          return { items };
        });
      default:
        throw self.XManagerErrors.makeError(
          'not_implemented',
          `未知のジョブ種別です：${job.method}`,
        );
    }
  },
};

function extractStatusId(url) {
  if (typeof url !== 'string') return null;
  const m = /\/status\/(\d+)/.exec(url);
  return m ? m[1] : null;
}

/** base64（接頭辞なし）を Uint8Array に戻す。 */
function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function doPost(client, auth, job, ctx) {
  const errors = self.XManagerErrors;
  const content = job.payload.content || {};
  // コミュニティ投稿：ID は数字のみ（x.com/i/communities/<数字>）。
  // 画面側でも必須チェックがあるが、拡張側でも必ず検査する。
  const communityId =
    content.targetType === 'community' ? String(content.communityId || '').trim() : undefined;
  if (content.targetType === 'community') {
    if (!communityId) {
      throw errors.makeError(
        'x_error',
        'コミュニティIDが指定されていません。投稿画面でコミュニティIDを入力してください。',
      );
    }
    if (!/^\d+$/.test(communityId)) {
      throw errors.makeError(
        'x_error',
        'コミュニティIDは数字のみで入力してください。コミュニティのURL（x.com/i/communities/数字）の数字部分です。',
      );
    }
  }
  if (typeof content.text !== 'string' || !content.text.trim()) {
    // 本文が無くてもメディアがあれば投稿できる（Xの仕様）。
    if (!((content.mediaCount || 0) > 0)) {
      throw errors.makeError('x_error', '投稿する本文がありません。');
    }
  }
  // メディア付き：転送済みの本体を取り出して upload.x.com へ上げる。
  let mediaIds;
  if ((content.mediaCount || 0) > 0) {
    if (!Array.isArray(content.media) || content.media.length === 0) {
      throw errors.makeError(
        'x_error',
        'メディアのファイル本体がありません。投稿画面で画像・動画を選び直してください。',
      );
    }
    const pending = ctx && ctx.pendingMedia ? ctx.pendingMedia : null;
    const items = [];
    for (const ref of content.media) {
      const taken = pending ? pending.take(ref.uploadId, ref) : null;
      if (!taken) {
        throw errors.makeError(
          'x_error',
          `メディア「${ref.name || ''}」の転送データが見つかりませんでした。もう一度投稿してください。`,
        );
      }
      items.push({
        name: taken.name,
        mime: taken.mime,
        kind: taken.kind,
        data: base64ToBytes(taken.dataBase64),
      });
    }
    mediaIds = await client.uploadMedia(auth, items);
  }
  const replyToId = extractStatusId(content.replyToUrl);
  const first = await client.postTweet(auth, {
    text: content.text,
    replyToId,
    replyPermission: content.replyPermission,
    mediaIds,
    communityId,
  });
  const threadPostIds = [];
  let prevId = first.postId;
  const continuations = Array.isArray(content.threadTexts) ? content.threadTexts : [];
  for (const text of continuations) {
    try {
      // ツリーの続きも同じコミュニティへの投稿（Web 版と同じく
      // 各ポストに community_id を付ける）。
      const next = await client.postTweet(auth, { text, replyToId: prevId, communityId });
      threadPostIds.push(next.postId);
      prevId = next.postId;
    } catch (err) {
      throw errors.makeError(
        'x_error',
        `ツリーの途中で失敗しました（${threadPostIds.length}件は投稿済みです）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return {
    postId: first.postId,
    postUrl: first.postUrl,
    threadPostIds: threadPostIds.length > 0 ? threadPostIds : undefined,
  };
}

async function doAction(client, auth, job) {
  const errors = self.XManagerErrors;
  const kind = job.payload.kind;
  const target = job.payload.target || {};
  if (kind === 'follow') {
    const handle = (target.targetHandle || '').replace(/^@/, '');
    if (!handle) {
      throw errors.makeError('x_error', 'フォロー対象のハンドルがありません。');
    }
    await client.followUser(auth, handle);
    return {};
  }
  const tweetId = extractStatusId(target.postUrl);
  if (!tweetId) {
    throw errors.makeError('x_error', 'ポストURLから投稿IDを読み取れませんでした。');
  }
  if (kind === 'like') await client.favoriteTweet(auth, tweetId);
  else if (kind === 'repost') await client.retweet(auth, tweetId);
  else if (kind === 'bookmark') await client.bookmarkTweet(auth, tweetId);
  else throw errors.makeError('not_implemented', `未知の一括操作です：${kind}`);
  return {};
}

async function doCheckAccount(client, auth, job) {
  let user;
  try {
    user = await client.getUserByScreenName(auth, job.accountHandle);
  } catch (err) {
    // 401/403 は「チェックの結果＝ログアウト状態」と扱う（弾くのではなく
    // 状態として返す。アプリ側がステータスを更新できる）。
    // sessionExpired を付ける：アプリ側はこれを見て「セッション切れで
    // 再登録が必要」と分かる文言を出せる（成功扱いに紛れない）。
    if (err && (err.status === 401 || err.status === 403)) {
      return {
        status: 'logged_out',
        notifications: -1,
        dmCount: -1,
        followers: -1,
        sessionExpired: true,
      };
    }
    throw err;
  }
  const badge = await client.getBadgeCounts(auth);
  return {
    status: 'logged_in',
    notifications: badge ? badge.notifications : -1,
    dmCount: badge ? badge.dmCount : -1,
    followers: user.followers,
  };
}

async function doCheckSearchBan(client, withSession, job) {
  const viaAccountId = job.payload.viaAccountId;
  const viaHandle = job.payload.viaHandle;
  if (!viaAccountId) {
    throw self.XManagerErrors.makeError(
      'x_error',
      'サーチバンチェックに使うアカウントが指定されていません。',
    );
  }
  return withSession(viaAccountId, async (auth) => {
    const user = await client.getUserByScreenName(auth, job.accountHandle);
    const tweets = await client.getUserTweets(auth, user.id, 5);
    if (tweets.length === 0) {
      return { topicVisible: null, latestVisible: null };
    }
    const latestId = tweets[0].id;
    const top = await client.searchTimeline(auth, `from:${job.accountHandle}`, 'Top');
    const latest = await client.searchTimeline(auth, `from:${job.accountHandle}`, 'Latest');
    return {
      topicVisible: top.some((t) => t.id === latestId),
      latestVisible: latest.some((t) => t.id === latestId),
    };
  });
}

async function doFetchPostAnalytics(client, auth, job) {
  const user = await client.getUserByScreenName(auth, job.accountHandle);
  const tweets = await client.getUserTweets(auth, user.id, 50);
  const fetchedAt = Date.now();
  return {
    items: tweets.map((t) => ({
      accountId: job.accountId,
      postId: t.id,
      postUrl: `https://x.com/${job.accountHandle}/status/${t.id}`,
      text: t.text,
      likes: t.likes,
      reposts: t.reposts,
      bookmarks: t.bookmarks,
      views: t.views,
      postedAt: t.createdAt,
      fetchedAt,
    })),
  };
}

if (typeof self !== 'undefined') {
  self.XManagerDispatch = XManagerDispatch;
}
