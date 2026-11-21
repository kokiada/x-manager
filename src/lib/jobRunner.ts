import type { Account } from '../db/types';
import type { ComposePayload, MediaMeta, PostJobEntry } from '../db/types';
import type { PostContent, PostMediaItem, PostResult } from '../executor/Executor';
import { expandRandomText, type RandomWordSets } from './randomText';
import { buildPostContent } from './bulkPost';

/**
 * Bulk-post job runner (research §6-1/§6-2).
 *
 * - Accounts are processed strictly in the given order (top-to-bottom).
 * - Between accounts the runner waits the chosen interval (1–60 s);
 *   there is no wait before the first or after the last account.
 * - Accounts that cannot post (locked / frozen / logged out) are
 *   marked 'skipped' without calling the executor.
 * - [RandomN] placeholders are expanded per account at post time, so
 *   every account posts a different variation (§6-3).
 * - A failure on one account never stops the rest of the queue.
 * - Cancellation via AbortSignal: the current wait is interrupted and
 *   un-attempted accounts stay 'pending'.
 *
 * The runner is UI- and DB-free: persistence and progress display are
 * the caller's job through `onUpdate`. `wait` and `rng` are injectable
 * for deterministic tests.
 */

export interface JobRunnerDeps {
  executePost: (account: Account, content: PostContent) => Promise<PostResult>;
  /** Wait `ms`, rejecting early when `signal` aborts. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
  onUpdate?: (entries: PostJobEntry[]) => void | Promise<void>;
  rng?: () => number;
  /**
   * メディアのファイル本体を base64 で取り出す（投稿画面の
   * セッション内メモリから）。無ければ null を返す。未指定の場合、
   * メディア付き投稿は bytes 無しで Executor に渡される
   * （シミュレータは mediaCount だけを見る。拡張は bytes が無いと
   * 失敗を返す）。
   */
  resolveMedia?: (meta: MediaMeta) => Promise<PostMediaItem | null>;
}

/** Default wait: setTimeout-based, interrupted by abort. */
export function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted || ms <= 0) return resolve();
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Statuses that can never post and are skipped up front. */
const UNPOSTABLE = new Set(['locked', 'frozen', 'logged_out']);

export interface RunBulkPostInput {
  /** Target accounts in execution order. */
  accounts: readonly Account[];
  payload: ComposePayload;
  intervalSec: number;
  /** Extra random gap (seconds) added per interval, 0–intervalJitterSec. */
  intervalJitterSec?: number;
  wordSets: RandomWordSets;
  signal: AbortSignal;
  deps: JobRunnerDeps;
  /** Initial entries (defaults to pending entries built from accounts). */
  initialEntries?: PostJobEntry[];
}

export function pendingEntries(accounts: readonly Account[]): PostJobEntry[] {
  return accounts.map((a) => ({ accountId: a.id, handle: a.handle, status: 'pending' }));
}

export async function runBulkPostJob(input: RunBulkPostInput): Promise<PostJobEntry[]> {
  const { accounts, payload, intervalSec, wordSets, signal, deps } = input;
  const rng = deps.rng ?? Math.random;
  const entries: PostJobEntry[] = input.initialEntries
    ? input.initialEntries.map((e) => ({ ...e }))
    : pendingEntries(accounts);
  const byId = new Map(entries.map((e) => [e.accountId, e]));
  const emit = async () => {
    try {
      await deps.onUpdate?.(entries.map((e) => ({ ...e })));
    } catch {
      // 進捗の保存に失敗しても投稿そのものは止めない（保存の不具合で
      // ジョブ全体が「実行中」のまま残る、という無言の停止を防ぐ）。
      // 最終結果は createAndRunJob が保存し直す。
    }
  };

  for (let i = 0; i < accounts.length; i++) {
    if (signal.aborted) break;
    const account = accounts[i];
    const entry = byId.get(account.id);
    if (!entry) continue;

    if (UNPOSTABLE.has(account.status)) {
      entry.status = 'skipped';
      entry.error = `アカウントの状態が「${account.status}」のためスキップ`;
      entry.at = Date.now();
      await emit();
    } else {
      entry.status = 'running';
      await emit();
      try {
        // Expand random text per post (per account), then build the call.
        const expanded = payload.segments.map((seg) => expandRandomText(seg, wordSets, rng));
        const { content, attached } = buildPostContent(payload, expanded, rng);
        // メディア付きの場合、ファイル本体をここで載せる。
        // 無い（テンプレート由来の名前だけ等）ファイルがあれば、
        // そのアカウントは失敗として記録し、Executor は呼ばない。
        if (attached.length > 0) {
          const resolved: PostMediaItem[] = [];
          let missing: MediaMeta | null = null;
          for (const meta of attached) {
            const item = deps.resolveMedia ? await deps.resolveMedia(meta) : null;
            if (!item) {
              missing = meta;
              break;
            }
            resolved.push(item);
          }
          if (missing) {
            entry.status = 'failed';
            entry.error = `メディア「${missing.name}」のファイル本体がありません。投稿画面で画像・動画を選び直してください。`;
            entry.at = Date.now();
            await emit();
          } else {
            content.media = resolved;
            const result = await deps.executePost(account, content);
            entry.at = result.at;
            if (result.ok) {
              entry.status = 'done';
              entry.postId = result.postId;
              entry.postUrl = result.postUrl;
              entry.threadPostIds = result.threadPostIds;
            } else {
              entry.status = 'failed';
              entry.error = result.error ?? '投稿に失敗しました';
            }
            await emit();
          }
        } else {
          const result = await deps.executePost(account, content);
          entry.at = result.at;
          if (result.ok) {
            entry.status = 'done';
            entry.postId = result.postId;
            entry.postUrl = result.postUrl;
            entry.threadPostIds = result.threadPostIds;
          } else {
            entry.status = 'failed';
            entry.error = result.error ?? '投稿に失敗しました';
          }
          await emit();
        }
      } catch (err) {
        entry.status = 'failed';
        entry.error = err instanceof Error ? err.message : '投稿に失敗しました';
        entry.at = Date.now();
        await emit();
      }
    }

    // Interval between accounts (never after the last one). With
    // intervalJitterSec, each gap is intervalSec + 0..jitter seconds
    // (auto-post §6-6: 60 s + 0–30 s between accounts). The rng is
    // only drawn when jitter is configured, so the no-jitter path
    // behaves exactly as before.
    if (i < accounts.length - 1 && !signal.aborted) {
      const jitter = input.intervalJitterSec ? rng() * input.intervalJitterSec : 0;
      await deps.wait((intervalSec + jitter) * 1000, signal);
    }
  }

  return entries;
}

/** Final job status from its entries (cancelled is decided by the caller). */
export function summarizeJobStatus(entries: readonly PostJobEntry[]): 'done' | 'partial' {
  return entries.some((e) => e.status === 'failed') ? 'partial' : 'done';
}
