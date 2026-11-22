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
    Blob,
    FormData,
    atob,
    btoa,
  };
  sandbox.self = sandbox;
  sandbox.chrome = chromeStub;
  sandbox.fetch = fetchStub;
  const ctx = createContext(sandbox);
  for (const file of ['errors.js', 'queryIds.js', 'session.js', 'xClient.js', 'mediaStore.js', 'sessionImport.js', 'dispatch.js']) {
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
  getTransactionId?: ((method: string, url: string) => Promise<string | null>) | null;
  pendingMedia?: AnyRecord;
  mediaStatusDeadlineMs?: number;
  mediaStatusPollMs?: number;
  mediaAppendChunkBytes?: number;
}) {
  return {
    sessions: opts.sessions,
    chrome: opts.chrome,
    fetchImpl: opts.fetch,
    resolveQueryId: opts.resolveQueryId || (async () => 'QID'),
    getTransactionId: opts.getTransactionId ?? null,
    pendingMedia: opts.pendingMedia,
    mediaStatusDeadlineMs: opts.mediaStatusDeadlineMs,
    mediaStatusPollMs: opts.mediaStatusPollMs,
    mediaAppendChunkBytes: opts.mediaAppendChunkBytes,
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

  it('chrome.cookies が無ければ生の TypeError ではなく extension_broken で失敗する', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    delete chromeStub.cookies;
    const fetchStub = makeFetchStub([]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    await expect(
      sandbox.XManagerSession.withSession(
        'a',
        async () => 'x',
        { sessions, chrome: chromeStub, fetchImpl: fetchStub },
      ),
    ).rejects.toMatchObject({
      code: 'extension_broken',
      message: expect.stringContaining('Cookie'),
    });
    await expect(
      sandbox.XManagerSession.withSession(
        'a',
        async () => 'x',
        { sessions, chrome: chromeStub, fetchImpl: fetchStub },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('再読み込み') });
  });

  it('cookies.set だけ欠けていても extension_broken で失敗する', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    chromeStub.cookies = { get: async () => null };
    const fetchStub = makeFetchStub([]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    await expect(
      sandbox.XManagerSession.withSession(
        'a',
        async () => 'x',
        { sessions, chrome: chromeStub, fetchImpl: fetchStub },
      ),
    ).rejects.toMatchObject({ code: 'extension_broken' });
  });

  it('cookiesApiAvailable は set/get の有無で判定する', () => {
    const sandbox = loadExtension(makeChromeStub(), makeFetchStub([]));
    expect(sandbox.XManagerSession.cookiesApiAvailable(makeChromeStub())).toBe(true);
    expect(sandbox.XManagerSession.cookiesApiAvailable({})).toBe(false);
    expect(sandbox.XManagerSession.cookiesApiAvailable({ cookies: { set: async () => {} } })).toBe(
      false,
    );
    expect(sandbox.XManagerSession.cookiesApiAvailable(undefined)).toBe(false);
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

  it('getTransactionId があれば書き込みに x-client-transaction-id を付ける', async () => {
    const { sandbox, fetchStub } = setup([
      {
        match: GRAPHQL('CreateTweet'),
        handle: () =>
          jsonResponse(200, {
            data: { create_tweet: { tweet_results: { result: { __typename: 'Tweet', rest_id: '222' } } } },
          }),
      },
    ]);
    const chromeStub = makeChromeStub();
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const ctx = makeCtx({
      sessions,
      chrome: chromeStub,
      fetch: fetchStub,
      getTransactionId: async () => 'TX-TEST-123',
    });
    const data = await sandbox.XManagerDispatch.handleJob(
      {
        id: 'j-tx',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: { content: { text: 'ヘッダ付き' } },
      },
      ctx,
    );
    expect(data.postId).toBe('222');
    const call = fetchStub.calls.find((c: AnyRecord) => c.url.includes('CreateTweet'));
    expect(call.opts.headers['x-client-transaction-id']).toBe('TX-TEST-123');
  });

  it('生成器が失敗してもヘッダ無しで投稿を送る', async () => {
    const { sandbox, fetchStub } = setup([
      {
        match: GRAPHQL('CreateTweet'),
        handle: () =>
          jsonResponse(200, {
            data: { create_tweet: { tweet_results: { result: { __typename: 'Tweet', rest_id: '333' } } } },
          }),
      },
    ]);
    const chromeStub = makeChromeStub();
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const ctx = makeCtx({
      sessions,
      chrome: chromeStub,
      fetch: fetchStub,
      getTransactionId: async () => {
        throw new Error('init failed');
      },
    });
    const data = await sandbox.XManagerDispatch.handleJob(
      {
        id: 'j-tx-fail',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: { content: { text: 'ヘッダ無しでも送る' } },
      },
      ctx,
    );
    expect(data.postId).toBe('333');
    const call = fetchStub.calls.find((c: AnyRecord) => c.url.includes('CreateTweet'));
    expect(call.opts.headers['x-client-transaction-id']).toBeUndefined();
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

  it('コミュニティ投稿：CreateTweet の変数に community_id を付ける', async () => {
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
        id: 'jc1',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: { content: { text: 'コミュニティへ', targetType: 'community', communityId: '1700000000000000000' } },
      },
      ctx,
    );
    expect(data.postId).toBe('111');
    const call = fetchStub.calls.find((c: AnyRecord) => c.url.includes('CreateTweet'));
    expect(JSON.parse(call.opts.body).variables.community_id).toBe('1700000000000000000');
    expect(JSON.parse(call.opts.body).variables.tweet_text).toBe('コミュニティへ');
  });

  it('コミュニティ投稿：ツリーの続きにも community_id を付ける', async () => {
    let n = 0;
    const { sandbox, ctx, fetchStub } = setup([
      {
        match: GRAPHQL('CreateTweet'),
        handle: () =>
          jsonResponse(200, {
            data: {
              create_tweet: {
                tweet_results: { result: { __typename: 'Tweet', rest_id: String(200 + ++n) } },
              },
            },
          }),
      },
    ]);
    const data = await sandbox.XManagerDispatch.handleJob(
      {
        id: 'jc2',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: {
          content: {
            text: '1段目',
            targetType: 'community',
            communityId: '1700000000000000000',
            threadTexts: ['2段目'],
          },
        },
      },
      ctx,
    );
    expect(data.postId).toBe('201');
    expect(data.threadPostIds).toEqual(['202']);
    const calls = fetchStub.calls.filter((c: AnyRecord) => c.url.includes('CreateTweet'));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(JSON.parse(call.opts.body).variables.community_id).toBe('1700000000000000000');
    }
  });

  it('コミュニティ投稿：IDが無い・数字でない場合は日本語エラーで止める', async () => {
    const { sandbox, ctx } = setup([]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'jc3',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x', targetType: 'community' } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('コミュニティIDが指定されていません') });
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'jc4',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x', targetType: 'community', communityId: 'my-community' } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('数字のみ') });
  });

  it('コミュニティ投稿：Xがコミュニティ絡みのエラーを返したら権限が分かる日本語にする', async () => {
    const { sandbox, ctx } = setup([
      {
        match: GRAPHQL('CreateTweet'),
        handle: () =>
          jsonResponse(200, { errors: [{ message: 'You are not a member of this community.' }] }),
      },
    ]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'jc5',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x', targetType: 'community', communityId: '1700000000000000000' } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'x_error',
      message: expect.stringContaining('コミュニティへの投稿権限がありません'),
    });
  });

  it('通常投稿には community_id を付けない', async () => {
    const { sandbox, ctx, fetchStub } = setup([
      {
        match: GRAPHQL('CreateTweet'),
        handle: () =>
          jsonResponse(200, {
            data: { create_tweet: { tweet_results: { result: { __typename: 'Tweet', rest_id: '111' } } } },
          }),
      },
    ]);
    await sandbox.XManagerDispatch.handleJob(
      {
        id: 'jc6',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: { content: { text: 'ふつうの投稿' } },
      },
      ctx,
    );
    const call = fetchStub.calls.find((c: AnyRecord) => c.url.includes('CreateTweet'));
    expect(JSON.parse(call.opts.body).variables.community_id).toBeUndefined();
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

describe('メディア付き投稿（upload.x.com）', () => {
  /** 転送済みメディアを保管庫に積む（base64 1チャンク）。 */
  function storeMedia(ext: AnyRecord, items: Array<{ uploadId: string; bytes: Uint8Array }>) {
    const store = ext.XManagerMediaStore.createMediaStore({});
    for (const item of items) {
      store.storeChunk({
        uploadId: item.uploadId,
        index: 0,
        totalChunks: 1,
        data: Buffer.from(item.bytes).toString('base64'),
      });
    }
    return store;
  }

  const uploadUrl = (url: string) => url.includes('upload.x.com');
  const uploadBody = (opts: any) => (typeof opts?.body === 'string' ? opts.body : '');
  const uploadCmd = (cmd: string) => (url: string, opts: any) =>
    uploadUrl(url) && uploadBody(opts).includes(`command=${cmd}`);
  const uploadAppend = (url: string, opts: any) =>
    uploadUrl(url) && opts?.body instanceof FormData;

  function setupMedia(
    routes: Array<{ match: (url: string, opts: any) => boolean; handle: (url: string, opts: any) => any }>,
    opts: {
      pendingMedia?: AnyRecord;
      mediaStatusDeadlineMs?: number;
      mediaStatusPollMs?: number;
      mediaAppendChunkBytes?: number;
    } = {},
  ) {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub(routes);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const ctx = makeCtx({
      sessions,
      chrome: chromeStub,
      fetch: fetchStub,
      pendingMedia: opts.pendingMedia,
      mediaStatusDeadlineMs: opts.mediaStatusDeadlineMs,
      mediaStatusPollMs: opts.mediaStatusPollMs,
      mediaAppendChunkBytes: opts.mediaAppendChunkBytes,
    });
    return { sandbox, ctx, fetchStub };
  }

  function createTweetRoute(restId: string) {
    return {
      match: GRAPHQL('CreateTweet'),
      handle: () =>
        jsonResponse(200, {
          data: { create_tweet: { tweet_results: { result: { __typename: 'Tweet', rest_id: restId } } } },
        }),
    };
  }

  it('画像付き投稿：INIT→APPEND→FINALIZE の順で上げ、CreateTweet に media_id を付ける', async () => {
    const { sandbox, ctx, fetchStub } = setupMedia([
      {
        match: uploadCmd('INIT'),
        handle: () => jsonResponse(200, { media_id_string: 'm1' }),
      },
      { match: uploadAppend, handle: () => textResponse(204, '') },
      {
        match: uploadCmd('FINALIZE'),
        handle: () => jsonResponse(200, {}),
      },
      createTweetRoute('111'),
    ]);
    const pendingMedia = storeMedia(sandbox, [
      { uploadId: 'u1', bytes: new Uint8Array([104, 101, 108, 108, 111]) },
    ]);
    ctx.pendingMedia = pendingMedia;
    const data = await sandbox.XManagerDispatch.handleJob(
      {
        id: 'jm1',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: {
          content: {
            text: '写真付き',
            mediaCount: 1,
            media: [{ uploadId: 'u1', name: 'a.png', mime: 'image/png', kind: 'image', size: 5 }],
          },
        },
      },
      ctx,
    );
    expect(data.postId).toBe('111');

    const initCall = fetchStub.calls.find((c: AnyRecord) => uploadCmd('INIT')(c.url, c.opts));
    expect(initCall.opts.body).toContain('media_type=image%2Fpng');
    expect(initCall.opts.body).toContain('total_bytes=5');
    expect(initCall.opts.body).toContain('media_category=tweet_image');

    const appendCalls = fetchStub.calls.filter((c: AnyRecord) => uploadAppend(c.url, c.opts));
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0].opts.body.get('command')).toBe('APPEND');
    expect(appendCalls[0].opts.body.get('media_id')).toBe('m1');
    expect(appendCalls[0].opts.body.get('segment_index')).toBe('0');
    expect(appendCalls[0].opts.body.get('media').size).toBe(5);

    const finCall = fetchStub.calls.find((c: AnyRecord) => uploadCmd('FINALIZE')(c.url, c.opts));
    expect(finCall.opts.body).toContain('media_id=m1');

    const tweetCall = fetchStub.calls.find((c: AnyRecord) => c.url.includes('CreateTweet'));
    expect(JSON.parse(tweetCall.opts.body).variables.media.media_entities).toEqual([
      { media_id: 'm1', tagged_users: [] },
    ]);
  });

  it('メディア付きコミュニティ投稿：CreateTweet に media_id と community_id の両方を付ける', async () => {
    const { sandbox, ctx, fetchStub } = setupMedia([
      {
        match: uploadCmd('INIT'),
        handle: () => jsonResponse(200, { media_id_string: 'm9' }),
      },
      { match: uploadAppend, handle: () => textResponse(204, '') },
      {
        match: uploadCmd('FINALIZE'),
        handle: () => jsonResponse(200, {}),
      },
      createTweetRoute('119'),
    ]);
    const pendingMedia = storeMedia(sandbox, [
      { uploadId: 'u9', bytes: new Uint8Array([104, 101, 108, 108, 111]) },
    ]);
    ctx.pendingMedia = pendingMedia;
    const data = await sandbox.XManagerDispatch.handleJob(
      {
        id: 'jm9',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: {
          content: {
            text: 'コミュニティに写真付き',
            targetType: 'community',
            communityId: '1700000000000000000',
            mediaCount: 1,
            media: [{ uploadId: 'u9', name: 'a.png', mime: 'image/png', kind: 'image', size: 5 }],
          },
        },
      },
      ctx,
    );
    expect(data.postId).toBe('119');
    const tweetCall = fetchStub.calls.find((c: AnyRecord) => c.url.includes('CreateTweet'));
    const variables = JSON.parse(tweetCall.opts.body).variables;
    expect(variables.media.media_entities).toEqual([{ media_id: 'm9', tagged_users: [] }]);
    expect(variables.community_id).toBe('1700000000000000000');
  });

  it('動画付き投稿：APPEND を分割し、FINALIZE 後に STATUS を確認してから投稿する', async () => {
    const { sandbox, ctx, fetchStub } = setupMedia(
      [
        {
          match: uploadCmd('INIT'),
          handle: () => jsonResponse(200, { media_id_string: 'm2' }),
        },
        { match: uploadAppend, handle: () => textResponse(204, '') },
        {
          match: uploadCmd('FINALIZE'),
          handle: () => jsonResponse(200, { processing_info: { state: 'pending' } }),
        },
        {
          match: uploadCmd('STATUS'),
          handle: () => jsonResponse(200, { processing_info: { state: 'succeeded' } }),
        },
        createTweetRoute('222'),
      ],
      { mediaStatusPollMs: 1, mediaStatusDeadlineMs: 5_000, mediaAppendChunkBytes: 5 },
    );
    const pendingMedia = storeMedia(sandbox, [
      { uploadId: 'u2', bytes: new Uint8Array(12).fill(7) },
    ]);
    ctx.pendingMedia = pendingMedia;
    const data = await sandbox.XManagerDispatch.handleJob(
      {
        id: 'jm2',
        method: 'executePost',
        accountId: 'a',
        accountHandle: 'alice',
        payload: {
          content: {
            text: '動画付き',
            mediaCount: 1,
            media: [{ uploadId: 'u2', name: 'v.mp4', mime: 'video/mp4', kind: 'video', size: 12 }],
          },
        },
      },
      ctx,
    );
    expect(data.postId).toBe('222');
    const appendCalls = fetchStub.calls.filter((c: AnyRecord) => uploadAppend(c.url, c.opts));
    expect(appendCalls).toHaveLength(3);
    expect(appendCalls.map((c: AnyRecord) => c.opts.body.get('segment_index'))).toEqual([
      '0',
      '1',
      '2',
    ]);
    const initCall = fetchStub.calls.find((c: AnyRecord) => uploadCmd('INIT')(c.url, c.opts));
    expect(initCall.opts.body).toContain('media_category=tweet_video');
    const statusCall = fetchStub.calls.find((c: AnyRecord) => uploadCmd('STATUS')(c.url, c.opts));
    expect(statusCall).toBeDefined();
    const tweetCall = fetchStub.calls.find((c: AnyRecord) => c.url.includes('CreateTweet'));
    expect(JSON.parse(tweetCall.opts.body).variables.media.media_entities).toEqual([
      { media_id: 'm2', tagged_users: [] },
    ]);
  });

  it('動画の処理が失敗したら x_error で失敗する', async () => {
    const { sandbox, ctx } = setupMedia(
      [
        {
          match: uploadCmd('INIT'),
          handle: () => jsonResponse(200, { media_id_string: 'm3' }),
        },
        { match: uploadAppend, handle: () => textResponse(204, '') },
        {
          match: uploadCmd('FINALIZE'),
          handle: () => jsonResponse(200, { processing_info: { state: 'pending' } }),
        },
        {
          match: uploadCmd('STATUS'),
          handle: () =>
            jsonResponse(200, {
              processing_info: { state: 'failed', error: { message: '処理できませんでした' } },
            }),
        },
        createTweetRoute('333'),
      ],
      { mediaStatusPollMs: 1, mediaStatusDeadlineMs: 5_000 },
    );
    ctx.pendingMedia = storeMedia(sandbox, [
      { uploadId: 'u3', bytes: new Uint8Array([1, 2, 3]) },
    ]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'jm3',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: {
            content: {
              text: '動画',
              mediaCount: 1,
              media: [{ uploadId: 'u3', name: 'v.mp4', mime: 'video/mp4', kind: 'video', size: 3 }],
            },
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('動画の処理に失敗') });
  });

  it('画像は5件付けられない・画像と動画の同時添付はできない・動画は2件付けられない', async () => {
    const { sandbox, ctx } = setupMedia([createTweetRoute('444')]);
    const five = Array.from({ length: 5 }, (_, i) => ({
      uploadId: `i${i}`,
      bytes: new Uint8Array([i]),
    }));
    ctx.pendingMedia = storeMedia(sandbox, five);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'jm4',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: {
            content: {
              text: 'x',
              mediaCount: 5,
              media: five.map((f, i) => ({
                uploadId: f.uploadId,
                name: `a${i}.png`,
                mime: 'image/png',
                kind: 'image',
                size: 1,
              })),
            },
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('画像は1ポストに4件まで') });

    const mix = setupMedia([createTweetRoute('445')]);
    mix.ctx.pendingMedia = storeMedia(mix.sandbox, [
      { uploadId: 'm-img', bytes: new Uint8Array([1]) },
      { uploadId: 'm-vid', bytes: new Uint8Array([2]) },
    ]);
    await expect(
      mix.sandbox.XManagerDispatch.handleJob(
        {
          id: 'jm5',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: {
            content: {
              text: 'x',
              mediaCount: 2,
              media: [
                { uploadId: 'm-img', name: 'a.png', mime: 'image/png', kind: 'image', size: 1 },
                { uploadId: 'm-vid', name: 'v.mp4', mime: 'video/mp4', kind: 'video', size: 1 },
              ],
            },
          },
        },
        mix.ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('画像と動画を同時に') });

    const twoVideos = setupMedia([createTweetRoute('446')]);
    twoVideos.ctx.pendingMedia = storeMedia(twoVideos.sandbox, [
      { uploadId: 'v1', bytes: new Uint8Array([1]) },
      { uploadId: 'v2', bytes: new Uint8Array([2]) },
    ]);
    await expect(
      twoVideos.sandbox.XManagerDispatch.handleJob(
        {
          id: 'jm6',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: {
            content: {
              text: 'x',
              mediaCount: 2,
              media: [
                { uploadId: 'v1', name: 'v1.mp4', mime: 'video/mp4', kind: 'video', size: 1 },
                { uploadId: 'v2', name: 'v2.mp4', mime: 'video/mp4', kind: 'video', size: 1 },
              ],
            },
          },
        },
        twoVideos.ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('動画は1ポストに1件まで') });
  });

  it('mediaCount があるのに media が無いと失敗する', async () => {
    const { sandbox, ctx } = setupMedia([createTweetRoute('555')]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'jm7',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x', mediaCount: 1 } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('ファイル本体がありません') });
  });

  it('転送データが無いメディアは失敗する', async () => {
    const { sandbox, ctx } = setupMedia([createTweetRoute('666')]);
    ctx.pendingMedia = storeMedia(sandbox, []);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'jm8',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: {
            content: {
              text: 'x',
              mediaCount: 1,
              media: [{ uploadId: 'gone', name: 'a.png', mime: 'image/png', kind: 'image', size: 1 }],
            },
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('転送データが見つかりません') });
  });

  it('INIT が失敗したら x_error で失敗する', async () => {
    const { sandbox, ctx } = setupMedia([
      { match: uploadCmd('INIT'), handle: () => jsonResponse(403, {}) },
      createTweetRoute('777'),
    ]);
    ctx.pendingMedia = storeMedia(sandbox, [
      { uploadId: 'u9', bytes: new Uint8Array([1, 2]) },
    ]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'jm9',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: {
            content: {
              text: 'x',
              mediaCount: 1,
              media: [{ uploadId: 'u9', name: 'a.png', mime: 'image/png', kind: 'image', size: 2 }],
            },
          },
        },
        ctx,
      ),
    ).rejects.toMatchObject({ code: 'x_error' });
  });
});

