/**
 * 拡張の実行層（extension/src/*.js）のテスト。
 *
 * 拡張の素の JS を node:vm で読み込み、chrome / fetch のスタブを
 * 差し込んで実行する。実アカウントでの疎通はここではできないため、
 * ここでは「正しいリクエストを作る」「応答を正しく読む」「失敗を
 * 正しい分類で返す」ことを検証する。
 */
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type AnyRecord = Record<string, any>;

function loadExtension(chromeStub: AnyRecord, fetchStub: AnyRecord) {
  // vm のコンテキストには Node のグローバルが無い。拡張の実環境
  // （service worker）にはあるものだけ、ここで補う。
  const sandbox: AnyRecord = {
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    URLSearchParams,
  };
  sandbox.self = sandbox;
  sandbox.chrome = chromeStub;
  sandbox.fetch = fetchStub;
  const ctx = createContext(sandbox);
  for (const file of ['errors.js', 'queryIds.js', 'session.js', 'xClient.js', 'dispatch.js']) {
    runInContext(
      readFileSync(new URL(`../../extension/src/${file}`, import.meta.url), 'utf8'),
      ctx,
      { filename: file },
    );
  }
  return sandbox as AnyRecord;
}

function makeChromeStub() {
  const cookies: Record<string, string> = {};
  const storageData: Record<string, any> = {};
  return {
    storage: {
      local: {
        get: async (key: string | string[]) => {
          if (typeof key === 'string') {
            return storageData[key] !== undefined ? { [key]: storageData[key] } : {};
          }
          const out: AnyRecord = {};
          for (const k of key) if (storageData[k] !== undefined) out[k] = storageData[k];
          return out;
        },
        set: async (obj: AnyRecord) => {
          Object.assign(storageData, obj);
        },
        _data: storageData,
      },
    },
    cookies: {
      set: async (details: AnyRecord) => {
        cookies[details.name] = details.value;
      },
      get: async ({ name }: AnyRecord) =>
        cookies[name] ? { value: cookies[name] } : null,
      _cookies: cookies,
    },
  };
}

function makeSessionsStub(sessions: Record<string, AnyRecord>) {
  return {
    get: async (id: string) => sessions[id] || null,
    setCt0: async (id: string, ct0: string) => {
      if (sessions[id]) sessions[id] = { ...sessions[id], ct0 };
    },
    list: async () =>
      Object.entries(sessions).map(([accountId, s]) => ({
        accountId,
        handle: s.handle || '',
        linkedAt: s.linkedAt || 0,
      })),
  };
}

function jsonResponse(status: number, body: any) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function textResponse(status: number, text: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function makeFetchStub(
  routes: Array<{ match: (url: string, opts: any) => boolean; handle: (url: string, opts: any) => any }>,
) {
  const calls: Array<{ url: string; opts: any }> = [];
  const fn = async (url: string, opts: any = {}) => {
    calls.push({ url, opts });
    for (const r of routes) {
      if (r.match(url, opts)) return r.handle(url, opts);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  (fn as any).calls = calls;
  return fn as any;
}

function makeCtx(opts: {
  sessions: AnyRecord;
  chrome: AnyRecord;
  fetch: AnyRecord;
  resolveQueryId?: (op: string) => Promise<string | null>;
}) {
  return {
    sessions: opts.sessions,
    chrome: opts.chrome,
    fetchImpl: opts.fetch,
    resolveQueryId: opts.resolveQueryId || (async () => 'QID'),
    getTransactionId: null,
  };
}

function tweetEntry(
  restId: string,
  text: string,
  metrics: { likes?: number; reposts?: number; bookmarks?: number; views?: string } = {},
) {
  return {
    entryId: `tweet-${restId}`,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: {
        tweet_results: {
          result: {
            __typename: 'Tweet',
            rest_id: restId,
            legacy: {
              id_str: restId,
              full_text: text,
              favorite_count: metrics.likes ?? 0,
              retweet_count: metrics.reposts ?? 0,
              bookmark_count: metrics.bookmarks ?? 0,
              created_at: 'Sat Nov 21 00:00:00 +0000 2026',
              views: { count: metrics.views ?? '0' },
            },
            core: { user_results: { result: { legacy: { screen_name: 'alice' } } } },
          },
        },
      },
    },
  };
}

function userTweetsBody(entries: AnyRecord[]) {
  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] },
          },
        },
      },
    },
  };
}

