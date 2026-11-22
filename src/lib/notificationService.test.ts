import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import type { Account } from '../db/types';
import type { NotificationItem } from '../executor/Executor';
import { refreshNotifications } from './notificationService';

const mocks = vi.hoisted(() => ({
  items: [] as NotificationItem[],
  fail: false,
}));

vi.mock('../executor', () => ({
  executor: {
    fetchNotifications: vi.fn(async () => {
      if (mocks.fail) throw new Error('拡張に接続できません');
      return mocks.items;
    }),
  },
}));

function realAccount(): Account {
  return {
    id: 'a',
    handle: 'alice',
    displayName: 'Alice',
    groupId: null,
    proxyGroupId: null,
    status: 'logged_in',
    followers: 0,
    following: 0,
    notifications: 0,
    dmCount: 0,
    searchBan: 'unknown',
    createdAt: 0,
    updatedAt: 0,
  };
}

/** 実データ形の取得結果（at は応答の時刻＝再取得でも同じ値）。 */
function realItems(): NotificationItem[] {
  return [
    {
      kind: 'notification',
      title: '通知',
      body: '@bob がいいねしました',
      fromHandle: 'bob',
      at: 1795220000000,
    },
    {
      kind: 'dm',
      title: 'DM',
      body: 'こんにちは',
      fromHandle: 'carol',
      at: 1795220001000,
    },
  ];
}

describe('refreshNotifications', () => {
  beforeEach(async () => {
    mocks.items = realItems();
    mocks.fail = false;
    await db.notifications.clear();
  });

  it('取得した通知・DMを台帳に載せて件数を返す', async () => {
    const added = await refreshNotifications(realAccount());
    expect(added).toBe(2);
    const rows = await db.notifications.toArray();
    expect(rows).toHaveLength(2);
    // toArray の並びは主キー（ランダムID）順なので kind で探す。
    expect(rows.find((r) => r.kind === 'notification')).toMatchObject({ accountId: 'a', handle: 'alice' });
    expect(rows.find((r) => r.kind === 'dm')).toMatchObject({ accountId: 'a', handle: 'alice' });
  });

  it('同じ取得結果の2回目は重複として0件になる', async () => {
    expect(await refreshNotifications(realAccount())).toBe(2);
    // 実データと同じ内容をもう一度取得しても増えない（集約が壊れない）。
    expect(await refreshNotifications(realAccount())).toBe(0);
    expect(await db.notifications.toArray()).toHaveLength(2);
  });

  it('空の取得結果は0件', async () => {
    mocks.items = [];
    expect(await refreshNotifications(realAccount())).toBe(0);
  });

  it('拡張の取得が失敗したら黙って0件にしない', async () => {
    mocks.fail = true;
    await expect(refreshNotifications(realAccount())).rejects.toThrow('拡張に接続できません');
  });
});
