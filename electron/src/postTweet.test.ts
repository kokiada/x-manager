import { webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
  BEARER_TOKEN,
  CREATE_TWEET_FALLBACK_QUERY_ID,
  buildPostTweetScript,
  buildPostTweetVariables,
  buildTransactionIdScript,
  classifyPostTweetResult,
  generateTransactionId,
  loadTransactionIdSource,
  parseCreateTweet,
  runPostTweet,
  runPostTweetForAccount,
} from './postTweet.cjs';

/** 成功時の CreateTweet 応答（実データ相当の形）。 */
const SUCCESS_BODY = JSON.stringify({
  data: {
    create_tweet: {
      tweet_results: {
        result: { __typename: 'Tweet', rest_id: '1999999999999999999' },
      },
    },
  },
});

/** TweetWithVisibilityResults で包まれた成功応答。 */
const WRAPPED_SUCCESS_BODY = JSON.stringify({
  data: {
    create_tweet: {
      tweet_results: {
        result: {
          __typename: 'TweetWithVisibilityResults',
          tweet: { __typename: 'Tweet', rest_id: '1888888888888888888' },
        },
      },
    },
  },
});

/** ページ文脈スクリプトを Node 上で動かすための document / fetch の差し替え。 */
function withPageStubs({ cookie = 'ct0=csrf-token-abc; auth_token=secret', fetchImpl }) {
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;
  globalThis.document = { cookie };
  globalThis.fetch = fetchImpl;
  return () => {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    if (prevFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = prevFetch;
  };
}

describe('buildPostTweetVariables', () => {
  it('xClient.postTweet と同じ形の variables を作る', () => {
    expect(buildPostTweetVariables('hello')).toEqual({
      tweet_text: 'hello',
      reply: undefined,
      media: { media_entities: [], possibly_sensitive: false },
      dark: false,
      semantic_annotation_ids: [],
    });
  });

  it('media_ids・reply・community_id・reply_settings を付ける', () => {
    const vars = buildPostTweetVariables('hi', {
      replyToId: '111',
      mediaIds: ['222'],
      communityId: '333',
      replyPermission: 'following',
    });
    expect(vars.reply).toEqual({ in_reply_to_status_id: '111', exclude_reply_user_ids: [] });
    expect(vars.media.media_entities).toEqual([{ media_id: '222', tagged_users: [] }]);
    expect(vars.community_id).toBe('333');
    expect(vars.reply_settings).toBe('following');
  });

  it('replyPermission が everyone のときは reply_settings を付けない', () => {
    expect(buildPostTweetVariables('hi', { replyPermission: 'everyone' }).reply_settings).toBeUndefined();
  });
});

describe('buildPostTweetScript', () => {
  it('CreateTweet の URL・ct0・bearer・features を含む', () => {
    const script = buildPostTweetScript({ queryId: CREATE_TWEET_FALLBACK_QUERY_ID, text: 'hello' });
    expect(script).toContain(`https://x.com/i/api/graphql/${CREATE_TWEET_FALLBACK_QUERY_ID}/CreateTweet`);
    expect(script).toContain('x-csrf-token');
    expect(script).toContain("credentials: 'include'");
    expect(script).toContain('AbortSignal.timeout');
    expect(script).toContain('possibly_sensitive');
    // auth_token の値をスクリプトに埋め込まない（ページ文脈の Cookie に任せる）。
    expect(script).not.toContain('auth_token=');
    expect(script).not.toContain('csrf-token-abc');
  });

  it('スタブ fetch で成功応答を { status, body } で返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => SUCCESS_BODY,
    });
    const restore = withPageStubs({ fetchImpl });
    try {
      // eslint-disable-next-line no-eval
      const result = await eval(buildPostTweetScript({ queryId: 'qid123', text: 'hello', txId: 'tx-abc' }));
      expect(result).toEqual({ status: 200, body: SUCCESS_BODY });
      expect(fetchImpl).toHaveBeenCalledWith(
        'https://x.com/i/api/graphql/qid123/CreateTweet',
        expect.objectContaining({
          method: 'POST',
          credentials: 'include',
          headers: expect.objectContaining({
            'x-csrf-token': 'csrf-token-abc',
            authorization: `Bearer ${BEARER_TOKEN}`,
            'x-client-transaction-id': 'tx-abc',
            'content-type': 'application/json',
          }),
        }),
      );
      const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
      expect(body.variables.tweet_text).toBe('hello');
      expect(body.variables.media.possibly_sensitive).toBe(false);
      expect(body.features).toBeDefined();
    } finally {
      restore();
    }
  });

  it('txId が無ければトランザクションヘッダを付けない', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, text: async () => SUCCESS_BODY });
    const restore = withPageStubs({ fetchImpl });
    try {
      // eslint-disable-next-line no-eval
      await eval(buildPostTweetScript({ queryId: 'qid123', text: 'hello' }));
      expect(fetchImpl.mock.calls[0][1].headers['x-client-transaction-id']).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('fetch が投げたら { status: 0, error } を返す', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const restore = withPageStubs({ fetchImpl });
    try {
      // eslint-disable-next-line no-eval
      const result = await eval(buildPostTweetScript({ queryId: 'qid123', text: 'hello' }));
      expect(result).toEqual({ status: 0, error: 'Failed to fetch' });
    } finally {
      restore();
    }
  });

  it('空のテキストではスクリプトを作らない', () => {
    expect(() => buildPostTweetScript({ queryId: 'qid123', text: '' })).toThrow(/テキストがありません/);
  });
});

