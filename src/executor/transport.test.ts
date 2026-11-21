import { describe, expect, it } from 'vitest';
import { EXTENSION_SOURCE, PAGE_SOURCE } from './protocol';
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

  it('listSessions は sessions メッセージを返す', async () => {
    const win = fakeWindow();
    const transport = new WindowPostMessageTransport(win);
    const promise = transport.listSessions();
    win.dispatch({
      source: EXTENSION_SOURCE,
      kind: 'sessions',
      accountIds: ['acc-1'],
    });
    await expect(promise).resolves.toEqual(['acc-1']);
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
});