function searchBody(entries: AnyRecord[]) {
  return {
    data: {
      search_by_raw_query: {
        search_timeline: {
          timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] },
        },
      },
    },
  };
}

function userByScreenNameBody(restId: string, handle: string, followers = 42) {
  return {
    data: {
      user: {
        result: {
          __typename: 'User',
          rest_id: restId,
          legacy: {
            screen_name: handle,
            name: handle,
            followers_count: followers,
            friends_count: 7,
          },
        },
      },
    },
  };
}

const GRAPHQL = (op: string) => (url: string) => url.includes(`/graphql/QID/${op}`);

describe('セッション切替（session.js）', () => {
  it('2つのジョブが直列に実行され、Cookie が交ざらない', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub([]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
      b: { authToken: 'token-b', handle: 'bob', ct0: 'ct0-b' },
    });
    const order: string[] = [];
    const slow = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const p1 = sandbox.XManagerSession.withSession(
      'a',
      async (auth: AnyRecord) => {
        order.push(`a-start:${chromeStub.cookies._cookies.auth_token}`);
        await slow(20);
        order.push(`a-end:${auth.ct0}`);
        return 'a';
      },
      { sessions, chrome: chromeStub, fetchImpl: fetchStub },
    );
    const p2 = sandbox.XManagerSession.withSession(
      'b',
      async (auth: AnyRecord) => {
        order.push(`b-start:${chromeStub.cookies._cookies.auth_token}`);
        await slow(5);
        order.push(`b-end:${auth.ct0}`);
        return 'b';
      },
      { sessions, chrome: chromeStub, fetchImpl: fetchStub },
    );
    await expect(Promise.all([p1, p2])).resolves.toEqual(['a', 'b']);
    expect(order).toEqual(['a-start:token-a', 'a-end:ct0-a', 'b-start:token-b', 'b-end:ct0-b']);
  });

  it('ct0 が無ければ x.com を開いて取得し、保管庫に保存する', async () => {
    const chromeStub = makeChromeStub();
    const sessionsData: Record<string, AnyRecord> = {
      a: { authToken: 'token-a', handle: 'alice' },
    };
    const sessions = makeSessionsStub(sessionsData);
    const fetchStub = makeFetchStub([
      {
        match: (url) => url === 'https://x.com/',
        handle: () => {
          chromeStub.cookies._cookies.ct0 = 'ct0-fresh';
          return textResponse(200, '<html></html>');
        },
      },
    ]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const seen = await sandbox.XManagerSession.withSession(
      'a',
      async (auth: AnyRecord) => auth.ct0,
      { sessions, chrome: chromeStub, fetchImpl: fetchStub },
    );
    expect(seen).toBe('ct0-fresh');
    expect(sessionsData.a.ct0).toBe('ct0-fresh');
    expect(chromeStub.cookies._cookies.ct0).toBe('ct0-fresh');
  });

  it('未連携のアカウントは no_session で失敗する', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub([]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({});
    await expect(
      sandbox.XManagerSession.withSession(
        'nope',
        async () => 'x',
        { sessions, chrome: chromeStub, fetchImpl: fetchStub },
      ),
    ).rejects.toMatchObject({ code: 'no_session' });
  });
});

describe('query ID 解決（queryIds.js）', () => {
  it('バンドル走査で見つかった ID を使い、無ければフォールバックを使う', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub([
      {
        match: (url) => url === 'https://x.com/',
        handle: () =>
          textResponse(
            200,
            '<script src="https://abs.twimg.com/responsive-web/client-web/main.abc123.js"></script>' +
              '<script src="https://abs.twimg.com/responsive-web/client-web/other.def456.js"></script>',
          ),
      },
      {
        match: (url) => url.includes('main.abc123.js'),
        handle: () =>
          textResponse(200, '..."/i/api/graphql/AAA111/CreateTweet"..."/i/api/graphql/BBB222/DeleteTweet"...'),
      },
      {
        match: (url) => url.includes('other.def456.js'),
        handle: () => textResponse(200, 'nothing here'),
      },
    ]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const ids = await sandbox.XManagerQueryIds.resolve({
      fetchImpl: fetchStub,
      storage: chromeStub.storage.local,
    });
    expect(ids.CreateTweet).toBe('AAA111');
    expect(ids.DeleteTweet).toBe('BBB222');
    // 走査で見つからなかった操作はフォールバックが残る
    expect(ids.UserByScreenName).toBe('qW5u-DAuXpMEG0zA1F7UGQ');
    // 2回目はキャッシュが使われ、fetch が増えない
    const callsBefore = fetchStub.calls.length;
    await sandbox.XManagerQueryIds.resolve({
      fetchImpl: fetchStub,
      storage: chromeStub.storage.local,
    });
    expect(fetchStub.calls.length).toBe(callsBefore);
  });

  it('バンドル取得に失敗したらフォールバックだけを返す', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = async () => {
      throw new Error('network down');
    };
    const sandbox = loadExtension(chromeStub, fetchStub);
    const ids = await sandbox.XManagerQueryIds.resolve({
      fetchImpl: fetchStub,
      storage: chromeStub.storage.local,
    });
    expect(ids.CreateTweet).toBe('bDE2rBtZb3uyrczSZ_pI9g');
    expect(await sandbox.XManagerQueryIds.getQueryId('DeleteTweet', {
      fetchImpl: fetchStub,
      storage: chromeStub.storage.local,
    })).toBeNull();
  });
});

