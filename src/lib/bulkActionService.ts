import { executor } from '../executor';
import type { BulkAction, BulkActionEntry, BulkActionKind } from '../db/types';
import {
  createBulkAction,
  listAccounts,
  updateBulkAction,
} from '../db/repository';

/**
 * Bulk-action service (research §7-1).
 *
 * - Targets: one or more post URLs; kinds: like / repost / bookmark.
 * - The post author's own accounts are excluded (「表示中アカウント
 *   で一括実行」は投稿者を除く全アカウントで実行）.
 * - Locked / frozen / logged-out accounts are skipped, never executed.
 * - queueSequential: finish target 1 across all accounts before
 *   target 2; otherwise each account runs all targets before the next
 *   account starts.
 * - randomRanges: pick `count` accounts at random from the ordered
 *   range [start, end] of the account list ("枠を追加" for more).
 * - Cancellation via AbortSignal; progress is persisted so the UI can
 *   watch the job through Dexie live queries.
 */

export interface RandomRange {
  start: number;
  end: number;
  count: number;
}

export interface BulkActionRequest {
  kind: BulkActionKind;
  targets: string[];
  /** Ordered account IDs (sidebar order) to choose from. */
  accountIds: string[];
  queueSequential: boolean;
  randomRanges?: RandomRange[];
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

/** Pick `count` distinct accounts at random from the ordered range. */
export function selectRandomAccounts<T>(
  ordered: readonly T[],
  range: RandomRange,
  rng: () => number = Math.random,
): T[] {
  const start = Math.max(0, range.start);
  const end = Math.min(ordered.length - 1, range.end);
  if (start > end || range.count <= 0) return [];
  const pool = [...ordered.slice(start, end + 1)];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, Math.min(range.count, pool.length));
}

/** Author handle from a post URL (https://x.com/<handle>/status/...). */
export function authorHandleFromUrl(url: string): string | null {
  const match = /x\.com\/([^/]+)\/status\//i.exec(url.trim());
  return match ? match[1] : null;
}

export async function runBulkAction(req: BulkActionRequest): Promise<BulkAction> {
  const all = await listAccounts();
  const byId = new Map(all.map((a) => [a.id, a]));
  const orderedPool = req.accountIds
    .map((id) => byId.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a);

  // Resolve the acting accounts: random ranges, or the whole pool.
  let acting = orderedPool;
  if (req.randomRanges && req.randomRanges.length > 0) {
    const picked = new Map<string, NonNullable<typeof acting[number]>>();
    for (const range of req.randomRanges) {
      for (const account of selectRandomAccounts(orderedPool, range)) {
        picked.set(account.id, account);
      }
    }
    acting = orderedPool.filter((a) => picked.has(a.id));
  }

  // Exclude the post author's own accounts (per target, unioned).
  const authorHandles = new Set(
    req.targets.map(authorHandleFromUrl).filter((h): h is string => !!h),
  );

  // Planned (target, account) pairs.
  const pairs: { targetUrl: string; accountId: string; handle: string; skipReason?: string }[] = [];
  const orderedPairs = req.queueSequential
    ? req.targets.flatMap((t) => acting.map((a) => ({ targetUrl: t, account: a })))
    : acting.flatMap((a) => req.targets.map((t) => ({ targetUrl: t, account: a })));
  for (const { targetUrl, account } of orderedPairs) {
    if (authorHandles.has(account.handle)) {
      pairs.push({ targetUrl, accountId: account.id, handle: account.handle, skipReason: '投稿者本人のアカウントのため除外' });
    } else if (account.status !== 'logged_in') {
      pairs.push({ targetUrl, accountId: account.id, handle: account.handle, skipReason: `アカウントの状態が「${account.status}」のためスキップ` });
    } else {
      pairs.push({ targetUrl, accountId: account.id, handle: account.handle });
    }
  }

  const job = await createBulkAction({
    kind: req.kind,
    targets: req.targets,
    accountIds: acting.map((a) => a.id),
    queueSequential: req.queueSequential,
    randomRanges: req.randomRanges,
  });
  const total = pairs.length;
  let done = 0;

  const entries: BulkActionEntry[] = pairs.map((p) => ({
    accountId: p.accountId,
    handle: p.handle,
    targetUrl: p.targetUrl,
    status: 'skipped' as const,
    error: p.skipReason ?? '未実行',
    at: undefined,
  }));
  // Skipped pairs are final already; executable pairs start as 'skipped'
  // with "未実行" only until their turn — replaced below as they run.
  const persist = async () => {
    await updateBulkAction(job.id, {
      entries: entries.map((e) => ({ ...e })),
    });
  };
  await persist();

  for (let i = 0; i < pairs.length; i++) {
    const pair = pairs[i];
    if (req.signal?.aborted) break;
    if (pair.skipReason) {
      done++;
      req.onProgress?.(done, total);
      continue;
    }
    const account = byId.get(pair.accountId);
    if (!account) {
      entries[i] = { ...entries[i], status: 'failed', error: 'アカウントが存在しません', at: Date.now() };
      done++;
      await persist();
      req.onProgress?.(done, total);
      continue;
    }
    try {
      const result = await executor.executeAction(account, req.kind, { postUrl: pair.targetUrl });
      entries[i] = {
        ...entries[i],
        status: result.ok ? 'done' : 'failed',
        error: result.ok ? undefined : (result.error ?? '実行に失敗しました'),
        at: result.at,
      };
    } catch (err) {
      entries[i] = {
        ...entries[i],
        status: 'failed',
        error: err instanceof Error ? err.message : '実行に失敗しました',
        at: Date.now(),
      };
    }
    done++;
    await persist();
    req.onProgress?.(done, total);
  }

  const cancelled = req.signal?.aborted ?? false;
  if (cancelled) {
    // Pairs never reached keep a clear reason instead of '未実行'.
    for (let i = 0; i < entries.length; i++) {
      if (!pairs[i].skipReason && entries[i].at === undefined && entries[i].status === 'skipped') {
        entries[i] = { ...entries[i], error: 'キャンセルにより未実行' };
      }
    }
  }
  const status: BulkAction['status'] = cancelled
    ? 'cancelled'
    : entries.some((e) => e.status === 'failed')
      ? 'partial'
      : 'done';
  await updateBulkAction(job.id, {
    entries: entries.map((e) => ({ ...e })),
    status,
    finishedAt: Date.now(),
  });
  return { ...job, entries: entries.map((e) => ({ ...e })), status, finishedAt: Date.now() };
}
