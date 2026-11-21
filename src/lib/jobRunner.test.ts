import { describe, expect, it, vi } from 'vitest';
import type { Account } from '../db/types';
import type { PostContent, PostResult } from '../executor/Executor';
import { emptyPayload } from './bulkPost';
import { abortableWait, runBulkPostJob } from './jobRunner';

const account = (id: string, status: Account['status'] = 'logged_in'): Account => ({
  id,
  handle: `user_${id}`,
  displayName: `User ${id}`,
  groupId: null,
  proxyGroupId: null,
  status,
  followers: 0,
  following: 0,
  notifications: 0,
  dmCount: 0,
  searchBan: 'unknown',
  createdAt: 0,
  updatedAt: 0,
});

const okResult = (content: PostContent, accountId: string): PostResult => ({
  accountId,
  ok: true,
  postId: `p-${accountId}`,
  postUrl: `https://x.com/x/status/p-${accountId}`,
  threadPostIds: content.threadTexts?.map((_, i) => `p-${accountId}t${i + 1}`),
  at: 123,
});

function harness(opts: { failFor?: string[] } = {}) {
  const calls: { accountId: string; content: PostContent }[] = [];
  const waits: number[] = [];
  const executePost = async (acc: Account, content: PostContent): Promise<PostResult> => {
    calls.push({ accountId: acc.id, content });
    if (opts.failFor?.includes(acc.id)) {
      return { accountId: acc.id, ok: false, error: 'boom', at: 456 };
    }
    return okResult(content, acc.id);
  };
  const wait = async (ms: number) => {
    waits.push(ms);
  };
  return { calls, waits, executePost, wait };
}

const payload = { ...emptyPayload(), segments: ['hello'] };

describe('runBulkPostJob', () => {
  it('processes accounts strictly in the given order, top-to-bottom', async () => {
    const h = harness();
    const entries = await runBulkPostJob({
      accounts: [account('c'), account('a'), account('b')],
      payload,
      intervalSec: 5,
      wordSets: {},
      signal: new AbortController().signal,
      deps: h,
    });
    expect(h.calls.map((c) => c.accountId)).toEqual(['c', 'a', 'b']);
    expect(entries.map((e) => e.status)).toEqual(['done', 'done', 'done']);
    expect(entries.map((e) => e.postId)).toEqual(['p-c', 'p-a', 'p-b']);
  });

  it('waits the chosen interval between accounts only (not first/last)', async () => {
    const h = harness();
    await runBulkPostJob({
      accounts: [account('a'), account('b'), account('c')],
      payload,
      intervalSec: 7,
      wordSets: {},
      signal: new AbortController().signal,
      deps: h,
    });
    expect(h.waits).toEqual([7000, 7000]);
  });

  it('skips locked / frozen / logged-out accounts without calling the executor', async () => {
    const h = harness();
    const entries = await runBulkPostJob({
      accounts: [
        account('a', 'locked'),
        account('b', 'frozen'),
        account('c', 'logged_out'),
        account('d'),
      ],
      payload,
      intervalSec: 1,
      wordSets: {},
      signal: new AbortController().signal,
      deps: h,
    });
    expect(h.calls.map((c) => c.accountId)).toEqual(['d']);
    expect(entries.map((e) => e.status)).toEqual(['skipped', 'skipped', 'skipped', 'done']);
    // The interval still applies between queue positions.
    expect(h.waits).toEqual([1000, 1000, 1000]);
  });

  it('marks a failed account and continues with the rest', async () => {
    const h = harness({ failFor: ['b'] });
    const entries = await runBulkPostJob({
      accounts: [account('a'), account('b'), account('c')],
      payload,
      intervalSec: 1,
      wordSets: {},
      signal: new AbortController().signal,
      deps: h,
    });
    expect(entries.map((e) => e.status)).toEqual(['done', 'failed', 'done']);
    expect(entries[1].error).toBe('boom');
  });

  it('expands [RandomN] independently per account', async () => {
    const h = harness();
    const rngValues = [0, 0.99];
    let i = 0;
    await runBulkPostJob({
      accounts: [account('a'), account('b')],
      payload: { ...emptyPayload(), segments: ['[Random1]!'] },
      intervalSec: 1,
      wordSets: { 1: ['first', 'second'] },
      signal: new AbortController().signal,
      deps: { ...h, rng: () => rngValues[i++ % rngValues.length] },
    });
    expect(h.calls.map((c) => c.content.text)).toEqual(['first!', 'second!']);
  });

  it('builds tree posts: segment 1 is the post, the rest are threadTexts', async () => {
    const h = harness();
    const entries = await runBulkPostJob({
      accounts: [account('a')],
      payload: { ...emptyPayload(), segments: ['one', 'two', 'three'] },
      intervalSec: 1,
      wordSets: {},
      signal: new AbortController().signal,
      deps: h,
    });
    expect(h.calls[0].content.text).toBe('one');
    expect(h.calls[0].content.threadTexts).toEqual(['two', 'three']);
    expect(entries[0].threadPostIds).toEqual(['p-at1', 'p-at2']);
  });

  it('stops on cancel: later accounts stay pending', async () => {
    const controller = new AbortController();
    const waits: number[] = [];
    const entries = await runBulkPostJob({
      accounts: [account('a'), account('b'), account('c')],
      payload,
      intervalSec: 5,
      wordSets: {},
      signal: controller.signal,
      deps: {
        executePost: async (acc, content) => okResult(content, acc.id),
        wait: async (ms: number) => {
          waits.push(ms);
          controller.abort();
        },
      },
    });
    expect(entries.map((e) => e.status)).toEqual(['done', 'pending', 'pending']);
    expect(waits).toEqual([5000]);
  });

  it('emits progress updates as entries change', async () => {
    const h = harness();
    const updates: string[][] = [];
    await runBulkPostJob({
      accounts: [account('a'), account('b')],
      payload,
      intervalSec: 1,
      wordSets: {},
      signal: new AbortController().signal,
      deps: {
        ...h,
        onUpdate: (entries) => {
          updates.push(entries.map((e) => e.status));
        },
      },
    });
    expect(updates[updates.length - 1]).toEqual(['done', 'done']);
    expect(updates.some((u) => u[0] === 'running')).toBe(true);
  });

  it('onUpdate の失敗（保存の不具合）でジョブ全体が止まらない', async () => {
    const h = harness();
    const entries = await runBulkPostJob({
      accounts: [account('a'), account('b')],
      payload,
      intervalSec: 1,
      wordSets: {},
      signal: new AbortController().signal,
      deps: {
        ...h,
        onUpdate: () => {
          throw new Error('保存に失敗しました');
        },
      },
    });
    expect(entries.map((e) => e.status)).toEqual(['done', 'done']);
  });
});

describe('abortableWait', () => {
  it('resolves after the delay (fake timers)', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let resolved = false;
      const p = abortableWait(5000, controller.signal).then(() => {
        resolved = true;
      });
      await vi.advanceTimersByTimeAsync(4999);
      expect(resolved).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await p;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves immediately when aborted during the wait', async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let resolved = false;
      const p = abortableWait(60_000, controller.signal).then(() => {
        resolved = true;
      });
      controller.abort();
      await p;
      expect(resolved).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