describe('投稿（dispatch + xClient）', () => {
  function setup(routes: Array<{ match: (url: string, opts: any) => boolean; handle: (url: string, opts: any) => any }>) {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub(routes);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const ctx = makeCtx({ sessions, chrome: chromeStub, fetch: fetchStub });
    return { sandbox, ctx, fetchStub };
  }

  it('CreateTweet を正しいヘッダ・本文で呼び、投稿IDを返す', async () => {
    const { sandbox, ctx, fetchStub } = setup([
      {
        match: GRAPHQL('CreateTweet'),
        handle: () =>
          jsonResponse(200, {
            data: { create_tweet: { tweet_results: { result: { __typename: 'Tweet', rest_id: '111' } } } },
          }),
      },
    ]);
    const data = await sandbox.XManagerDispatch.handleJob(
      {
        id: 'j1',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: { content: { text: 'こんにちは' } },
      },
      ctx,
    );
    expect(data).toEqual({
      postId: '111',
      postUrl: 'https://x.com/i/status/111',
      threadPostIds: undefined,
    });
    const call = fetchStub.calls.find((c: AnyRecord) => c.url.includes('CreateTweet'));
    expect(call.opts.headers.authorization).toContain('Bearer AAAA');
    expect(call.opts.headers['x-csrf-token']).toBe('ct0-a');
    expect(call.opts.headers['x-twitter-auth-type']).toBe('OAuth2Session');
    const body = JSON.parse(call.opts.body);
    expect(body.variables.tweet_text).toBe('こんにちは');
  });

  it('ツリーは前の投稿への返信として順に投稿する', async () => {
    let n = 0;
    const { sandbox, ctx, fetchStub } = setup([
      {
        match: GRAPHQL('CreateTweet'),
        handle: () => {
          n += 1;
          return jsonResponse(200, {
            data: {
              create_tweet: {
                tweet_results: { result: { __typename: 'Tweet', rest_id: String(100 + n) } },
              },
            },
          });
        },
      },
    ]);
    const data = await sandbox.XManagerDispatch.handleJob(
      {
        id: 'j2',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: { content: { text: '1段目', threadTexts: ['2段目', '3段目'] } },
      },
      ctx,
    );
    expect(data.postId).toBe('101');
    expect(data.threadPostIds).toEqual(['102', '103']);
    const calls = fetchStub.calls.filter((c: AnyRecord) => c.url.includes('CreateTweet'));
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[1].opts.body).variables.reply.in_reply_to_status_id).toBe('101');
    expect(JSON.parse(calls[2].opts.body).variables.reply.in_reply_to_status_id).toBe('102');
  });

  it('メディア付き・コミュニティ投稿は not_implemented で失敗する', async () => {
    const { sandbox, ctx } = setup([]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'j3',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x', mediaCount: 1 } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_implemented' });
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'j4',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x', targetType: 'community', communityId: '1' } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_implemented' });
  });

  it('GraphQL の errors は x_error、429 は rate_limited、書き込みの403は取引IDの注意付きで返す', async () => {
    const { sandbox, ctx } = setup([
      {
        match: GRAPHQL('CreateTweet'),
        handle: () =>
          jsonResponse(200, { errors: [{ message: 'Tweet text is too long.' }] }),
      },
    ]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'j5',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x' } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error' });

    const rate = setup([
      { match: GRAPHQL('CreateTweet'), handle: () => jsonResponse(429, {}) },
    ]);
    await expect(
      rate.sandbox.XManagerDispatch.handleJob(
        {
          id: 'j6',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x' } },
        },
        rate.ctx,
      ),
    ).rejects.toMatchObject({ code: 'rate_limited' });

    const forbidden = setup([
      { match: GRAPHQL('CreateTweet'), handle: () => jsonResponse(403, {}) },
    ]);
    await expect(
      forbidden.sandbox.XManagerDispatch.handleJob(
        {
          id: 'j7',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x' } },
        },
        forbidden.ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('トランザクションID') });
  });
});

