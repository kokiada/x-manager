import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Account } from '../db/types';
import {
  DesktopExecutor,
  DESKTOP_ERROR_MESSAGES,
  DESKTOP_NOT_IMPLEMENTED_MESSAGE,
} from './DesktopExecutor';
import { MEDIA_JOB_TIMEOUT_MS } from './protocol';
import type { ExtensionJob, ExtensionJobResult } from './protocol';
import { DesktopNotConnectedError, type DesktopTransport } from './desktopTransport';

function fakeAccount(): Account {
  return {
    id: 'acc-1',
    handle: 'testuser',
    displayName: 'Test User',
    groupId: null,
    proxyGroupId: null,
    status: 'logged_in',
    followers: 100,
    following: 50,
    notifications: 0,
    dmCount: 0,
    searchBan: 'visible',
  } as Account;
}

function fakeTransport(
  handler: (job: ExtensionJob) => ExtensionJobResult | Promise<ExtensionJobResult>,
): DesktopTransport & { sent: ExtensionJob[] } {
  const sent: ExtensionJob[] = [];
  return {
    sent,
    ping: async () => ({ version: 1, hostVersion: '0.1.0' }),
    listSessions: async () => [{ accountId: 'acc-1', handle: 'testuser' }],
    openLogin: async (accountId: string) => ({ ok: true, accountId, xUserId: '999', handle: 'testuser' }),
    sendJob: async (job) => {
      sent.push(job);
      return handler(job);
    },
  };
}

