import { describe, expect, it, vi } from 'vitest';
import { PAGE_SOURCE } from './protocol';
import { DESKTOP_HOST_SOURCE } from './desktopProtocol';
import {
  DesktopNotConnectedError,
  DesktopTimeoutError,
  WindowBridgeTransport,
  type DesktopBridge,
} from './desktopTransport';

function fakeBridge(
  handler: (message: unknown) => unknown | Promise<unknown>,
): DesktopBridge & { invoked: unknown[] } {
  const invoked: unknown[] = [];
  return {
    invoked,
    invoke: async (message: unknown) => {
      invoked.push(message);
      return handler(message);
    },
  };
}

describe('WindowBridgeTransport', () => {
  it('ping は hello-ack を待って版を返す', async () => {
    const bridge = fakeBridge(() => ({
      source: DESKTOP_HOST_SOURCE,
      kind: 'hello-ack',
      version: 1,
      hostVersion: '0.1.0',
    }));
    const transport = new WindowBridgeTransport(bridge);
    const promise = transport.ping(500);
    await expect(promise).resolves.toEqual({ version: 1, hostVersion: '0.1.0' });
    expect(bridge.invoked).toHaveLength(1);
    expect(bridge.invoked[0]).toMatchObject({ source: PAGE_SOURCE, kind: 'hello', version: 1 });
  });

  it('ブリッジが無ければ未接続エラーになる', async () => {
    const transport = new WindowBridgeTransport(undefined);
    await expect(transport.ping(10)).rejects.toBeInstanceOf(DesktopNotConnectedError);
    await expect(
      transport.sendJob({
        id: 'job-1',
        method: 'checkAccount',
        accountId: 'acc-1',
        accountHandle: 'testuser',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(DesktopNotConnectedError);
    await expect(transport.listSessions()).rejects.toBeInstanceOf(DesktopNotConnectedError);
  });

  it('ping の返事がなければ未接続エラーになる', async () => {
    const bridge = fakeBridge(() => new Promise(() => {}));
    const transport = new WindowBridgeTransport(bridge);
    await expect(transport.ping(10)).rejects.toBeInstanceOf(DesktopNotConnectedError);
  });

  it('ping の版が合わなければ未接続エラーになる', async () => {
    const bridge = fakeBridge(() => ({
      source: DESKTOP_HOST_SOURCE,
      kind: 'hello-ack',
      version: 99,
      hostVersion: '0.1.0',
    }));
    const transport = new WindowBridgeTransport(bridge);
    await expect(transport.ping(500)).rejects.toBeInstanceOf(DesktopNotConnectedError);
  });

  it('sendJob は id で相関を取る（別idの結果は受け取らない）', async () => {
    const bridge = fakeBridge(() => {
      return {
        source: DESKTOP_HOST_SOURCE,
        kind: 'result',
        id: 'other-job',
        ok: true,
        data: { status: 'logged_in' },
        at: 5,
      };
    });
    const transport = new WindowBridgeTransport(bridge);
    await expect(
      transport.sendJob({
        id: 'job-1',
        method: 'checkAccount',
        accountId: 'acc-1',
        accountHandle: 'testuser',
        payload: {},
      }),
    ).rejects.toThrow(/IDが一致しません/);
  });

  it('sendJob は結果をそのまま返す', async () => {
    const bridge = fakeBridge((message) => {
      const job = message as { id: string; method: string };
      return {
        source: DESKTOP_HOST_SOURCE,
        kind: 'result',
        id: job.id,
        ok: true,
        data: { status: 'logged_in' },
        at: 5,
      };
    });
    const transport = new WindowBridgeTransport(bridge);
    const result = await transport.sendJob({
      id: 'job-1',
      method: 'checkAccount',
      accountId: 'acc-1',
      accountHandle: 'testuser',
      payload: {},
    });
    expect(result).toMatchObject({ id: 'job-1', ok: true });
    expect(bridge.invoked[0]).toMatchObject({
      source: PAGE_SOURCE,
      kind: 'job',
      method: 'checkAccount',
      accountId: 'acc-1',
    });
  });

  it('sendJob の返事がなければタイムアウトエラーになる', async () => {
    const bridge = fakeBridge(() => new Promise(() => {}));
    const transport = new WindowBridgeTransport(bridge);
    await expect(
      transport.sendJob({
        id: 'job-1',
        method: 'checkAccount',
        accountId: 'acc-1',
        accountHandle: 'testuser',
        payload: {},
        timeoutMs: 10,
      }),
    ).rejects.toBeInstanceOf(DesktopTimeoutError);
  });

  it('listSessions は sessions を正規化して返す', async () => {
    const bridge = fakeBridge(() => ({
      source: DESKTOP_HOST_SOURCE,
      kind: 'sessions',
      sessions: [
        { accountId: 'acc-1', handle: '@testuser' },
        { accountId: 'acc-2', handle: '' },
      ],
    }));
    const transport = new WindowBridgeTransport(bridge);
    await expect(transport.listSessions()).resolves.toEqual([
      { accountId: 'acc-1', handle: 'testuser' },
      { accountId: 'acc-2', handle: null },
    ]);
  });

  it('listSessions は旧形式（accountIds）にも対応する', async () => {
    const bridge = fakeBridge(() => ({
      source: DESKTOP_HOST_SOURCE,
      kind: 'sessions',
      accountIds: ['acc-1', 'acc-2'],
    }));
    const transport = new WindowBridgeTransport(bridge);
    await expect(transport.listSessions()).resolves.toEqual([
      { accountId: 'acc-1', handle: null },
      { accountId: 'acc-2', handle: null },
    ]);
  });

  it('invoke が拒否したらそのエラーを通す', async () => {
    const bridge: DesktopBridge = {
      invoke: vi.fn().mockRejectedValue(new Error('ホスト側で失敗しました')),
    };
    const transport = new WindowBridgeTransport(bridge);
    await expect(transport.ping(500)).rejects.toThrow('ホスト側で失敗しました');
  });
});

describe('WindowBridgeTransport.openLogin', () => {
  it('openLogin は open-login を送って結果を返す', async () => {
    const bridge = fakeBridge(() => ({
      source: DESKTOP_HOST_SOURCE,
      kind: 'open-login-result',
      accountId: 'acc-1',
      ok: true,
      xUserId: '12345',
      handle: 'alice',
    }));
    const transport = new WindowBridgeTransport(bridge);
    await expect(transport.openLogin('acc-1')).resolves.toEqual({
      source: DESKTOP_HOST_SOURCE,
      kind: 'open-login-result',
      accountId: 'acc-1',
      ok: true,
      xUserId: '12345',
      handle: 'alice',
    });
    expect(bridge.invoked[0]).toMatchObject({
      source: PAGE_SOURCE,
      kind: 'open-login',
      accountId: 'acc-1',
    });
  });

  it('openLogin は別アカウントの結果は受け取らない', async () => {
    const bridge = fakeBridge(() => ({
      source: DESKTOP_HOST_SOURCE,
      kind: 'open-login-result',
      accountId: 'acc-2',
      ok: true,
      xUserId: '12345',
      handle: 'alice',
    }));
    const transport = new WindowBridgeTransport(bridge);
    await expect(transport.openLogin('acc-1')).rejects.toThrow('アカウントIDが一致しません');
  });

  it('openLogin はブリッジが無ければ未接続エラーになる', async () => {
    const transport = new WindowBridgeTransport(undefined);
    await expect(transport.openLogin('acc-1')).rejects.toBeInstanceOf(DesktopNotConnectedError);
  });
});