describe('一括操作（dispatch + xClient）', () => {
  it('いいねは FavoriteTweet、フォローはハンドル解決→friendships/create を呼ぶ', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub([
      {
        match: GRAPHQL('FavoriteTweet'),
        handle: () => jsonResponse(200, { data: { favorite_tweet: {} } }),
      },
      {
        match: GRAPHQL('UserByScreenName'),
        handle: () => jsonResponse(200, userByScreenNameBody('777', 'bob')),
      },
      {
        match: (url) => url.includes('/friendships/create.json'),
        handle: (_url: string, opts: AnyRecord) => {
          expect(opts.body).toContain('user_id=777');
          return jsonResponse(200, { id_str: '777', screen_name: 'bob' });
        },
      },
    ]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const ctx = makeCtx({ sessions, chrome: chromeStub, fetch: fetchStub });

    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'a1',
          method: 'executeAction',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { kind: 'like', target: { postUrl: 'https://x.com/bob/status/555' } },
        },
        ctx,
      ),
    ).resolves.toEqual({});
    const likeCall = fetchStub.calls.find((c: AnyRecord) => c.url.includes('FavoriteTweet'));
    expect(JSON.parse(likeCall.opts.body).variables.tweet_id).toBe('555');

    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'a2',
          method: 'executeAction',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { kind: 'follow', target: { targetHandle: '@bob' } },
        },
        ctx,
      ),
    ).resolves.toEqual({});
  });
});

describe('チェック系（dispatch + xClient）', () => {
  function setup(routes: Array<{ match: (url: string, opts: any) => boolean; handle: (url: string, opts: any) => any }>) {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub(routes);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
      via: { authToken: 'token-v', handle: 'checker', ct0: 'ct0-v' },
    });
    const ctx = makeCtx({ sessions, chrome: chromeStub, fetch: fetchStub });
    return { sandbox, ctx };
  }

  it('checkAccount はフォロワー数とバッジ数を返し、取れなければ -1（不明）', async () => {
    const { sandbox, ctx } = setup([
      {
        match: GRAPHQL('UserByScreenName'),
        handle: () => jsonResponse(200, userByScreenNameBody('999', 'alice', 123)),
      },
      {
        match: (url) => url.includes('badge_count.json'),
        handle: () => jsonResponse(200, { notification_count: 5, dm_count: 2 }),
      },
    ]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        { id: 'c1', method: 'checkAccount', accountId: 'a', accountHandle: 'alice', payload: {} },
        ctx,
      ),
    ).resolves.toEqual({
      status: 'logged_in',
      notifications: 5,
      dmCount: 2,
      followers: 123,
    });

    const noBadge = setup([
      {
        match: GRAPHQL('UserByScreenName'),
        handle: () => jsonResponse(200, userByScreenNameBody('999', 'alice', 123)),
      },
      {
        match: (url) => url.includes('badge_count.json'),
        handle: () => jsonResponse(404, {}),
      },
    ]);
    await expect(
      noBadge.sandbox.XManagerDispatch.handleJob(
        { id: 'c2', method: 'checkAccount', accountId: 'a', accountHandle: 'alice', payload: {} },
        noBadge.ctx,
      ),
    ).resolves.toEqual({
      status: 'logged_in',
      notifications: -1,
      dmCount: -1,
      followers: 123,
    });
  });

  it('checkAccount の 401 は「ログアウト状態」という結果として返す', async () => {
    const { sandbox, ctx } = setup([
      { match: GRAPHQL('UserByScreenName'), handle: () => jsonResponse(401, {}) },
    ]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        { id: 'c3', method: 'checkAccount', accountId: 'a', accountHandle: 'alice', payload: {} },
        ctx,
      ),
    ).resolves.toEqual({
      status: 'logged_out',
      notifications: -1,
      dmCount: -1,
      followers: -1,
    });
  });

  it('checkSearchBan は話題・最新それぞれに最新ポストがあるかで判定する', async () => {
    const { sandbox, ctx } = setup([
      {
        match: GRAPHQL('UserByScreenName'),
        handle: () => jsonResponse(200, userByScreenNameBody('999', 'alice')),
      },
      {
        match: GRAPHQL('UserTweets'),
        handle: () => jsonResponse(200, userTweetsBody([tweetEntry('1001', 'latest post')])),
      },
      {
        match: (url) => url.includes('SearchTimeline') && url.includes('Top'),
        handle: () => jsonResponse(200, searchBody([tweetEntry('1001', 'latest post')])),
      },
      {
        match: (url) => url.includes('SearchTimeline') && url.includes('Latest'),
        handle: () => jsonResponse(200, searchBody([tweetEntry('2002', 'other post')])),
      },
    ]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'c4',
          method: 'checkSearchBan',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { viaAccountId: 'via', viaHandle: 'checker' },
        },
        ctx,
      ),
    ).resolves.toEqual({ topicVisible: true, latestVisible: false });
  });

  it('checkSearchBan はポストが無ければ null（取得失敗扱い）', async () => {
    const { sandbox, ctx } = setup([
      {
        match: GRAPHQL('UserByScreenName'),
        handle: () => jsonResponse(200, userByScreenNameBody('999', 'alice')),
      },
      { match: GRAPHQL('UserTweets'), handle: () => jsonResponse(200, userTweetsBody([])) },
    ]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'c5',
          method: 'checkSearchBan',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { viaAccountId: 'via', viaHandle: 'checker' },
        },
        ctx,
      ),
    ).resolves.toEqual({ topicVisible: null, latestVisible: null });
  });
});