describe('parseCreateTweet', () => {
  it('rest_id と投稿 URL を取る', () => {
    expect(parseCreateTweet(JSON.parse(SUCCESS_BODY))).toEqual({
      postId: '1999999999999999999',
      postUrl: 'https://x.com/i/status/1999999999999999999',
    });
  });

  it('TweetWithVisibilityResults の中の tweet を見る', () => {
    expect(parseCreateTweet(JSON.parse(WRAPPED_SUCCESS_BODY))).toEqual({
      postId: '1888888888888888888',
      postUrl: 'https://x.com/i/status/1888888888888888888',
    });
  });

  it('投稿 ID が読めなければ投げる', () => {
    expect(() => parseCreateTweet({ data: {} })).toThrow(/投稿ID/);
    expect(() => parseCreateTweet({})).toThrow(/投稿ID/);
    expect(() => parseCreateTweet(null)).toThrow(/投稿ID/);
  });
});

describe('classifyPostTweetResult', () => {
  it('200 の正常応答は { postId, postUrl } を返す', () => {
    expect(classifyPostTweetResult({ status: 200, body: SUCCESS_BODY })).toEqual({
      ok: true,
      postId: '1999999999999999999',
      postUrl: 'https://x.com/i/status/1999999999999999999',
    });
  });

  it('status 0（通信失敗）はネットワーク文言で返す', () => {
    const result = classifyPostTweetResult({ status: 0, error: 'Failed to fetch' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('通信に失敗しました');
    expect(result.error).toContain('Failed to fetch');
  });

  it('429 はレートリミット文言で返す', () => {
    expect(classifyPostTweetResult({ status: 429, body: '' }).error).toContain('レートリミット');
  });

  it('401 はセッション切れ文言で返す', () => {
    expect(classifyPostTweetResult({ status: 401, body: '' }).error).toContain('セッションが切れています');
  });

  it('403 はトランザクションIDの有無で文言を変える', () => {
    const withTx = classifyPostTweetResult({ status: 403, body: '' }, { txAttached: true });
    expect(withTx.error).toContain('トランザクションIDを付けて送っても拒否');
    const withoutTx = classifyPostTweetResult({ status: 403, body: '' }, { txAttached: false });
    expect(withoutTx.error).toContain('ヘッダ無しで送り');
  });

  it('400 / 404 は query ID の文言で返す', () => {
    for (const status of [400, 404]) {
      const result = classifyPostTweetResult({ status, body: '' });
      expect(result.error).toContain(`HTTP ${status}`);
      expect(result.error).toContain('query ID');
    }
  });

  it('その他の非 2xx は HTTP ステータスと X のエラー詳細を返す', () => {
    const result = classifyPostTweetResult({
      status: 422,
      body: JSON.stringify({ errors: [{ message: 'Invalid credentials' }] }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 422');
    expect(result.error).toContain('Invalid credentials');
  });

  it('200 でも JSON でなければ読み取れない文言で返す', () => {
    expect(classifyPostTweetResult({ status: 200, body: '<html>not json</html>' }).error).toContain(
      '読み取れませんでした',
    );
  });

  it('200 で errors 配列があれば X のエラー文言とトランザクション注記を返す', () => {
    const result = classifyPostTweetResult(
      { status: 200, body: JSON.stringify({ errors: [{ message: 'Daily limit' }] }) },
      { txAttached: true },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Xがエラーを返しました');
    expect(result.error).toContain('Daily limit');
    expect(result.error).toContain('トランザクションIDは付けて送りました');
  });

  it('200 で投稿 ID が読めなければその文言で返す', () => {
    const result = classifyPostTweetResult({ status: 200, body: JSON.stringify({ data: {} }) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('投稿ID');
  });

  it('結果がオブジェクトでなければ読み取れない文言で返す', () => {
    expect(classifyPostTweetResult(null).ok).toBe(false);
    expect(classifyPostTweetResult('oops').error).toContain('読み取れませんでした');
  });
});

describe('generateTransactionId（生成器の流用）', () => {
  it('loadTransactionIdSource は transactionId.js のソースを返す', () => {
    const src = loadTransactionIdSource();
    expect(src).toContain('XManagerTransactionId');
    expect(src).toContain('createGenerator');
  });

  it('buildTransactionIdScript は生成器の呼び出しを含む', () => {
    const script = buildTransactionIdScript('https://x.com/i/api/graphql/qid123/CreateTweet');
    expect(script).toContain('XManagerTransactionId');
    expect(script).toContain('createGenerator');
    expect(script).toContain('https://x.com/i/api/graphql/qid123/CreateTweet');
  });

  it('生成器の載せ込み＋生成ができれば ID を返す', async () => {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce('tx-id-abc');
    const result = await generateTransactionId(
      { executeJavaScript },
      'https://x.com/i/api/graphql/qid123/CreateTweet',
    );
    expect(result).toBe('tx-id-abc');
    expect(executeJavaScript).toHaveBeenCalledTimes(2);
    expect(executeJavaScript.mock.calls[0][0]).toContain('XManagerTransactionId');
  });

  it('生成が null なら null を返す（ヘッダ無しで送る側に任せる）', async () => {
    const executeJavaScript = vi.fn().mockResolvedValue(null);
    const result = await generateTransactionId(
      { executeJavaScript },
      'https://x.com/i/api/graphql/qid123/CreateTweet',
    );
    expect(result).toBeNull();
  });

  it('executeJavaScript が拒否されても例外を投げず null を返す', async () => {
    const executeJavaScript = vi.fn().mockRejectedValue(new Error('Object has been destroyed'));
    const result = await generateTransactionId(
      { executeJavaScript },
      'https://x.com/i/api/graphql/qid123/CreateTweet',
    );
    expect(result).toBeNull();
  });

  it('executeJavaScript が無い webContents は null を返す', async () => {
    expect(
      await generateTransactionId({}, 'https://x.com/i/api/graphql/qid123/CreateTweet'),
    ).toBeNull();
  });
});

describe('生成器そのものがページ文脈相当（DOM なし・fetch 差し替え）で動く', () => {
  // src/executor/transactionId.test.ts と同じ合成シェルを使う。
  const KEY_BYTES = [10, 20, 30, 40, 50, 6, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
  const VERIFICATION_KEY = Buffer.from(KEY_BYTES).toString('base64');
  const ONDEMAND_HASH = 'abcdefg123';
  const ONDEMAND_URL = `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${ONDEMAND_HASH}a.js`;
  const ONDEMAND_SOURCE =
    `var runtime = { 123: "ondemand.s", foo: 1 })[e] || e) + "." + ({ 123: "${ONDEMAND_HASH}" });\n` +
    `var idx = (k[2], 16); var a = (k[5], 16); var b = (k[7], 16); var c = (k[1], 16);`;

  function animationPathD() {
    const segment = 'C0 32 64 96 128 160 192 224 255 16 48 80';
    return `M12345678${segment.repeat(16)}`;
  }

  function homepageHtml() {
    const frames = [0, 1, 2, 3]
      .map(
        (i) =>
          `<g id="loading-x-anim-${i}"><g><path d="M11111111"/><path d="${i === 2 ? animationPathD() : 'M12345678C0 1 2 3 4 5 6 7 8 9 10 11'}"/></g><circle r="1"/></g>`,
      )
      .join('');
    return (
      `<html><head>` +
      `<meta name="twitter-site-verification" content="${VERIFICATION_KEY}">` +
      `<script>var runtime = { 123: "ondemand.s", foo: 1 })[e] || e) + "." + ({ 123: "${ONDEMAND_HASH}" });</script>` +
      `</head><body><svg>${frames}</svg></body></html>`
    );
  }

  function textResponse(status: number, text: string) {
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  }

  it('流用した生成器が Service Worker の外でもトランザクションIDを作れる', async () => {
    const fetchStub = async (url: string) => {
      if (url === 'https://x.com/i/jf/') return textResponse(200, homepageHtml());
      if (url === ONDEMAND_URL) return textResponse(200, ONDEMAND_SOURCE);
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sandbox: Record<string, any> = {
      console,
      AbortController,
      setTimeout,
      clearTimeout,
      TextEncoder,
      URL,
      crypto: webcrypto,
      btoa: globalThis.btoa,
      atob: globalThis.atob,
      fetch: fetchStub,
    };
    sandbox.self = sandbox;
    const ctx = createContext(sandbox);
    runInContext(loadTransactionIdSource(), ctx, { filename: 'transactionId.js' });
    const gen = sandbox.XManagerTransactionId.createGenerator({ fetchImpl: fetchStub });
    const id = await gen('POST', 'https://x.com/i/api/graphql/qid123/CreateTweet');
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    expect(id).toMatch(/^[A-Za-z0-9+/]+$/);
    // 2回目はキャッシュされた鍵で作り直す（シェルを再取得しない）。
    const id2 = await gen('POST', 'https://x.com/i/api/graphql/qid123/CreateTweet');
    expect(typeof id2).toBe('string');
    expect(id2.length).toBeGreaterThan(0);
  });
});

describe('runPostTweet', () => {
  /** webContents の最小の偽物。生成器の載せ込み→ID生成→投稿の3回を受ける。 */
  function fakeWebContents(postResult, txId: string | null = 'tx-id-abc') {
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(undefined) // 生成器ソースの載せ込み
      .mockResolvedValueOnce(txId) // トランザクションID生成
      .mockResolvedValue(postResult); // 投稿
    return { webContents: { executeJavaScript }, executeJavaScript };
  }

  it('ページ文脈の成功応答から { postId, postUrl } を返す', async () => {
    const f = fakeWebContents({ status: 200, body: SUCCESS_BODY });
    const result = await runPostTweet(f.webContents, { text: 'hello' });
    expect(result).toEqual({
      ok: true,
      postId: '1999999999999999999',
      postUrl: 'https://x.com/i/status/1999999999999999999',
    });
    expect(f.executeJavaScript).toHaveBeenCalledTimes(3);
    const postScript = f.executeJavaScript.mock.calls[2][0];
    expect(postScript).toContain('CreateTweet');
    expect(postScript).toContain('hello');
  });

  it('トランザクションID生成が null でもヘッダ無しで投稿する', async () => {
    const f = fakeWebContents({ status: 200, body: SUCCESS_BODY }, null);
    const result = await runPostTweet(f.webContents, { text: 'hello' });
    expect(result.ok).toBe(true);
    // 投稿スクリプトの呼び出し引数に txId として null が渡る
    // （pagePostTweet のソース自体にはヘッダ名が残るが、実行時は付かない）。
    const postScript = f.executeJavaScript.mock.calls[2][0];
    expect(postScript).toMatch(/, null, "AAAA/);
  });

  it('403 の応答は ok:false を返す（例外を投げない）', async () => {
    const f = fakeWebContents({ status: 403, body: '' });
    const result = await runPostTweet(f.webContents, { text: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('拒否しました');
  });

  it('空のテキストは ok:false を返す（executeJavaScript を呼ばない）', async () => {
    const f = fakeWebContents({ status: 200, body: SUCCESS_BODY });
    const result = await runPostTweet(f.webContents, { text: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('テキストがありません');
    expect(f.executeJavaScript).not.toHaveBeenCalled();
  });

  it('executeJavaScript が拒否されたら ok:false を返す', async () => {
    const executeJavaScript = vi.fn().mockRejectedValue(new Error('Object has been destroyed'));
    const result = await runPostTweet({ executeJavaScript }, { text: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Object has been destroyed');
  });

  it('executeJavaScript が無い webContents は ok:false を返す', async () => {
    const result = await runPostTweet({}, { text: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('executeJavaScript');
  });

  it('タイムアウトしたら ok:false を返す', async () => {
    const executeJavaScript = vi.fn().mockImplementation(() => new Promise(() => {}));
    const result = await runPostTweet({ executeJavaScript }, { text: 'hello', timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('タイムアウト');
  });
});

describe('runPostTweetForAccount', () => {
  /** electron モジュールの最小の偽物（readCheck.test.ts と同じ形＋close / executeJavaScript）。 */
  function fakeElectron(postResult) {
    const loadURL = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const executeJavaScript = vi
      .fn()
      .mockResolvedValueOnce(undefined) // 生成器ソースの載せ込み
      .mockResolvedValueOnce('tx-id-abc') // トランザクションID生成
      .mockResolvedValue(postResult); // 投稿
    const window = { loadURL, close, webContents: { executeJavaScript } };
    const BrowserWindow = vi.fn().mockImplementation(function BrowserWindowMock() {
      return window;
    });
    const fromPartition = vi.fn().mockReturnValue({ id: 'sess' });
    return {
      electron: { BrowserWindow, session: { fromPartition } },
      BrowserWindow,
      fromPartition,
      window,
      loadURL,
      close,
      executeJavaScript,
    };
  }

  it('partition のウィンドウで投稿し、終わったら閉じる', async () => {
    const f = fakeElectron({ status: 200, body: SUCCESS_BODY });
    const result = await runPostTweetForAccount(f.electron, {
      accountId: 'korosukeada',
      text: 'hello',
    });
    expect(result).toEqual({
      ok: true,
      postId: '1999999999999999999',
      postUrl: 'https://x.com/i/status/1999999999999999999',
    });
    expect(f.fromPartition).toHaveBeenCalledWith('persist:xmgr-korosukeada');
    expect(f.loadURL).toHaveBeenCalledWith('https://x.com/');
    expect(f.executeJavaScript).toHaveBeenCalledTimes(3);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('投稿失敗時もウィンドウを閉じる', async () => {
    const f = fakeElectron({ status: 401, body: '' });
    const result = await runPostTweetForAccount(f.electron, {
      accountId: 'korosukeada',
      text: 'hello',
    });
    expect(result.ok).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('ウィンドウ生成に失敗したら ok:false を返す', async () => {
    const f = fakeElectron({ status: 200, body: SUCCESS_BODY });
    f.loadURL.mockRejectedValueOnce(new Error('ERR_NAME_NOT_RESOLVED'));
    const result = await runPostTweetForAccount(f.electron, {
      accountId: 'korosukeada',
      text: 'hello',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ERR_NAME_NOT_RESOLVED');
    expect(f.close).not.toHaveBeenCalled();
  });
});
