import type { ComposePayload, MediaMeta, PostJob, Reservation } from '../db/types';
import {
  createPostJob,
  getAccount,
  getPostJob,
  getRandomWordSets,
  listAccounts,
  updatePostJob,
  updateReservation,
} from '../db/repository';
import { executor } from '../executor';
import type { PostMediaItem } from '../executor/Executor';
import {
  abortableWait,
  pendingEntries,
  runBulkPostJob,
  summarizeJobStatus,
} from './jobRunner';

/**
 * Service layer for bulk posting: creates PostJob records, runs them
 * through the job runner with the active Executor, and persists every
 * entry transition so the UI (and the reservation scheduler) can
 * observe progress through Dexie live queries.
 *
 * Note on reservations: XBoard creates real X scheduled posts at
 * reservation time (expanding [RandomN] then). x-manager reservations
 * are local — they fire through this same runner at the scheduled
 * time while the app is open, so random expansion happens per account
 * at execution, exactly like an immediate bulk post.
 */

const controllers = new Map<string, AbortController>();
const firingReservations = new Set<string>();

export function isJobRunning(jobId: string): boolean {
  return controllers.has(jobId);
}

export function cancelJob(jobId: string): void {
  controllers.get(jobId)?.abort();
}

export interface RunJobRequest {
  /** Target account IDs in execution order (top-to-bottom). */
  accountIds: readonly string[];
  payload: ComposePayload;
  intervalSec: number;
  /** Extra random gap (seconds) added per interval, 0–intervalJitterSec. */
  intervalJitterSec?: number;
  kind: 'immediate' | 'reservation';
  reservationId?: string;
  /**
   * メディアのファイル本体の解決（投稿画面のセッション内メモリ）。
   * 未指定の場合、メディア付き投稿は bytes 無しで Executor に渡る
   * （予約の発火時など、ファイルがもう無い場合と同じ扱い）。
   */
  resolveMedia?: (meta: MediaMeta) => Promise<PostMediaItem | null>;
}

/** Create a post job and run it to completion (or cancellation). */
export async function createAndRunJob(req: RunJobRequest): Promise<PostJob> {
  const all = await listAccounts();
  const byId = new Map(all.map((a) => [a.id, a]));
  const accounts = req.accountIds
    .map((id) => byId.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a);
  // Accounts deleted after the job was composed get a skipped entry.
  const missing = req.accountIds.filter((id) => !byId.has(id));

  const job = await createPostJob({
    kind: req.kind,
    reservationId: req.reservationId,
    status: 'running',
    payload: req.payload,
    intervalSec: req.intervalSec,
    entries: [
      ...pendingEntries(accounts),
      ...missing.map((id) => ({
        accountId: id,
        handle: '(削除済み)',
        status: 'skipped' as const,
        error: 'アカウントが存在しません',
      })),
    ],
    startedAt: Date.now(),
  });

  const controller = new AbortController();
  controllers.set(job.id, controller);
  let finalJob: PostJob = job;
  try {
    const wordSets = await getRandomWordSets();
    const entries = await runBulkPostJob({
      accounts,
      payload: req.payload,
      intervalSec: req.intervalSec,
      intervalJitterSec: req.intervalJitterSec,
      wordSets,
      signal: controller.signal,
      initialEntries: job.entries,
      deps: {
        executePost: (account, content) => executor.executePost(account, content),
        wait: abortableWait,
        resolveMedia: req.resolveMedia,
        onUpdate: async (updated) => {
          await updatePostJob(job.id, { entries: updated });
        },
      },
    });
    const cancelled = controller.signal.aborted;
    const status = cancelled ? 'cancelled' : summarizeJobStatus(entries);
    await updatePostJob(job.id, {
      entries,
      status,
      finishedAt: Date.now(),
    });
    finalJob =
      (await getPostJob(job.id)) ?? { ...job, entries, status, finishedAt: Date.now() };
  } catch (err) {
    // ランナー外の予期せぬ失敗（保存の読み取り・書き込みの失敗など）
    // でも、ジョブを「実行中」のまま残さない。未完了のエントリを
    // 失敗として記録し、状態を partial で締める。例外はここで吸収し、
    // 呼び出し元の完了トーストが出るようにする（無言の停止にしない）。
    const message =
      err instanceof Error && err.message.trim()
        ? err.message
        : '一括投稿に失敗しました';
    const latest = await getPostJob(job.id).catch(() => undefined);
    const base = latest ?? job;
    const entries = base.entries.map((e) =>
      e.status === 'pending' || e.status === 'running'
        ? { ...e, status: 'failed' as const, error: message, at: Date.now() }
        : e,
    );
    const status = summarizeJobStatus(entries);
    try {
      await updatePostJob(job.id, { entries, status, finishedAt: Date.now() });
    } catch {
      // 保存自体が壊れている場合は、メモリ上の結果だけ返す。
    }
    finalJob = { ...base, entries, status, finishedAt: Date.now() };
  } finally {
    controllers.delete(job.id);
  }
  return finalJob;
}

/**
 * Fire a due reservation: mark it fired and run its payload as a job.
 * Safe against double-firing from overlapping scheduler ticks.
 */
export async function fireReservation(reservation: Reservation): Promise<void> {
  if (reservation.status !== 'pending' || firingReservations.has(reservation.id)) return;
  firingReservations.add(reservation.id);
  try {
    const job = await createAndRunJob({
      accountIds: reservation.accountIds,
      payload: reservation.payload,
      intervalSec: reservation.intervalSec,
      kind: 'reservation',
      reservationId: reservation.id,
    });
    await updateReservation(reservation.id, { status: 'fired', jobId: job.id });
  } finally {
    firingReservations.delete(reservation.id);
  }
}

/**
 * Delete the post(s) one job entry created, via the executor. For a
 * tree post, the main post and every continuation are deleted as one
 * grouped action (research §6-1). Returns the number deleted.
 */
export async function deleteEntryPosts(jobId: string, accountId: string): Promise<number> {
  const job = await getPostJob(jobId);
  if (!job) throw new Error('ジョブが見つかりません');
  const entry = job.entries.find((e) => e.accountId === accountId);
  if (!entry || entry.status !== 'done' || !entry.postId || entry.deletedAt) {
    throw new Error('削除できるポストがありません');
  }
  const account = await getAccount(accountId);
  if (!account) throw new Error('アカウントが見つかりません');

  const ids = [entry.postId, ...(entry.threadPostIds ?? [])];
  let deleted = 0;
  for (const postId of ids) {
    const result = await executor.deletePost(account, postId);
    if (!result.ok) {
      throw new Error(result.error ?? `ポストの削除に失敗しました（${postId}）`);
    }
    deleted++;
  }
  const entries = job.entries.map((e) =>
    e.accountId === accountId ? { ...e, deletedAt: Date.now() } : e,
  );
  await updatePostJob(jobId, { entries });
  return deleted;
}