describe('取得系（dispatch + xClient）', () => {
  function setup(routes: Array<{ match: (url: string, opts: any) => boolean; handle: (url: string, opts: any) => any }>) {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub(routes);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const ctx = makeCtx({ sessions, chrome: chromeStub, fetch: fetchStub });
    return { sandbox, ctx };
  }

  it('fetchPostAnalytics はポスト一覧を計測値付きで返す', async () => {
    const { sandbox, ctx } = setup([
      {
        match: GRAPHQL('UserByScreenName'),
        handle: () => jsonResponse(200, userByScreenNameBody('999', 'alice')),
      },
      {
        match: GRAPHQL('UserTweets'),
        handle: () =>
          jsonResponse(
            200,
            userTweetsBody([
              tweetEntry('1001', 'first', { likes: 3, reposts: 1, bookmarks: 2, views: '50' }),
              tweetEntry('1002', 'second', { likes: 0, reposts: 0, bookmarks: 0, views: '7' }),
            ]),
          ),
      },
    ]);
    const data = await sandbox.XManagerDispatch.handleJob(
      {
        id: 'f1',
        method: 'fetchPostAnalytics',
        accountId: 'a',
        accountHandle: 'alice',
        payload: { fetcherAccountIds: ['a'] },
      },
      ctx,
    );
    expect(data.items).toHaveLength(2);
    expect(data.items[0]).toMatchObject({
      accountId: 'a',
      postId: '1001',
      postUrl: 'https://x.com/alice/status/1001',
      text: 'first',
      likes: 3,
      reposts: 1,
      bookmarks: 2,
      views: 50,
    });
    expect(typeof data.items[0].postedAt).toBe('number');
  });

  it('fetchNotifications は通知とDMを合わせ、形式が違えば not_implemented', async () => {
    const { sandbox, ctx } = setup([
      {
        match: (url) => url.includes('notifications/all.json'),
        handle: () =>
          jsonResponse(200, {
            timeline: {
              instructions: [
                {
                  type: 'TimelineAddEntries',
                  entries: [
                    {
                      entryId: 'n-1',
                      content: {
                        entryType: 'TimelineTimelineItem',
                        itemContent: {
                          notification: {
                            message: { text: '@bob がいいねしました' },
                            fromUser: { screen_name: 'bob' },
                          },
                        },
                      },
                    },
                  ],
                },
              ],
            },
          }),
      },
      {
        match: (url) => url.includes('dm/inbox_timeline'),
        handle: () =>
          jsonResponse(200, {
            inbox_timeline: {
              entries: [
                {
                  message: {
                    id: 'm1',
                    time: '1795220000000',
                    message_data: { text: 'こんにちは', sender_id: '555' },
                  },
                },
              ],
            },
            users: { '555': { screen_name: 'carol' } },
          }),
      },
    ]);
    const data = await sandbox.XManagerDispatch.handleJob(
      { id: 'f2', method: 'fetchNotifications', accountId: 'a', accountHandle: 'alice', payload: {} },
      ctx,
    );
    expect(data.items).toHaveLength(2);
    expect(data.items[0]).toMatchObject({ kind: 'dm', title: 'DM', body: 'こんにちは', fromHandle: 'carol' });
    expect(data.items[1]).toMatchObject({ kind: 'notification', body: '@bob がいいねしました' });

    const badShape = setup([
      {
        match: (url) => url.includes('notifications/all.json'),
        handle: () => jsonResponse(200, { somethingElse: true }),
      },
      {
        match: (url) => url.includes('dm/inbox_timeline'),
        handle: () => jsonResponse(200, { inbox_timeline: { entries: [] } }),
      },
    ]);
    await expect(
      badShape.sandbox.XManagerDispatch.handleJob(
        { id: 'f3', method: 'fetchNotifications', accountId: 'a', accountHandle: 'alice', payload: {} },
        badShape.ctx,
      ),
    ).rejects.toMatchObject({ code: 'not_implemented' });
  });
});

