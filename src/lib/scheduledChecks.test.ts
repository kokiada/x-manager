import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import type { Account, PostJob } from '../db/types';
import type { AccountCheckResult } from '../executor/Executor';
import {
  createAccount,
  createAutoPostRule,
  createTemplate,
  getSettings,
  listAutoPostRuns,
  listFollowerHistory,
  saveSettings,
} from '../db/repository';
import { executor } from '../executor';
import { runBanCheckBatch } from './banCheckService';
import { createAndRunJob } from './bulkPostService';
import { tickAutoPost } from './autoPostEngine';
import {
  runScheduledAccountCheck,
  runScheduledBanCheck,
  timeTodayMs,
} from './scheduledChecks';

// 定期チェックの通しは本物の台帳（fake-indexeddb）で検証する。
// 外側（Xへの問い合わせ・バン判定バッチ・投稿ジョブ）だけ差し替える。
vi.mock('../executor', () => ({
  executor: {
    checkAccount: vi.fn(),
  },
}));

vi.mock('./banCheckService', () => ({
  runBanCheckBatch: vi.fn(async () => undefined),
}));

vi.mock('./bulkPostService', () => ({
  createAndRunJob: vi.fn(),
}));

const mockCheckAccount = vi.mocked(executor.checkAccount);
const mockRunBanCheckBatch = vi.mocked(runBanCheckBatch);
const mockCreateAndRunJob = vi.mocked(createAndRunJob);

function realAccount(handle: string, groupId: string | null = null, status: Account['status'] = 'logged_in'): Omit<Account, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    handle,
    displayName: handle,
    groupId,
    proxyGroupId: null,
    status,
    followers: 100,
    following: 10,
    notifications: 0,
    dmCount: 0,
    searchBan: 'unknown',
  };
}

function checkResult(accountId: string, followers = 123): AccountCheckResult {
  return {
    accountId,
    status: 'logged_in',
    notifications: 0,
    dmCount: 0,
    followers,
    checkedAt: Date.now(),
  };
}

