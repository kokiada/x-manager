/**
 * アプリからの実行ジョブを X 内部APIの呼び出しに振り分ける。
 *
 * 返すのは ExtensionExecutor が期待する data の中身（成功時）。
 * 失敗時は code 付きエラーを投げる（background が結果メッセージに写す）。
 *
 * ctx: { sessions, chrome, fetchImpl, resolveQueryId, getTransactionId? }
 *  - sessions: sessionStore.js と同じ get / setCt0
 *  - chrome: chrome.cookies（実物 or テスト用スタブ）
 *  - fetchImpl: fetch（実物 or テスト用スタブ）
 */
'use strict';

/* global self */

const XManagerDispatch = {
  async handleJob(job, ctx) {
    const client = self.XManagerXClient.createClient({
      fetchImpl: ctx.fetchImpl,
      resolveQueryId: ctx.resolveQueryId,
      getTransactionId: ctx.getTransactionId || null,
    });
    const withSession = (accountId, fn, opts) =>
      self.XManagerSession.withSession(accountId, fn, {
        sessions: ctx.sessions,
        chrome: ctx.chrome,
        fetchImpl: ctx.fetchImpl,
        ...(opts || {}),
      });

    switch (job.method) {
      case 'executePost':
        return withSession(job.accountId, (auth) => doPost(client, auth, job));
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

async function doPost(client, auth, job) {
  const errors = self.XManagerErrors;
  const content = job.payload.content || {};
  if (content.targetType === 'community') {
    throw errors.makeError(
      'not_implemented',
      'コミュニティへの投稿はまだ未対応です。',
    );
  }
  if ((content.mediaCount || 0) > 0) {
    throw errors.makeError(
      'not_implemented',
      'メディア付き投稿はまだ未対応です。upload.x.com へのアップロードは次の段階で実装します。',
    );
  }
  if (typeof content.text !== 'string' || !content.text.trim()) {
    throw errors.makeError('x_error', '投稿する本文がありません。');
  }
  const replyToId = extractStatusId(content.replyToUrl);
  const first = await client.postTweet(auth, {
    text: content.text,
    replyToId,
    replyPermission: content.replyPermission,
  });
  const threadPostIds = [];
  let prevId = first.postId;
  const continuations = Array.isArray(content.threadTexts) ? content.threadTexts : [];
  for (const text of continuations) {
    try {
      const next = await client.postTweet(auth, { text, replyToId: prevId });
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
