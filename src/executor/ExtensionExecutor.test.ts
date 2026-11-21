import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { Account } from '../db/types';
import {
  ExtensionExecutor,
  EXTENSION_ERROR_MESSAGES,
  EXTENSION_NOT_IMPLEMENTED_MESSAGE,
} from './ExtensionExecutor';
import type { ExtensionJob, ExtensionJobResult } from './protocol';
import { ExtensionNotConnectedError, type ExtensionTransport } from './transport';

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
): ExtensionTransport & { sent: ExtensionJob[] } {
  const sent: ExtensionJob[] = [];
  return {
    sent,
    ping: async () => ({ version: 1, extensionVersion: '0.1.0' }),
    listSessions: async () => [{ accountId: 'acc-1', handle: 'testuser' }],
    sendJob: async (job) => {
      sent.push(job);
      return handler(job);
    },
  };
}

describe('ExtensionExecutor', () => {
  it('成功した投稿は結果データを写す', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: true,
      data: { postId: '999', postUrl: 'https://x.com/testuser/status/999' },
      at: 123,
    }));
    const executor = new ExtensionExecutor(transport);
    const result = await executor.executePost(fakeAccount(), { text: 'こんにちは' });
    expect(result).toEqual({
      accountId: 'acc-1',
      ok: true,
      postId: '999',
      postUrl: 'https://x.com/testuser/status/999',
      threadPostIds: undefined,
      at: 123,
    });
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0].method).toBe('executePost');
    expect(transport.sent[0].accountId).toBe('acc-1');
  });

  it('拡張が not_implemented を返すと、具体的な理由があればそれを出す', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: false,
      code: 'not_implemented',
      error: 'メディア付き投稿はまだ未対応です。',
      at: 5,
    }));
    const executor = new ExtensionExecutor(transport);
    const result = await executor.executeAction(fakeAccount(), 'like', {
      postUrl: 'https://x.com/a/status/1',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('メディア付き投稿はまだ未対応です。');
  });

  it('not_implemented で理由が無ければ汎用の説明に落ちる', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: false,
      code: 'not_implemented',
      at: 5,
    }));
    const executor = new ExtensionExecutor(transport);
    const result = await executor.executeAction(fakeAccount(), 'like', {
      postUrl: 'https://x.com/a/status/1',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe(EXTENSION_NOT_IMPLEMENTED_MESSAGE);
  });

  it('失敗分類ごとにフォールバック文言が日本語で決まっている', async () => {
    const cases: Array<{ code: 'no_session' | 'rate_limited' | 'x_error' | 'unknown'; error?: string }> = [
      { code: 'no_session' },
      { code: 'rate_limited' },
      { code: 'x_error' },
      { code: 'unknown' },
    ];
    for (const c of cases) {
      const transport = fakeTransport((job) => ({
        id: job.id,
        ok: false,
        code: c.code,
        at: 5,
      }));
      const executor = new ExtensionExecutor(transport);
      const result = await executor.deletePost(fakeAccount(), '123');
      expect(result.ok).toBe(false);
      expect(result.error).toBe(EXTENSION_ERROR_MESSAGES[c.code]);
    }
    // x_error で拡張が理由を付けていれば、それを優先する。
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: false,
      code: 'x_error',
      error: 'Xがエラーを返しました：何か',
      at: 5,
    }));
    const executor = new ExtensionExecutor(transport);
    const result = await executor.deletePost(fakeAccount(), '123');
    expect(result.error).toBe('Xがエラーを返しました：何か');
  });

  it('拡張が返すエラーをそのまま失敗結果にする', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: false,
      code: 'no_session',
      error: '連携されていません',
      at: 5,
    }));
    const executor = new ExtensionExecutor(transport);
    const result = await executor.deletePost(fakeAccount(), '123');
    expect(result).toEqual({
      accountId: 'acc-1',
      postId: '123',
      ok: false,
      error: '連携されていません',
      at: 5,
    });
  });

  it('未接続エラーはそのまま投げる（シミュレータに落ちない）', async () => {
    const transport = fakeTransport(() => {
      throw new ExtensionNotConnectedError();
    });
    const executor = new ExtensionExecutor(transport);
    await expect(executor.executePost(fakeAccount(), { text: 'x' })).rejects.toBeInstanceOf(
      ExtensionNotConnectedError,
    );
  });

  it('checkAccount は成功データを写し、失敗は例外にする', async () => {
    const okTransport = fakeTransport((job) => ({
      id: job.id,
      ok: true,
      data: { status: 'logged_in', notifications: 3, dmCount: 1, followers: 120 },
      at: 7,
    }));
    const executor = new ExtensionExecutor(okTransport);
    await expect(executor.checkAccount(fakeAccount())).resolves.toEqual({
      accountId: 'acc-1',
      status: 'logged_in',
      notifications: 3,
      dmCount: 1,
      followers: 120,
      checkedAt: 7,
    });

    const failTransport = fakeTransport((job) => ({
      id: job.id,
      ok: false,
      code: 'x_error',
      error: 'X から弾かれました',
      at: 8,
    }));
    const failing = new ExtensionExecutor(failTransport);
    await expect(failing.checkAccount(fakeAccount())).rejects.toThrow('X から弾かれました');
  });

  it('checkAccount はセッション切れ（401/403）の結果を sessionExpired として通す', async () => {
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
    const executor = new ExtensionExecutor(transport);
    const result = await executor.checkAccount(fakeAccount());
    expect(result.status).toBe('logged_out');
    expect(result.sessionExpired).toBe(true);
    // 取れなかった数は保存済みの値を残す（-1 のまま返さない）。
    expect(result.followers).toBe(100);
  });

  it('searchBan は null（取得失敗）をそのまま通す', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: true,
      data: { topicVisible: true, latestVisible: null },
      at: 9,
    }));
    const executor = new ExtensionExecutor(transport);
    const result = await executor.checkSearchBan(fakeAccount(), fakeAccount());
    expect(result).toEqual({
      accountId: 'acc-1',
      checkedByAccountId: 'acc-1',
      topicVisible: true,
      latestVisible: null,
      checkedAt: 9,
    });
    expect(transport.sent[0].payload.viaAccountId).toBe('acc-1');
  });

  it('fetchPostAnalytics は壊れた行を弾く', async () => {
    const transport = fakeTransport((job) => ({
      id: job.id,
      ok: true,
      data: {
        items: [
          {
            accountId: 'acc-1',
            postId: '1',
            postUrl: 'https://x.com/testuser/status/1',
            text: 'hello',
            likes: 2,
            reposts: 0,
            bookmarks: 0,
            views: 10,
            postedAt: 1,
            fetchedAt: 2,
          },
          { postId: 'broken' },
        ],
      },
      at: 10,
    }));
    const executor = new ExtensionExecutor(transport);
    const items = await executor.fetchPostAnalytics(fakeAccount(), [fakeAccount()]);
    expect(items).toHaveLength(1);
    expect(items[0].postId).toBe('1');
  });
});
