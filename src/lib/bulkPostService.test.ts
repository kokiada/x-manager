import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db } from '../db/db';
import type { Account } from '../db/types';
import { emptyPayload } from './bulkPost';
import { createAndRunJob } from './bulkPostService';

// ランナー外の失敗（保存の読み取り失敗など）を再現するため、
// getRandomWordSets だけ差し替えられるようにする。
const mocks = vi.hoisted(() => ({ failWordSets: false }));

vi.mock('../db/repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/repository')>();
  return {
    ...actual,
    getRandomWordSets: async () => {
      if (mocks.failWordSets) throw new Error('保存の読み取りに失敗しました');
      return actual.getRandomWordSets();
    },
  };
});

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

describe('createAndRunJob', () => {
  beforeEach(async () => {
    mocks.failWordSets = false;
    await db.delete();
    await db.open();
  });

  it('通常のジョブは完了し、完了状態で保存される', async () => {
    await db.accounts.add(realAccount());
    const job = await createAndRunJob({
      accountIds: ['a'],
      payload: { ...emptyPayload(), segments: ['hello'] },
      intervalSec: 1,
      kind: 'immediate',
    });
    expect(job.status).toBe('done');
    expect(job.entries).toHaveLength(1);
    expect(job.entries[0].status).toBe('done');
    expect(job.finishedAt).toBeGreaterThan(0);
    const stored = await db.postJobs.get(job.id);
    expect(stored?.status).toBe('done');
  });

  it('ランナー外の失敗でもジョブを「実行中」のまま残さない', async () => {
    mocks.failWordSets = true;
    await db.accounts.add(realAccount());
    const job = await createAndRunJob({
      accountIds: ['a'],
      payload: { ...emptyPayload(), segments: ['hello'] },
      intervalSec: 1,
      kind: 'immediate',
    });
    // 完了トーストが出るよう、例外は外へ逃がさない。
    expect(job.status).toBe('partial');
    expect(job.entries).toHaveLength(1);
    expect(job.entries[0].status).toBe('failed');
    expect(job.entries[0].error).toContain('保存の読み取りに失敗しました');
    expect(job.finishedAt).toBeGreaterThan(0);
    const stored = await db.postJobs.get(job.id);
    expect(stored?.status).toBe('partial');
  });
});