describe('DesktopExecutor', () => {
  it('成功した投稿は結果データを写す', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: true,
      data: { postId: '999', postUrl: 'https://x.com/testuser/status/999' },
      at: 123,
    }));
    const executor = new DesktopExecutor(transport);
    await expect(executor.executePost(fakeAccount(), { text: 'hello' })).resolves.toEqual({
      accountId: 'acc-1',
      ok: true,
      postId: '999',
      postUrl: 'https://x.com/testuser/status/999',
      threadPostIds: undefined,
      at: 123,
    });
  });

  it('投稿の失敗はホストの理由文を優先する', async () => {
    const transport = fakeTransport(() => ({
      id: 'job-1',
      ok: false,
      code: 'x_error',
      error: 'X から弾かれました',
      at: 8,
    }));
    const executor = new DesktopExecutor(transport);
    const result = await executor.executePost(fakeAccount(), { text: 'hello' });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('X から弾かれました');
  });

  it('理由文が無い失敗は分類ごとのデスクトップ向け文言になる', async () => {
    const transport = fakeTransport(() => ({
      id: 'job-1',
      ok: false,
      code: 'no_session',
      at: 8,
    }));
    const executor = new DesktopExecutor(transport);
    const result = await executor.executePost(fakeAccount(), { text: 'hello' });
    expect(result.error).toBe(DESKTOP_ERROR_MESSAGES.no_session);
    expect(result.error).toContain('デスクトップアプリ');
  });

  it('not_implemented はデスクトップ向け文言になる', async () => {
    const transport = fakeTransport(() => ({
      id: 'job-1',
      ok: false,
      code: 'not_implemented',
      at: 8,
    }));
    const executor = new DesktopExecutor(transport);
    const result = await executor.executePost(fakeAccount(), { text: 'hello' });
    expect(result.error).toBe(DESKTOP_NOT_IMPLEMENTED_MESSAGE);
  });

  it('メディア付き投稿は本体を payload に inline で載せる', async () => {
    const transport = fakeTransport((job) => ({ id: job.id, ok: true, data: { postId: '1' }, at: 1 }));
    const executor = new DesktopExecutor(transport);
    const media = {
      name: 'photo.png',
      mime: 'image/png',
      kind: 'image' as const,
      size: 100,
      dataBase64: 'aGVsbG8=',
    };
    await executor.executePost(fakeAccount(), { text: 'with media', media: [media] });
    expect(transport.sent).toHaveLength(1);
    const sent = transport.sent[0];
    expect(sent.timeoutMs).toBe(MEDIA_JOB_TIMEOUT_MS);
    const content = sent.payload.content as { media: unknown[] };
    expect(content.media).toHaveLength(1);
    // チャンク転送の参照（uploadId）ではなく、本体（dataBase64）が載る。
    expect(content.media[0]).toMatchObject({ name: 'photo.png', dataBase64: 'aGVsbG8=' });
  });

  it('大きすぎるメディアはホストへ送らずに失敗する', async () => {
    const transport = fakeTransport((job) => ({ id: job.id, ok: true, data: {}, at: 1 }));
    const executor = new DesktopExecutor(transport);
    const big = {
      name: 'big.png',
      mime: 'image/png',
      kind: 'image' as const,
      size: 33 * 1024 * 1024,
      dataBase64: '',
    };
    const result = await executor.executePost(fakeAccount(), { text: 'x', media: [big] });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('32MB');
    expect(transport.sent).toHaveLength(0);
  });

  it('メディアの合計が上限を超えると失敗する', async () => {
    const transport = fakeTransport((job) => ({ id: job.id, ok: true, data: {}, at: 1 }));
    const executor = new DesktopExecutor(transport);
    const items = [1, 2, 3].map((n) => ({
      name: `img${n}.png`,
      mime: 'image/png',
      kind: 'image' as const,
      size: 25 * 1024 * 1024,
      dataBase64: '',
    }));
    const result = await executor.executePost(fakeAccount(), { text: 'x', media: items });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('64MB');
    expect(transport.sent).toHaveLength(0);
  });

  it('checkAccount は成功データを写し、失敗は例外にする', async () => {
    const okTransport = fakeTransport((job) => ({
      id: job.id,
      ok: true,
      data: { status: 'logged_in', notifications: 3, dmCount: 1, followers: 120 },
      at: 7,
    }));
    const executor = new DesktopExecutor(okTransport);
    await expect(executor.checkAccount(fakeAccount())).resolves.toEqual({
      accountId: 'acc-1',
      status: 'logged_in',
      notifications: 3,
      dmCount: 1,
      followers: 120,
      checkedAt: 7,
    });

    const failTransport = fakeTransport(() => ({
      id: 'job-1',
      ok: false,
      code: 'x_error',
      error: 'X から弾かれました',
      at: 8,
    }));
    const failing = new DesktopExecutor(failTransport);
    await expect(failing.checkAccount(fakeAccount())).rejects.toThrow('X から弾かれました');
  });

  it('checkAccount はセッション切れの結果を sessionExpired として通す', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: true,
      data: {
        status: 'logged_out',
        notifications: -1,
        dmCount: -1,
        followers: -1,
        sessionExpired: true,
      },
      at: 11,
    }));
    const executor = new DesktopExecutor(transport);
    const result = await executor.checkAccount(fakeAccount());
    expect(result.status).toBe('logged_out');
    expect(result.sessionExpired).toBe(true);
    // 取れなかった数は保存済みの値を残す（-1 のまま返さない）。
    expect(result.followers).toBe(100);
  });

  it('checkAccount は判定結果を台帳へ書き戻す', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: true,
      data: { status: 'logged_in', notifications: 3, dmCount: 1, followers: 120 },
      at: 7,
    }));
    const executor = new DesktopExecutor(transport);
    // updateAccount が例外を投げないこと（存在しない行への更新は
    // Dexie では無操作）。書き戻し経路が通ることの確認。
    await expect(executor.checkAccount(fakeAccount())).resolves.toMatchObject({
      accountId: 'acc-1',
      status: 'logged_in',
    });
  });

  it('resolveAccountIdentity はホストの本人確認結果を返す', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: true,
      data: { accountId: '999', handle: 'alice' },
      at: 12,
    }));
    const executor = new DesktopExecutor(transport);
    await expect(executor.resolveAccountIdentity('999')).resolves.toEqual({
      accountId: '999',
      handle: 'alice',
    });
  });

  it('未対応のメソッドは not_implemented 文言で失敗する', async () => {
    const transport = fakeTransport(() => ({
      id: 'job-1',
      ok: false,
      code: 'not_implemented',
      at: 3,
    }));
    const executor = new DesktopExecutor(transport);
    await expect(executor.checkSearchBan(fakeAccount(), fakeAccount())).rejects.toThrow(
      DESKTOP_NOT_IMPLEMENTED_MESSAGE,
    );
    await expect(executor.fetchPostAnalytics(fakeAccount(), [])).rejects.toThrow(
      DESKTOP_NOT_IMPLEMENTED_MESSAGE,
    );
    await expect(executor.fetchNotifications(fakeAccount())).rejects.toThrow(
      DESKTOP_NOT_IMPLEMENTED_MESSAGE,
    );
  });

  it('deletePost / executeAction は結果を写す', async () => {
    const transport = fakeTransport((job) => ({ id: job.id, ok: true, at: 4 }));
    const executor = new DesktopExecutor(transport);
    await expect(executor.deletePost(fakeAccount(), '123')).resolves.toMatchObject({
      accountId: 'acc-1',
      postId: '123',
      ok: true,
    });
    await expect(
      executor.executeAction(fakeAccount(), 'like', { postUrl: 'https://x.com/a/status/1' }),
    ).resolves.toMatchObject({ accountId: 'acc-1', kind: 'like', ok: true });
  });

  it('ホスト未接続なら DesktopNotConnectedError が伝わる', async () => {
    const transport: DesktopTransport = {
      ping: async () => {
        throw new DesktopNotConnectedError();
      },
      listSessions: async () => {
        throw new DesktopNotConnectedError();
      },
      openLogin: async () => {
        throw new DesktopNotConnectedError();
      },
      sendJob: async () => {
        throw new DesktopNotConnectedError();
      },
    };
    const executor = new DesktopExecutor(transport);
    await expect(executor.executePost(fakeAccount(), { text: 'x' })).rejects.toBeInstanceOf(
      DesktopNotConnectedError,
    );
  });
});
