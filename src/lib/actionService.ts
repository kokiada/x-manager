import type { Account, ActionJob, ActionJobEntry, BulkActionKind } from '../db/types';
import {
  createActionJob,
  listAccounts,
  updateActionJob,
} from '../db/repository';
import { executor } from '../executor';
import type { ActionResult } from '../executor/Executor';
import { abortableWait } from './jobRunner';

/**
 * Bulk-action service (research §7-1 manual bulk actions, §8 bulk follow).
 *
 * - One job = one kind across N targets × M accounts. "1件ずつキュー"
 *   processes one target across all accounts before the next target;
 *   otherwise accounts are processed target by target in the same
 *   order (the queue is always sequential — XBoard warns that blasting
 *   many actions in a short time can lock accounts).
 * - Locked / frozen / logged-out accounts are never selected (§7-1);
 *   the posting account itself is excluded per target (§7-1).
 * - Between accounts the runner waits the chosen interval (2–6 s is
 *   the §7-2 auto-action spacing; the manual default is 3 s).
 * - A failure on one account never stops the rest of the queue.
 * - Cancellation via AbortSignal leaves un-attempted entries pending.
 */

const controllers = new Map<string, AbortController>();

export function isActionJobRunning(jobId: string): boolean {
  return controllers.has(jobId);
}

export function cancelActionJob(jobId: string): void {
  controllers.get(jobId)?.abort();
}

/** Accounts that can never act (§7-1). */
export const UNACTABLE = new Set(['locked', 'frozen', 'logged_out']);

export function parseHandleFromPostUrl(url: string): string | null {
  const m = url.match(/x\.com\/([^/?#]+)\/status\//i) ?? url.match(/twitter\.com\/([^/?#]+)\/status\//i);
  return m ? m[1] : null;
}

export interface RunActionJobRequest {
  kind: BulkActionKind;
  /** Post URLs (like / repost / bookmark) or @handles (follow). */
  targets: string[];
  accountIds: readonly string[];
  /** Seconds between accounts (default 3). */
  intervalSec?: number;
  queueOneByOne?: boolean;
  ruleId?: string;
  signal?: AbortSignal;
}

export async function createAndRunActionJob(req: RunActionJobRequest): Promise<ActionJob> {
  const intervalSec = req.intervalSec ?? 3;
  const all = await listAccounts();
  const byId = new Map(all.map((a) => [a.id, a]));
  const accounts = req.accountIds
    .map((id) => byId.get(id))
    .filter((a): a is Account => !!a);

  // Build entries: queue mode = target-major, otherwise account-major.
  const entries: ActionJobEntry[] = [];
  const pairs: { account: Account; target: string }[] = [];
  if (req.queueOneByOne) {
    for (const target of req.targets) {
      for (const account of accounts) pairs.push({ account, target });
    }
  } else {
    for (const account of accounts) {
      for (const target of req.targets) pairs.push({ account, target });
    }
  }
  for (const { account, target } of pairs) {
    const authorHandle =
      req.kind === 'follow' ? target.replace(/^@/, '') : parseHandleFromPostUrl(target);
    const isAuthor = authorHandle !== null && authorHandle.toLowerCase() === account.handle.toLowerCase();
    entries.push({
      accountId: account.id,
      handle: account.handle,
      target,
      status: isAuthor ? 'skipped' : 'pending',
      error: isAuthor ? '投稿したアカウント自身のため除外' : undefined,
      at: isAuthor ? Date.now() : undefined,
    });
  }

  const job = await createActionJob({
    kind: req.kind,
    targets: [...req.targets],
    queueOneByOne: req.queueOneByOne ?? false,
    status: 'running',
    entries,
    ruleId: req.ruleId,
    startedAt: Date.now(),
  });

  const controller = new AbortController();
  if (req.signal) {
    if (req.signal.aborted) controller.abort();
    else req.signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  controllers.set(job.id, controller);
  const signal = controller.signal;
  const emit = async () => {
    await updateActionJob(job.id, { entries: [...entries] });
  };

  try {
    const pending = entries.filter((e) => e.status === 'pending');
    let processed = 0;
    for (const entry of entries) {
      if (signal.aborted) break;
      if (entry.status !== 'pending') continue;
      const account = byId.get(entry.accountId);
      if (!account) {
        entry.status = 'skipped';
        entry.error = 'アカウントが削除されました';
        entry.at = Date.now();
        await emit();
        continue;
      }
      if (UNACTABLE.has(account.status)) {
        entry.status = 'skipped';
        entry.error = `アカウントの状態が「${account.status}」のためスキップ`;
        entry.at = Date.now();
        await emit();
        continue;
      }
      entry.status = 'running';
      await emit();
      try {
        const result: ActionResult = await executor.executeAction(
          account,
          req.kind,
          req.kind === 'follow'
            ? { targetHandle: entry.target.replace(/^@/, '') }
            : { postUrl: entry.target },
        );
        entry.at = result.at;
        if (result.ok) {
          entry.status = 'done';
        } else {
          entry.status = 'failed';
          entry.error = result.error ?? '実行に失敗しました';
        }
      } catch (err) {
        entry.status = 'failed';
        entry.error = err instanceof Error ? err.message : '実行に失敗しました';
        entry.at = Date.now();
      }
      await emit();
      processed++;
      // Interval between accounts (never after the last one).
      if (processed < pending.length && !signal.aborted) {
        await abortableWait(intervalSec * 1000, signal);
      }
    }
  } finally {
    controllers.delete(job.id);
  }

  const cancelled = signal.aborted;
  const status: ActionJob['status'] = cancelled
    ? 'cancelled'
    : entries.some((e) => e.status === 'failed')
      ? 'partial'
      : 'done';
  await updateActionJob(job.id, { status, finishedAt: Date.now(), entries });
  return { ...job, status, finishedAt: Date.now(), entries };
}
