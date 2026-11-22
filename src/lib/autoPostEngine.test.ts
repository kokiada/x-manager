import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import type { Account, AutoPostRule, PostJob, Template } from '../db/types';
import {
  createAccount,
  createAutoPostRule,
  createTemplate,
  listAutoPostRuns,
  recordBanCheckResult,
} from '../db/repository';
import { createAndRunJob } from './bulkPostService';
import { nextFireForRule, tickAutoPost } from './autoPostEngine';

// ジョブ実行だけ差し替える。ルール→スロット→ジョブ→実行記録の
// 通しは本物の台帳（fake-indexeddb）で検証する。
vi.mock('./bulkPostService', () => ({
  createAndRunJob: vi.fn(),
}));

const mockCreateAndRunJob = vi.mocked(createAndRunJob);

function realAccount(handle: string, groupId: string | null = null): Omit<Account, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    handle,
    displayName: handle,
    groupId,
    proxyGroupId: null,
    status: 'logged_in',
    followers: 100,
    following: 10,
    notifications: 0,
    dmCount: 0,
    searchBan: 'unknown',
  };
}

function fakeJob(
  entries: { accountId: string; status: 'done' | 'failed' | 'skipped'; postUrl?: string; error?: string }[],
): PostJob {
  return {
    id: 'job-1',
    kind: 'immediate',
    status: 'done',
    payload: {
      segments: ['hello'],
      targetType: 'normal',
      media: [],
      mediaMode: 'all',
      poll: null,
      replyPermission: 'everyone',
      paidPartnership: false,
    },
    intervalSec: 60,
    entries: entries.map((e) => ({
      accountId: e.accountId,
      handle: e.accountId,
      status: e.status,
      postUrl: e.postUrl,
      error: e.error,
      at: Date.now(),
    })),
    createdAt: 0,
    startedAt: 0,
    finishedAt: 0,
  };
}

