import { describe, expect, it, vi } from 'vitest';
import { createBridgeHandler, DESKTOP_HOST_SOURCE, HOST_VERSION, PROTOCOL_VERSION } from './bridge.cjs';

describe('createBridgeHandler', () => {
  it('hello には hello-ack を返す', async () => {
    const handle = createBridgeHandler();
    const reply = await handle({ source: 'x-manager', kind: 'hello', version: 1 });
    expect(reply).toEqual({
      source: DESKTOP_HOST_SOURCE,
      kind: 'hello-ack',
      version: PROTOCOL_VERSION,
      hostVersion: HOST_VERSION,
    });
    expect(PROTOCOL_VERSION).toBe(1);
    expect(HOST_VERSION).toBe('0.1.0');
  });

  it('list-sessions は既定で空の一覧を返す', async () => {
    const handle = createBridgeHandler();
    const reply = await handle({ source: 'x-manager', kind: 'list-sessions' });
    expect(reply).toEqual({ source: DESKTOP_HOST_SOURCE, kind: 'sessions', sessions: [] });
  });

  it('list-sessions は deps.listSessions を使う', async () => {
    const handle = createBridgeHandler({
      listSessions: async () => [
        { accountId: 'acc-1', handle: 'alice' },
        { accountId: '', handle: '壊れた項目' },
        { accountId: 'acc-2', handle: '' },
      ],
    });
    const reply = await handle({ source: 'x-manager', kind: 'list-sessions' });
    expect(reply).toEqual({
      source: DESKTOP_HOST_SOURCE,
      kind: 'sessions',
      sessions: [
        { accountId: 'acc-1', handle: 'alice' },
        { accountId: 'acc-2', handle: null },
      ],
    });
  });

  it('job は Phase 0 では not_implemented を返す', async () => {
    const handle = createBridgeHandler();
    const reply = await handle({
      source: 'x-manager',
      kind: 'job',
      id: 'job-1',
      method: 'checkAccount',
      accountId: 'acc-1',
      accountHandle: 'alice',
      payload: {},
    });
    expect(reply).toMatchObject({
      source: DESKTOP_HOST_SOURCE,
      kind: 'result',
      id: 'job-1',
      ok: false,
      code: 'not_implemented',
    });
    expect(typeof reply.error).toBe('string');
    expect(typeof reply.at).toBe('number');
  });

  it('job は deps.handleJob があれば委譲する', async () => {
    const handleJob = vi.fn().mockResolvedValue({
      id: 'job-2',
      ok: true,
      data: { status: 'logged_in' },
      at: 42,
    });
    const handle = createBridgeHandler({ handleJob });
    const job = {
      source: 'x-manager',
      kind: 'job',
      id: 'job-2',
      method: 'checkAccount',
      accountId: 'acc-1',
      accountHandle: 'alice',
      payload: {},
    };
    const reply = await handle(job);
    expect(handleJob).toHaveBeenCalledWith(job);
    expect(reply).toEqual({
      source: DESKTOP_HOST_SOURCE,
      kind: 'result',
      id: 'job-2',
      ok: true,
      data: { status: 'logged_in' },
      at: 42,
    });
  });

  it('壊れた入力には例外を投げず ok:false の result を返す', async () => {
    const handle = createBridgeHandler();
    for (const bad of [null, undefined, 'hello', 42, [], {}]) {
      const reply = await handle(bad);
      expect(reply).toMatchObject({
        source: DESKTOP_HOST_SOURCE,
        kind: 'result',
        id: '',
        ok: false,
        code: 'unknown',
      });
    }
  });

  it('形の壊れたジョブは id が取れればそれを付けて unknown を返す', async () => {
    const handle = createBridgeHandler();
    const reply = await handle({
      source: 'x-manager',
      kind: 'job',
      id: 'job-9',
      method: 'checkAccount',
      // accountId が無い
      payload: {},
    });
    expect(reply).toMatchObject({ kind: 'result', id: 'job-9', ok: false, code: 'unknown' });
  });

  it('未知の kind は not_implemented の結果を返す', async () => {
    const handle = createBridgeHandler();
    const reply = await handle({ source: 'x-manager', kind: 'ping-pong', id: 'job-3' });
    expect(reply).toMatchObject({
      kind: 'result',
      id: 'job-3',
      ok: false,
      code: 'not_implemented',
    });
  });

  it('委譲先が例外を投げても ok:false の result になる', async () => {
    const handle = createBridgeHandler({
      handleJob: async () => {
        throw new Error('ホスト部品で失敗しました');
      },
    });
    const reply = await handle({
      source: 'x-manager',
      kind: 'job',
      id: 'job-4',
      method: 'checkAccount',
      accountId: 'acc-1',
      accountHandle: 'alice',
      payload: {},
    });
    expect(reply).toMatchObject({
      kind: 'result',
      id: 'job-4',
      ok: false,
      code: 'unknown',
      error: 'ホスト部品で失敗しました',
    });
  });
});