/** 今日の時刻をミリ秒で作る（スケジュール計算と同じローカル時刻）。 */
function atToday(h: number, m: number): number {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

describe('timeTodayMs', () => {
  it('HH:MM を今日の時刻に直し、変な値は null', () => {
    const now = atToday(12, 0);
    expect(timeTodayMs('09:00', now)).toBe(atToday(9, 0));
    expect(timeTodayMs('9:00', now)).toBe(atToday(9, 0));
    expect(timeTodayMs('25:00', now)).toBeNull();
    expect(timeTodayMs('ab:cd', now)).toBeNull();
  });
});

describe('1日の流れ（定期チェック＋自動投稿の通し）', () => {
  beforeEach(async () => {
    mockCheckAccount.mockReset();
    mockRunBanCheckBatch.mockReset();
    mockCreateAndRunJob.mockReset();
    await db.delete();
    await db.open();
  });

  it('朝のチェック→バン判定→自動投稿が同じ台帳でつながる', async () => {
    const a = await createAccount(realAccount('alice'));
    const b = await createAccount(realAccount('bob'));
    const template = await createTemplate({
      title: 't',
      body: 'おはよう',
      groupId: null,
      media: [],
      poll: null,
      thread: [],
    });
    await createAutoPostRule({
      name: '朝の投稿',
      enabled: true,
      accountIds: [a.id, b.id],
      templateId: template.id,
      mode: 'fixed_times',
      times: ['10:00'],
      jitterMin: 0,
    });
    const settings = await getSettings();
    await saveSettings({
      ...settings,
      accountCheck: { enabled: true, time: '09:00', groupId: null },
      searchBanCheck: { enabled: true, time: '09:30', groupId: null },
    });
    mockCheckAccount.mockImplementation(async (account: Account) => checkResult(account.id, 150));
    mockCreateAndRunJob.mockResolvedValue({
      id: 'job-1',
      kind: 'immediate',
      status: 'done',
      payload: {
        segments: ['おはよう'],
        targetType: 'normal',
        media: [],
        mediaMode: 'all',
        poll: null,
        replyPermission: 'everyone',
        paidPartnership: false,
      },
      intervalSec: 60,
      entries: [
        { accountId: a.id, handle: 'alice', status: 'done', postUrl: 'https://x.com/alice/status/1', at: Date.now() },
        { accountId: b.id, handle: 'bob', status: 'done', postUrl: 'https://x.com/bob/status/2', at: Date.now() },
      ],
      createdAt: 0,
      startedAt: 0,
      finishedAt: 0,
    } satisfies PostJob);

    // 09:05 アカウントチェック → フォロワー履歴が残る。
    await runScheduledAccountCheck(atToday(9, 5));
    expect(mockCheckAccount).toHaveBeenCalledTimes(2);
    expect(await listFollowerHistory(a.id)).toHaveLength(1);

    // 09:35 バン判定チェック → バッチが走る。
    await runScheduledBanCheck(atToday(9, 35));
    expect(mockRunBanCheckBatch).toHaveBeenCalledTimes(1);

    // 10:05 自動投稿 → ジョブが走り、完了記録が残る。
    await tickAutoPost(atToday(10, 5));
    expect(mockCreateAndRunJob).toHaveBeenCalledTimes(1);
    // ジョブの完了記録（.then 経由）は非同期で残るので、揃うまで待つ。
    await vi.waitFor(async () => {
      const runs = await listAutoPostRuns();
      expect(runs.filter((r) => r.status === 'done')).toHaveLength(2);
    });
  });
});

describe('runScheduledAccountCheck', () => {
  beforeEach(async () => {
    mockCheckAccount.mockReset();
    mockRunBanCheckBatch.mockReset();
    await db.delete();
    await db.open();
  });

  async function enableAccountCheck(time = '09:00', groupId: string | null = null): Promise<void> {
    const settings = await getSettings();
    await saveSettings({ ...settings, accountCheck: { enabled: true, time, groupId } });
  }

  it('無効なら何もしない', async () => {
    await createAccount(realAccount('alice'));
    await runScheduledAccountCheck(atToday(9, 5));
    expect(mockCheckAccount).not.toHaveBeenCalled();
  });

  it('予定時刻前・15分以上遅れは走らない', async () => {
    await createAccount(realAccount('alice'));
    await enableAccountCheck('09:00');
    await runScheduledAccountCheck(atToday(8, 59));
    await runScheduledAccountCheck(atToday(9, 16));
    expect(mockCheckAccount).not.toHaveBeenCalled();
  });

  it('時間内なら全アカウントを調べ、フォロワー履歴を残し、1日1回だけ', async () => {
    const a = await createAccount(realAccount('alice'));
    const b = await createAccount(realAccount('bob'));
    await enableAccountCheck('09:00');
    mockCheckAccount.mockImplementation(async (account: Account) => checkResult(account.id, 150));

    await runScheduledAccountCheck(atToday(9, 5));
    expect(mockCheckAccount).toHaveBeenCalledTimes(2);
    expect(mockCheckAccount.mock.calls.map((c) => c[0].id).sort()).toEqual([a.id, b.id].sort());
    const historyA = await listFollowerHistory(a.id);
    expect(historyA).toHaveLength(1);
    expect(historyA[0]).toMatchObject({ followers: 150 });

    // 同じ日の2回目は走らない（1日1回の請求済み）。
    await runScheduledAccountCheck(atToday(9, 6));
    expect(mockCheckAccount).toHaveBeenCalledTimes(2);
  });

  it('グループ指定ならそのグループだけ調べる', async () => {
    const a = await createAccount(realAccount('alice', 'g1'));
    await createAccount(realAccount('bob', 'g2'));
    await enableAccountCheck('09:00', 'g1');
    mockCheckAccount.mockImplementation(async (account: Account) => checkResult(account.id));

    await runScheduledAccountCheck(atToday(9, 5));
    expect(mockCheckAccount).toHaveBeenCalledTimes(1);
    expect(mockCheckAccount.mock.calls[0][0].id).toBe(a.id);
  });

  it('1件が失敗しても残りを調べる', async () => {
    const a = await createAccount(realAccount('alice'));
    const b = await createAccount(realAccount('bob'));
    await enableAccountCheck('09:00');
    mockCheckAccount
      .mockRejectedValueOnce(new Error('拡張に接続できません'))
      .mockImplementation(async (account: Account) => checkResult(account.id));

    await runScheduledAccountCheck(atToday(9, 5));
    expect(mockCheckAccount).toHaveBeenCalledTimes(2);
    expect(await listFollowerHistory(b.id)).toHaveLength(1);
    expect(await listFollowerHistory(a.id)).toHaveLength(0);
  });
});

describe('runScheduledBanCheck', () => {
  beforeEach(async () => {
    mockCheckAccount.mockReset();
    mockRunBanCheckBatch.mockReset();
    await db.delete();
    await db.open();
  });

  async function enableBanCheck(time = '09:30', groupId: string | null = null): Promise<void> {
    const settings = await getSettings();
    await saveSettings({ ...settings, searchBanCheck: { enabled: true, time, groupId } });
  }

  it('無効・時刻外なら走らない', async () => {
    await createAccount(realAccount('alice'));
    await runScheduledBanCheck(atToday(9, 35));
    await enableBanCheck('09:30');
    await runScheduledBanCheck(atToday(9, 29));
    await runScheduledBanCheck(atToday(9, 46));
    expect(mockRunBanCheckBatch).not.toHaveBeenCalled();
  });

  it('時間内ならログイン済み最大3件をチェッカーにしてバッチを走らせ、1日1回だけ', async () => {
    const a = await createAccount(realAccount('alice'));
    const b = await createAccount(realAccount('bob'));
    await createAccount(realAccount('carol', null, 'logged_out'));
    await enableBanCheck('09:30');

    await runScheduledBanCheck(atToday(9, 35));
    expect(mockRunBanCheckBatch).toHaveBeenCalledTimes(1);
    expect(mockRunBanCheckBatch.mock.calls[0][0]).toEqual({
      checkerIds: [a.id, b.id],
      targetIds: expect.arrayContaining([a.id, b.id]),
    });

    await runScheduledBanCheck(atToday(9, 36));
    expect(mockRunBanCheckBatch).toHaveBeenCalledTimes(1);
  });

  it('チェッカー（ログイン済み）が無ければ走らない', async () => {
    await createAccount(realAccount('alice', null, 'logged_out'));
    await enableBanCheck('09:30');
    await runScheduledBanCheck(atToday(9, 35));
    expect(mockRunBanCheckBatch).not.toHaveBeenCalled();
  });

  it('バッチが失敗しても次回に持ち越す（例外を外に出さない）', async () => {
    await createAccount(realAccount('alice'));
    await enableBanCheck('09:30');
    mockRunBanCheckBatch.mockRejectedValueOnce(new Error('boom'));
    // 投げずに終わること。請求は済んでいるので同日は再実行しない。
    await runScheduledBanCheck(atToday(9, 35));
    expect(mockRunBanCheckBatch).toHaveBeenCalledTimes(1);
    await runScheduledBanCheck(atToday(9, 36));
    expect(mockRunBanCheckBatch).toHaveBeenCalledTimes(1);
  });
});