/** 今日の時刻をミリ秒で作る（スロット計算と同じローカル時刻）。 */
function atToday(h: number, m: number): number {
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * tickAutoPost が void で呼ぶジョブの完了記録（.then 経由の台帳書き込み）
 * が残るまで待つ。固定の sleep では IndexedDB の書き込みに間に合わない
 * ことがあるため、行数が揃うまで繰り返し確認する。
 */
async function waitForRuns(count: number): Promise<void> {
  await vi.waitFor(async () => {
    expect(await listAutoPostRuns()).toHaveLength(count);
  });
}

async function seedRule(
  accountIds: string[],
  templateId: string,
  patch: Partial<AutoPostRule> = {},
): Promise<AutoPostRule> {
  return createAutoPostRule({
    name: '朝の投稿',
    enabled: true,
    accountIds,
    templateId,
    mode: 'fixed_times',
    times: ['10:00'],
    jitterMin: 0,
    ...patch,
  });
}

async function seedTemplate(body = 'hello'): Promise<Template> {
  return createTemplate({
    title: 't',
    body,
    groupId: null,
    media: [],
    poll: null,
    thread: [],
  });
}

describe('tickAutoPost', () => {
  beforeEach(async () => {
    mockCreateAndRunJob.mockReset();
    await db.delete();
    await db.open();
  });

  it('期日のスロットを発火し、ジョブ完了を実行記録に残す', async () => {
    const a = await createAccount(realAccount('alice'));
    const b = await createAccount(realAccount('bob'));
    const template = await seedTemplate();
    await seedRule([a.id, b.id], template.id);

    mockCreateAndRunJob.mockResolvedValue(
      fakeJob([
        { accountId: a.id, status: 'done', postUrl: 'https://x.com/alice/status/1' },
        { accountId: b.id, status: 'done', postUrl: 'https://x.com/bob/status/2' },
      ]),
    );

    await tickAutoPost(atToday(10, 5));

    expect(mockCreateAndRunJob).toHaveBeenCalledTimes(1);
    const arg = mockCreateAndRunJob.mock.calls[0][0];
    expect(arg.accountIds).toEqual([a.id, b.id]);
    expect(arg.payload.segments).toEqual(['hello']);
    expect(arg.intervalSec).toBe(60);
    expect(arg.intervalJitterSec).toBe(30);

    // 昨日のスロットは未処理のまま15分を過ぎているので遅刻スキップ
    // 1件＋今日の2件の完了、で計3件。
    await waitForRuns(3);
    const runs = await listAutoPostRuns();
    expect(runs.filter((r) => r.status === 'done')).toHaveLength(2);
    expect(runs.filter((r) => r.status === 'done').map((r) => r.postUrl).sort()).toEqual([
      'https://x.com/alice/status/1',
      'https://x.com/bob/status/2',
    ]);
    expect(runs.find((r) => r.status === 'skipped')?.reason).toContain('15分以上過ぎた');

    // 同じスロットは2回発火しないし、昨日の遅刻も重ねて記録しない。
    await tickAutoPost(atToday(10, 6));
    expect(mockCreateAndRunJob).toHaveBeenCalledTimes(1);
    expect(await listAutoPostRuns()).toHaveLength(3);
  });

  it('15分以上遅れたスロットはスキップ記録だけ残し、次ティックで重ねない', async () => {
    const a = await createAccount(realAccount('alice'));
    const template = await seedTemplate();
    await seedRule([a.id], template.id);

    await tickAutoPost(atToday(10, 20));
    await tickAutoPost(atToday(10, 21));

    expect(mockCreateAndRunJob).not.toHaveBeenCalled();
    // 昨日分と今日分、どちらも遅刻スキップ。2回目は重ねない。
    const runs = await listAutoPostRuns();
    expect(runs).toHaveLength(2);
    expect(runs.every((r) => r.status === 'skipped' && r.accountId === a.id)).toBe(true);
    expect(runs.every((r) => r.reason?.includes('15分以上過ぎた'))).toBe(true);
  });

  it('テンプレートが空ならスキップ記録だけ残す', async () => {
    const a = await createAccount(realAccount('alice'));
    const template = await seedTemplate('   ');
    await seedRule([a.id], template.id);

    await tickAutoPost(atToday(10, 5));

    expect(mockCreateAndRunJob).not.toHaveBeenCalled();
    // 今日分は「テンプレートが空」、昨日分は遅刻スキップ。
    const runs = await listAutoPostRuns();
    expect(runs).toHaveLength(2);
    expect(runs.find((r) => r.reason?.includes('テンプレートが空'))).toBeDefined();
    expect(runs.find((r) => r.reason?.includes('15分以上過ぎた'))).toBeDefined();
  });

  it('24時間以内のサーチバン判定があるアカウントは見送り、他は発火する', async () => {
    const a = await createAccount(realAccount('alice'));
    const b = await createAccount(realAccount('bob'));
    const template = await seedTemplate();
    await seedRule([a.id, b.id], template.id, { skipIfSearchBan: true });
    const now = atToday(10, 5);
    await recordBanCheckResult({
      accountId: a.id,
      handle: 'alice',
      checkedByAccountId: a.id,
      topicVisible: false,
      latestVisible: true,
      checkedAt: now - 3600_000,
    });

    mockCreateAndRunJob.mockResolvedValue(
      fakeJob([{ accountId: b.id, status: 'done', postUrl: 'https://x.com/bob/status/2' }]),
    );

    await tickAutoPost(now);

    expect(mockCreateAndRunJob).toHaveBeenCalledTimes(1);
    expect(mockCreateAndRunJob.mock.calls[0][0].accountIds).toEqual([b.id]);
    await waitForRuns(3);
    const runs = await listAutoPostRuns();
    expect(runs.find((r) => r.accountId === a.id && r.reason?.includes('サーチバン判定'))).toMatchObject({ status: 'skipped' });
    expect(runs.find((r) => r.accountId === b.id)).toMatchObject({ status: 'done' });
  });

  it('skipIfSearchBan が無ければバン判定があっても発火する', async () => {
    const a = await createAccount(realAccount('alice'));
    const template = await seedTemplate();
    await seedRule([a.id], template.id);
    const now = atToday(10, 5);
    await recordBanCheckResult({
      accountId: a.id,
      handle: 'alice',
      checkedByAccountId: a.id,
      topicVisible: false,
      latestVisible: false,
      checkedAt: now - 3600_000,
    });
    mockCreateAndRunJob.mockResolvedValue(
      fakeJob([{ accountId: a.id, status: 'done', postUrl: 'https://x.com/alice/status/1' }]),
    );

    await tickAutoPost(now);
    await waitForRuns(2);

    expect(mockCreateAndRunJob).toHaveBeenCalledTimes(1);
  });

  it('ルールのジョブが実行中なら次のティックは発火しない', async () => {
    const a = await createAccount(realAccount('alice'));
    const template = await seedTemplate();
    await seedRule([a.id], template.id);

    let resolveJob!: (job: PostJob) => void;
    const pending = new Promise<PostJob>((resolve) => {
      resolveJob = resolve;
    });
    mockCreateAndRunJob.mockReturnValue(pending);

    await tickAutoPost(atToday(10, 5));
    await tickAutoPost(atToday(10, 6));
    expect(mockCreateAndRunJob).toHaveBeenCalledTimes(1);

    resolveJob(fakeJob([{ accountId: a.id, status: 'done', postUrl: 'https://x.com/alice/status/1' }]));
    // 昨日分の遅刻スキップ1件＋今日の完了1件。
    await waitForRuns(2);
  });

  it('無効なルールは何もしない', async () => {
    const a = await createAccount(realAccount('alice'));
    const template = await seedTemplate();
    await seedRule([a.id], template.id, { enabled: false });

    await tickAutoPost(atToday(10, 5));

    expect(mockCreateAndRunJob).not.toHaveBeenCalled();
    expect(await listAutoPostRuns()).toHaveLength(0);
  });

  it('nextFireForRule は次のスロットを返す', async () => {
    const a = await createAccount(realAccount('alice'));
    const template = await seedTemplate();
    const rule = await seedRule([a.id], template.id);

    const next = await nextFireForRule(rule, atToday(9, 0));
    expect(next?.label).toBe('10:00');
  });
});