describe('メディア転送の保管庫（mediaStore.js）', () => {
  function loadStore(opts: { maxBytes?: number } = {}) {
    const sandbox: AnyRecord = { console };
    sandbox.self = sandbox;
    const ctx = createContext(sandbox);
    runInContext(
      readFileSync(new URL('../../extension/src/mediaStore.js', import.meta.url), 'utf8'),
      ctx,
      { filename: 'mediaStore.js' },
    );
    return sandbox.XManagerMediaStore.createMediaStore(opts);
  }

  it('チャンクを順不同で受け取っても正しく組み立てる', () => {
    const store = loadStore();
    const b64 = Buffer.from('hello world').toString('base64');
    store.storeChunk({ uploadId: 'u', index: 1, totalChunks: 2, data: b64.slice(8) });
    store.storeChunk({ uploadId: 'u', index: 0, totalChunks: 2, data: b64.slice(0, 8) });
    const taken = store.take('u', { name: 'a.txt', mime: 'text/plain', kind: 'image', size: 11 });
    expect(taken).not.toBeNull();
    expect(Buffer.from(taken.dataBase64, 'base64').toString()).toBe('hello world');
    expect(store.count()).toBe(0);
  });

  it('同じチャンクの二重送信・base64 以外・範囲外の番号は弾く', () => {
    const store = loadStore();
    store.storeChunk({ uploadId: 'u', index: 0, totalChunks: 1, data: 'aGVsbG8=' });
    expect(() =>
      store.storeChunk({ uploadId: 'u', index: 0, totalChunks: 1, data: 'aGVsbG8=' }),
    ).toThrow('二重');
    expect(() =>
      store.storeChunk({ uploadId: 'v', index: 0, totalChunks: 1, data: 'not base64!!' }),
    ).toThrow('base64');
    expect(() =>
      store.storeChunk({ uploadId: 'v', index: 1, totalChunks: 1, data: 'aGVsbG8=' }),
    ).toThrow('チャンク番号');
  });

  it('チャンクが欠けていると take は null を返す', () => {
    const store = loadStore();
    store.storeChunk({ uploadId: 'u', index: 0, totalChunks: 2, data: 'aGVsbG8=' });
    expect(store.take('u', {})).toBeNull();
    expect(store.take('missing', {})).toBeNull();
  });

  it('上限を超えたら古い転送から捨てる', () => {
    const store = loadStore({ maxBytes: 20 });
    // 12バイト相当のチャンクを2件送る（上限20バイト）。
    const data = Buffer.from('hello world!').toString('base64');
    store.storeChunk({ uploadId: 'old', index: 0, totalChunks: 1, data });
    expect(store.count()).toBe(1);
    store.storeChunk({ uploadId: 'new', index: 0, totalChunks: 1, data });
    expect(store.count()).toBe(1);
    expect(store.take('old', {})).toBeNull();
    expect(store.take('new', {})).not.toBeNull();
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
      // アプリ側はこれを見て「セッション切れで再登録が必要」と分かる
      // 文言を出せる（成功扱いに紛れない）。
      sessionExpired: true,
    });
  });

  it('checkAccount の 403 もセッション切れとして返す', async () => {
    const { sandbox, ctx } = setup([
      { match: GRAPHQL('UserByScreenName'), handle: () => jsonResponse(403, {}) },
    ]);
    await expect(
      sandbox.XManagerDispatch.handleJob(
        { id: 'c3b', method: 'checkAccount', accountId: 'a', accountHandle: 'alice', payload: {} },
        ctx,
      ),
    ).resolves.toEqual({
      status: 'logged_out',
      notifications: -1,
      dmCount: -1,
      followers: -1,
      sessionExpired: true,
    });
  });

  it('checkAccount は query ID が見つからなければ not_implemented の日本語エラーで失敗する', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub([]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const ctx = makeCtx({
      sessions,
      chrome: chromeStub,
      fetch: fetchStub,
      resolveQueryId: async () => null,
    });
    await expect(
      sandbox.XManagerDispatch.handleJob(
        { id: 'c3c', method: 'checkAccount', accountId: 'a', accountHandle: 'alice', payload: {} },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'not_implemented',
      message: expect.stringContaining('query ID'),
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

  it('fetchNotifications は通知の時刻を応答から取り、DMの時刻が変でも壊れない', async () => {
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
                      sortIndex: '1795220000000',
                      content: {
                        entryType: 'TimelineTimelineItem',
                        itemContent: {
                          notification: {
                            message: { text: '@bob がいいねしました' },
                            fromUser: { screen_name: 'bob' },
                            timestamp: '1795220000000',
                          },
                        },
                      },
                    },
                    {
                      entryId: 'n-2',
                      content: {
                        entryType: 'TimelineTimelineItem',
                        itemContent: {
                          notification: {
                            message: { text: '新しいフォロワー' },
                            fromUser: { screen_name: 'carol' },
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
                    time: 'not-a-number',
                    message_data: { text: 'やあ', sender_id: '555' },
                  },
                },
                {
                  message: {
                    id: 'm2',
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
      { id: 'f4', method: 'fetchNotifications', accountId: 'a', accountHandle: 'alice', payload: {} },
      ctx,
    );
    expect(data.items).toHaveLength(4);
    // DM: 時刻が読めなくても NaN にならず、取得時刻で入る。
    expect(Number.isFinite(data.items[0].at)).toBe(true);
    expect(Number.isFinite(data.items[1].at)).toBe(true);
    // 通知: 応答のタイムスタンプをそのまま使う（再取得でも同じ値＝重複排除が効く）。
    expect(data.items[2]).toMatchObject({ kind: 'notification', at: 1795220000000 });
    // 時刻が無い通知は取得時刻で入る。
    expect(Number.isFinite(data.items[3].at)).toBe(true);
  });

  it('fetchPostAnalytics は実データの欠け・墓碑・可視性ラッパーを扱う', async () => {
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
              // views・bookmark_count が無い実データ形（0 として扱う）。
              {
                entryId: 'tweet-2001',
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: 'Tweet',
                        rest_id: '2001',
                        legacy: {
                          id_str: '2001',
                          full_text: 'no views',
                          favorite_count: 5,
                          retweet_count: 2,
                          created_at: 'Sat Nov 21 00:00:00 +0000 2026',
                        },
                        core: { user_results: { result: { legacy: { screen_name: 'alice' } } } },
                      },
                    },
                  },
                },
              },
              // 墓碑は弾く。
              {
                entryId: 'tweet-2002',
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: {
                    tweet_results: {
                      result: { __typename: 'TweetTombstone', rest_id: '2002' },
                    },
                  },
                },
              },
              // 可視性ラッパーは中身をほどく。
              {
                entryId: 'tweet-2003',
                content: {
                  entryType: 'TimelineTimelineItem',
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: 'TweetWithVisibilityResults',
                        tweet: {
                          __typename: 'Tweet',
                          rest_id: '2003',
                          legacy: {
                            id_str: '2003',
                            full_text: 'wrapped',
                            favorite_count: 1,
                            retweet_count: 0,
                            bookmark_count: 1,
                            created_at: 'Sat Nov 21 00:00:00 +0000 2026',
                            views: { count: '9' },
                          },
                          core: { user_results: { result: { legacy: { screen_name: 'alice' } } } },
                        },
                      },
                    },
                  },
                },
              },
            ]),
          ),
      },
    ]);
    const data = await sandbox.XManagerDispatch.handleJob(
      { id: 'f5', method: 'fetchPostAnalytics', accountId: 'a', accountHandle: 'alice', payload: { fetcherAccountIds: ['a'] } },
      ctx,
    );
    expect(data.items).toHaveLength(2);
    expect(data.items[0]).toMatchObject({ postId: '2001', views: 0, bookmarks: 0, likes: 5 });
    expect(data.items[1]).toMatchObject({ postId: '2003', text: 'wrapped', views: 9, likes: 1 });
  });
});