describe('background の配線', () => {
  it('list-sessions は sessions（ID＋ハンドル）と accountIds（後方互換）を返す', async () => {
    // background.js を vm で読み込む。importScripts は読み込んだ
    // ファイルを同じコンテキストで実行するだけの差し替え。
    let listener: ((message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean) | null =
      null;
    const storageData: Record<string, unknown> = {
      'xmanager.sessions.v1': {
        acc1: { authToken: 'x'.repeat(40), handle: 'foo', linkedAt: 1 },
        acc2: { authToken: 'y'.repeat(40), handle: '', linkedAt: 2 },
      },
    };
    const chromeStub: AnyRecord = {
      storage: {
        local: {
          get: async (key: string) =>
            storageData[key] !== undefined ? { [key]: storageData[key] } : {},
          set: async (obj: AnyRecord) => Object.assign(storageData, obj),
        },
      },
      cookies: { set: async () => {}, get: async () => null },
      runtime: {
        onMessage: {
          addListener: (fn: typeof listener) => {
            listener = fn;
          },
        },
      },
    };
    const sandbox: AnyRecord = {
      console,
      chrome: chromeStub,
      fetch: async () => {
        throw new Error('unexpected fetch');
      },
    };
    sandbox.self = sandbox;
    const ctx = createContext(sandbox);
    sandbox.importScripts = (...files: string[]) => {
      for (const file of files) {
        runInContext(
          readFileSync(new URL(`../../extension/src/${file}`, import.meta.url), 'utf8'),
          ctx,
          { filename: file },
        );
      }
    };
    runInContext(
      readFileSync(new URL('../../extension/src/background.js', import.meta.url), 'utf8'),
      ctx,
      { filename: 'background.js' },
    );
    expect(listener).not.toBe(null);

    const response = await new Promise<AnyRecord>((resolve) => {
      const done = listener!(
        { source: 'x-manager', kind: 'list-sessions' },
        {},
        (r: unknown) => resolve(r as AnyRecord),
      );
      expect(done).toBe(true);
    });
    expect(response).toMatchObject({
      source: 'x-manager-extension',
      kind: 'sessions',
      sessions: [
        { accountId: 'acc1', handle: 'foo' },
        { accountId: 'acc2', handle: null },
      ],
      accountIds: ['acc1', 'acc2'],
    });
  });

  it('background.js が新しいモジュールを読み込み、manifest が必要なホストを許可する', () => {
    const background = readFileSync(
      new URL('../../extension/src/background.js', import.meta.url),
      'utf8',
    );
    for (const file of ['errors.js', 'queryIds.js', 'session.js', 'xClient.js', 'dispatch.js']) {
      expect(background).toContain(`'${file}'`);
    }
    const manifest = JSON.parse(
      readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'),
    );
    expect(manifest.host_permissions).toContain('https://x.com/*');
    expect(manifest.host_permissions).toContain('https://api.x.com/*');
    expect(manifest.host_permissions).toContain('https://abs.twimg.com/*');
  });
});
