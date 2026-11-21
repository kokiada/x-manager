import { describe, expect, it } from 'vitest';
import { EXTENSION_SOURCE, MEDIA_CHUNK_SIZE, PAGE_SOURCE } from './protocol';
import {
  ExtensionNotConnectedError,
  WindowPostMessageTransport,
  type PostMessageWindow,
} from './transport';

type Listener = (event: MessageEvent) => void;

function fakeWindow(): PostMessageWindow & {
  posted: unknown[];
  dispatch: (data: unknown, source?: unknown) => void;
} {
  const listeners = new Set<Listener>();
  const posted: unknown[] = [];
  const target: PostMessageWindow & {
    posted: unknown[];
    dispatch: (data: unknown, source?: unknown) => void;
  } = {
    posted,
    postMessage(message: unknown) {
      posted.push(message);
    },
    addEventListener(_type: 'message', listener: Listener) {
      listeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: Listener) {
      listeners.delete(listener);
    },
    dispatch(data: unknown, source: unknown = target) {
      for (const listener of [...listeners]) {
        listener({ source, data } as MessageEvent);
      }
    },
  };
  return target;
}

describe('WindowPostMessageTransport', () => {
  it('ping は hello-ack を待って版を返す', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    const promise = transport.ping(500);
    expect(win.posted).toHaveLength(1);
    expect(win.posted[0]).toMatchObject({ source: PAGE_SOURCE, kind: 'hello', version: 1 });
    win.dispatch({
      source: EXTENSION_SOURCE,
      kind: 'hello-ack',
      version: 1,
      extensionVersion: '0.1.0',
    });
    await expect(promise).resolves.toEqual({ version: 1, extensionVersion: '0.1.0' });
  });

  it('ping は hello-ack の診断（Cookie API の可否）も返す', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    const promise = transport.ping(500);
    win.dispatch({
      source: EXTENSION_SOURCE,
      kind: 'hello-ack',
      version: 1,
      extensionVersion: '0.1.0',
      diagnostics: { cookiesApi: false },
    });
    await expect(promise).resolves.toEqual({
      version: 1,
      extensionVersion: '0.1.0',
      diagnostics: { cookiesApi: false },
    });
  });

  it('返事がなければ未接続エラーになる', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    await expect(transport.ping(10)).rejects.toBeInstanceOf(ExtensionNotConnectedError);
  });

  it('sendJob は id で相関を取る（別idの結果は無視する）', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    const promise = transport.sendJob({
      id: 'job-42',
      method: 'executePost',
      accountId: 'acc-1',
      accountHandle: 'testuser',
      payload: { content: { text: 'hi' } },
    });
    const sent = win.posted[0] as Record<string, unknown>;
    expect(sent.kind).toBe('job');
    expect(sent.id).toBe('job-42');

    // 別ジョブの結果が先に届いても無視される
    win.dispatch({
      source: EXTENSION_SOURCE,
      kind: 'result',
      id: 'job-other',
      ok: true,
      data: {},
      at: 1,
    });
    // 正しい id の結果で解決する
    win.dispatch({
      source: EXTENSION_SOURCE,
      kind: 'result',
      id: 'job-42',
      ok: true,
      data: { postId: '777' },
      at: 2,
    });
    await expect(promise).resolves.toMatchObject({ id: 'job-42', ok: true });
  });

  it('listSessions は sessions メッセージを正規化して返す（新形式）', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    const promise = transport.listSessions();
    win.dispatch({
      source: EXTENSION_SOURCE,
      kind: 'sessions',
      sessions: [
        { accountId: 'acc-1', handle: '@foo' },
        { accountId: 'acc-2', handle: null },
      ],
    });
    await expect(promise).resolves.toEqual([
      { accountId: 'acc-1', handle: 'foo' },
      { accountId: 'acc-2', handle: null },
    ]);
  });

  it('listSessions は旧形式（accountIds だけ）も正規化して返す', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    const promise = transport.listSessions();
    win.dispatch({
      source: EXTENSION_SOURCE,
      kind: 'sessions',
      accountIds: ['acc-1'],
    });
    await expect(promise).resolves.toEqual([{ accountId: 'acc-1', handle: null }]);
  });

  it('送信元が違うメッセージは無視する', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    const promise = transport.ping(30);
    // 別ウィンドウ（iframe 等）からの hello-ack は source が違うため無視される。
    win.dispatch(
      {
        source: EXTENSION_SOURCE,
        kind: 'hello-ack',
        version: 1,
        extensionVersion: 'x',
      },
      {},
    );
    await expect(promise).rejects.toBeInstanceOf(ExtensionNotConnectedError);
  });

  it('sendMedia は base64 をチャンクに切って ack ごとに送る', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    const data = 'A'.repeat(MEDIA_CHUNK_SIZE * 2 + 100);
    const promise = transport.sendMedia({
      uploadId: 'u1',
      name: 'a.png',
      mime: 'image/png',
      kind: 'image',
      size: 100,
      dataBase64: data,
    });
    // 3チャンク分：投稿されたチャンクに ack を返すと次へ進む。
    for (let i = 0; i < 3; i++) {
      // 次のチャンクが投稿されるまで待つ。
      for (let tries = 0; tries < 50 && win.posted.length < i + 1; tries++) {
        await new Promise((r) => setTimeout(r, 0));
      }
      const chunk = win.posted[i] as Record<string, unknown>;
      expect(chunk).toMatchObject({
        source: PAGE_SOURCE,
        kind: 'media-chunk',
        uploadId: 'u1',
        index: i,
        totalChunks: 3,
      });
      expect(chunk.data).toBe(data.slice(i * MEDIA_CHUNK_SIZE, (i + 1) * MEDIA_CHUNK_SIZE));
      win.dispatch({
        source: EXTENSION_SOURCE,
        kind: 'media-chunk-ack',
        uploadId: 'u1',
        index: i,
      });
    }
    await expect(promise).resolves.toBeUndefined();
    expect(win.posted).toHaveLength(3);
  });

  it('sendMedia は ack の error をそのまま失敗にする', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    const promise = transport.sendMedia({
      uploadId: 'u2',
      name: 'a.png',
      mime: 'image/png',
      kind: 'image',
      size: 4,
      dataBase64: 'aGVsbG8=',
    });
    for (let tries = 0; tries < 50 && win.posted.length < 1; tries++) {
      await new Promise((r) => setTimeout(r, 0));
    }
    win.dispatch({
      source: EXTENSION_SOURCE,
      kind: 'media-chunk-ack',
      uploadId: 'u2',
      index: 0,
      error: 'メディア転送のデータが base64 ではありません。',
    });
    await expect(promise).rejects.toThrow('base64 ではありません');
  });
});