describe('投稿の失敗が見える形で返る（再現テスト）', () => {
  it('バンドル走査が遅くても締切までにフォールバック付きで返す', async () => {
    const chromeStub = makeChromeStub();
    // トップページの取得が永遠に終わらない（現実には遅い回線・X側の遅延）。
    const fetchStub = () => new Promise(() => {});
    const sandbox = loadExtension(chromeStub, fetchStub);
    const started = Date.now();
    const ids = await sandbox.XManagerQueryIds.resolve({
      fetchImpl: fetchStub,
      storage: chromeStub.storage.local,
      scanDeadlineMs: 100,
      timeouts: { homeMs: 50, bundleMs: 50 },
    });
    // 締切を大幅に超えて待たされないこと（アプリ側の30秒タイムアウト内）。
    expect(Date.now() - started).toBeLessThan(5000);
    expect(ids.CreateTweet).toBe('bDE2rBtZb3uyrczSZ_pI9g');
  });

  it('並行する解決は1回の走査を共有する', async () => {
    const chromeStub = makeChromeStub();
    let homeCalls = 0;
    const fetchStub = makeFetchStub([
      {
        match: (url) => url === 'https://x.com/',
        handle: () => {
          homeCalls += 1;
          return textResponse(
            200,
            '<script src="https://abs.twimg.com/responsive-web/client-web/main.a.js"></script>',
          );
        },
      },
      {
        match: (url) => url.includes('main.a.js'),
        handle: () => textResponse(200, '"/i/api/graphql/AAA/CreateTweet"'),
      },
    ]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const deps = { fetchImpl: fetchStub, storage: chromeStub.storage.local };
    const [a, b] = await Promise.all([
      sandbox.XManagerQueryIds.resolve(deps),
      sandbox.XManagerQueryIds.resolve(deps),
    ]);
    expect(a.CreateTweet).toBe('AAA');
    expect(b.CreateTweet).toBe('AAA');
    expect(homeCalls).toBe(1);
  });

  it('終わらないジョブがあってもキューは詰まらない（タイムアウトで切る）', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub([]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const never = new Promise(() => {});
    await expect(
      sandbox.XManagerSession.withSession(
        'a',
        async () => never,
        { sessions, chrome: chromeStub, fetchImpl: fetchStub, queueTimeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('時間切れ') });
    // キューが詰まっていない：次のジョブは普通に動く。
    const seen = await sandbox.XManagerSession.withSession(
      'a',
      async (auth: AnyRecord) => auth.ct0,
      { sessions, chrome: chromeStub, fetchImpl: fetchStub },
    );
    expect(seen).toBe('ct0-a');
  });

  it('ct0取得の fetch が終わらなくてもタイムアウトして失敗する', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = () => new Promise(() => {});
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice' },
    });
    await expect(
      sandbox.XManagerSession.withSession(
        'a',
        async (auth: AnyRecord) => auth.ct0,
        { sessions, chrome: chromeStub, fetchImpl: fetchStub, ct0TimeoutMs: 100 },
      ),
    ).rejects.toMatchObject({ code: 'x_error', message: expect.stringContaining('ct0') });
  });

  it('書き込みの403はトランザクションIDの生成失敗が分かる文言で返す', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub([
      { match: GRAPHQL('CreateTweet'), handle: () => jsonResponse(403, {}) },
    ]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const ctx = makeCtx({ sessions, chrome: chromeStub, fetch: fetchStub });
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'j-403',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x' } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'x_error',
      message: expect.stringContaining('トランザクションIDの生成に失敗'),
    });
  });

  it('GraphQL の 400 は query ID が古い可能性を伝える', async () => {
    const chromeStub = makeChromeStub();
    const fetchStub = makeFetchStub([
      { match: GRAPHQL('CreateTweet'), handle: () => jsonResponse(400, {}) },
    ]);
    const sandbox = loadExtension(chromeStub, fetchStub);
    const sessions = makeSessionsStub({
      a: { authToken: 'token-a', handle: 'alice', ct0: 'ct0-a' },
    });
    const ctx = makeCtx({ sessions, chrome: chromeStub, fetch: fetchStub });
    await expect(
      sandbox.XManagerDispatch.handleJob(
        {
          id: 'j-400',
          method: 'executePost',
          accountId: 'a',
          accountHandle: 'alice',
          payload: { content: { text: 'x' } },
        },
        ctx,
      ),
    ).rejects.toMatchObject({
      code: 'x_error',
      message: expect.stringContaining('query ID'),
    });
  });
});

describe('background の配線', () => {
  type BgListener = (
    message: unknown,
    sender: unknown,
    sendResponse: (r: unknown) => void,
  ) => boolean;

  /** background.js を vm で読み込み、onMessage リスナーを返す。 */
  function loadBackground(chromeStub: AnyRecord, fetchStub: AnyRecord) {
    let listener: BgListener | null = null;
    chromeStub.runtime = {
      onMessage: {
        addListener: (fn: BgListener) => {
          listener = fn;
        },
      },
    };
    const sandbox: AnyRecord = {
      console,
      chrome: chromeStub,
      fetch: fetchStub,
      setTimeout,
      clearTimeout,
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
    return {
      getListener: () => listener,
    };
  }

  function sendToBackground(
    listener: BgListener,
    message: unknown,
  ): Promise<AnyRecord> {
    return new Promise<AnyRecord>((resolve) => {
      listener(message, {}, (r: unknown) => resolve(r as AnyRecord));
    });
  }

  it('hello-ack は Cookie API の診断を付けて返す', async () => {
    const { getListener } = loadBackground(makeChromeStub(), makeFetchStub([]));
    const listener = getListener();
    expect(listener).not.toBe(null);
    const ack = await sendToBackground(listener!, {
      source: 'x-manager',
      kind: 'hello',
    });
    expect(ack).toMatchObject({
      source: 'x-manager-extension',
      kind: 'hello-ack',
      version: 1,
      extensionVersion: '0.1.0',
      diagnostics: { cookiesApi: true },
    });
  });

  it('chrome.cookies が無ければ hello-ack の診断は cookiesApi:false になる', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    delete chromeStub.cookies;
    const { getListener } = loadBackground(chromeStub, makeFetchStub([]));
    const listener = getListener();
    expect(listener).not.toBe(null);
    const ack = await sendToBackground(listener!, {
      source: 'x-manager',
      kind: 'hello',
    });
    expect(ack).toMatchObject({ diagnostics: { cookiesApi: false } });
  });

  it('Cookie API が無い状態の checkAccount は extension_broken の結果を返す', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    delete chromeStub.cookies;
    const storageData: Record<string, unknown> = {
      'xmanager.sessions.v1': {
        acc1: { authToken: 'x'.repeat(40), handle: 'foo', linkedAt: 1 },
      },
    };
    chromeStub.storage = {
      local: {
        get: async (key: string) =>
          storageData[key] !== undefined ? { [key]: storageData[key] } : {},
        set: async (obj: AnyRecord) => Object.assign(storageData, obj),
      },
    };
    const { getListener } = loadBackground(chromeStub, makeFetchStub([]));
    const listener = getListener();
    expect(listener).not.toBe(null);
    const result = await sendToBackground(listener!, {
      source: 'x-manager',
      kind: 'job',
      id: 'j-broken',
      method: 'checkAccount',
      accountId: 'acc1',
      accountHandle: 'foo',
      payload: {},
    });
    expect(result).toMatchObject({
      id: 'j-broken',
      ok: false,
      code: 'extension_broken',
      error: expect.stringContaining('Cookie'),
    });
  });

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
    for (const file of ['errors.js', 'queryIds.js', 'session.js', 'xClient.js', 'transactionId.js', 'mediaStore.js', 'sessionImport.js', 'dispatch.js']) {
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

describe('ログイン中のアカウントの取り込み（sessionImport + background）', () => {
  type BgListener = (
    message: unknown,
    sender: unknown,
    sendResponse: (r: unknown) => void,
  ) => boolean;

  /** background.js を vm で読み込み、onMessage リスナーを返す。 */
  function loadBackgroundForImport(chromeStub: AnyRecord, fetchStub: AnyRecord) {
    let listener: BgListener | null = null;
    chromeStub.runtime = {
      onMessage: {
        addListener: (fn: BgListener) => {
          listener = fn;
        },
      },
    };
    const sandbox: AnyRecord = {
      console,
      chrome: chromeStub,
      fetch: fetchStub,
      setTimeout,
      clearTimeout,
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
    return { getListener: () => listener };
  }

  function sendImport(listener: BgListener): Promise<AnyRecord> {
    return new Promise<AnyRecord>((resolve) => {
      listener(
        { source: 'x-manager-popup', kind: 'import-current-account' },
        {},
        (r: unknown) => resolve(r as AnyRecord),
      );
    });
  }

  /** verify_credentials の成功応答を返すルート。 */
  function verifyCredentialsRoute(user: AnyRecord) {
    return {
      match: (url: string) => url.includes('account/verify_credentials.json'),
      handle: () => jsonResponse(200, user),
    };
  }

  function storedSessions(chromeStub: AnyRecord): AnyRecord | undefined {
    return chromeStub.storage.local._data['xmanager.sessions.v1'];
  }

  it('Cookie から読んだトークンで本人確認し、IDとハンドルだけを返す', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    chromeStub.cookies._cookies['auth_token'] = 'a'.repeat(40);
    chromeStub.cookies._cookies['ct0'] = 'ct0value';
    const fetchStub = makeFetchStub([
      verifyCredentialsRoute({ id_str: '12345', screen_name: 'testuser' }),
    ]);
    const { getListener } = loadBackgroundForImport(chromeStub, fetchStub);
    const result = await sendImport(getListener()!);
    expect(result).toEqual({ ok: true, accountId: '12345', handle: 'testuser' });
    // トークンの値は応答にも保管庫の返り値にも出ない
    expect(JSON.stringify(result)).not.toContain('a'.repeat(40));
    const stored = storedSessions(chromeStub);
    expect(stored).toBeDefined();
    expect(stored!['12345']).toMatchObject({ authToken: 'a'.repeat(40), handle: 'testuser' });
  });

  it('auth_token の Cookie が無ければ「Xにログインしていません」を返す', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    const fetchStub = makeFetchStub([
      verifyCredentialsRoute({ id_str: '12345', screen_name: 'testuser' }),
    ]);
    const { getListener } = loadBackgroundForImport(chromeStub, fetchStub);
    const result = await sendImport(getListener()!);
    expect(result).toMatchObject({
      ok: false,
      code: 'x_error',
      error: expect.stringContaining('Xにログインしていません'),
    });
    expect(storedSessions(chromeStub)).toBeUndefined();
    expect(fetchStub.calls).toHaveLength(0);
  });

  it('本人確認が 403 なら手入力への誘導を返し、セッションは保存しない', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    chromeStub.cookies._cookies['auth_token'] = 'a'.repeat(40);
    chromeStub.cookies._cookies['ct0'] = 'ct0value';
    const fetchStub = makeFetchStub([
      {
        match: (url: string) => url.includes('account/verify_credentials.json'),
        handle: () => jsonResponse(403, { errors: [{ message: 'Forbidden' }] }),
      },
    ]);
    const { getListener } = loadBackgroundForImport(chromeStub, fetchStub);
    const result = await sendImport(getListener()!);
    expect(result).toMatchObject({
      ok: false,
      code: 'x_error',
      error: expect.stringContaining('ログイン中のアカウントを確認できませんでした'),
    });
    expect(storedSessions(chromeStub)).toBeUndefined();
  });

  it('本人確認の応答にID・ハンドルが無ければエラーにし、セッションは保存しない', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    chromeStub.cookies._cookies['auth_token'] = 'a'.repeat(40);
    chromeStub.cookies._cookies['ct0'] = 'ct0value';
    const fetchStub = makeFetchStub([verifyCredentialsRoute({})]);
    const { getListener } = loadBackgroundForImport(chromeStub, fetchStub);
    const result = await sendImport(getListener()!);
    expect(result).toMatchObject({
      ok: false,
      code: 'x_error',
      error: expect.stringContaining('ログイン中のアカウントを確認できませんでした'),
    });
    expect(storedSessions(chromeStub)).toBeUndefined();
  });

  it('Cookie API が無ければ extension_broken を返す（生の TypeError にならない）', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    delete chromeStub.cookies;
    const fetchStub = makeFetchStub([
      verifyCredentialsRoute({ id_str: '12345', screen_name: 'testuser' }),
    ]);
    const { getListener } = loadBackgroundForImport(chromeStub, fetchStub);
    const result = await sendImport(getListener()!);
    expect(result).toMatchObject({
      ok: false,
      code: 'extension_broken',
      error: expect.stringContaining('Cookie機能が使えません'),
    });
    expect(storedSessions(chromeStub)).toBeUndefined();
  });

  it('ct0 が最初無くても、x.com を開いて付いた ct0 で取り込める', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    chromeStub.cookies._cookies['auth_token'] = 'b'.repeat(40);
    const fetchStub = makeFetchStub([
      {
        match: (url: string) => url === 'https://x.com/',
        handle: () => {
          // X が ct0 を付ける様子を再現する
          chromeStub.cookies._cookies['ct0'] = 'ct0-after-home';
          return textResponse(200, '<html></html>');
        },
      },
      verifyCredentialsRoute({ id_str: '999', screen_name: 'ct0user' }),
    ]);
    const { getListener } = loadBackgroundForImport(chromeStub, fetchStub);
    const result = await sendImport(getListener()!);
    expect(result).toEqual({ ok: true, accountId: '999', handle: 'ct0user' });
    expect(fetchStub.calls.some((c: AnyRecord) => c.url === 'https://x.com/')).toBe(true);
    expect(storedSessions(chromeStub)!['999']).toMatchObject({
      authToken: 'b'.repeat(40),
      handle: 'ct0user',
    });
  });

  it('ct0 がどうしても取れなければエラーにし、セッションは保存しない', async () => {
    const chromeStub = makeChromeStub() as AnyRecord;
    chromeStub.cookies._cookies['auth_token'] = 'c'.repeat(40);
    const fetchStub = makeFetchStub([
      {
        match: (url: string) => url === 'https://x.com/',
        handle: () => textResponse(200, '<html></html>'),
      },
      verifyCredentialsRoute({ id_str: '999', screen_name: 'ct0user' }),
    ]);
    const { getListener } = loadBackgroundForImport(chromeStub, fetchStub);
    const result = await sendImport(getListener()!);
    expect(result).toMatchObject({
      ok: false,
      code: 'x_error',
      error: expect.stringContaining('ct0'),
    });
    expect(storedSessions(chromeStub)).toBeUndefined();
  });

  it('getCurrentUser は verify_credentials の id_str と screen_name を返す', async () => {
    const sandbox = loadExtension(makeChromeStub(), makeFetchStub([
      verifyCredentialsRoute({ id_str: '777', screen_name: 'directuser' }),
    ]));
    const client = sandbox.XManagerXClient.createClient({
      fetchImpl: sandbox.fetch,
      resolveQueryId: async () => null,
    });
    await expect(client.getCurrentUser({ ct0: 'ct0value' })).resolves.toEqual({
      id: '777',
      handle: 'directuser',
    });
  });

  it('getCurrentUser は 401 なら手入力への誘導の文言にする', async () => {
    const sandbox = loadExtension(makeChromeStub(), makeFetchStub([
      {
        match: (url: string) => url.includes('account/verify_credentials.json'),
        handle: () => jsonResponse(401, { errors: [{ message: 'Unauthorized' }] }),
      },
    ]));
    const client = sandbox.XManagerXClient.createClient({
      fetchImpl: sandbox.fetch,
      resolveQueryId: async () => null,
    });
    await expect(client.getCurrentUser({ ct0: 'ct0value' })).rejects.toThrow(
      'ログイン中のアカウントを確認できませんでした',
    );
  });
});
