import { executor } from '../executor';
import type { BanCheckResult, SearchBanState } from '../db/types';
import {
  getAccount,
  listAccounts,
  recordBanCheckResult,
} from '../db/repository';
import {
  CHECKS_PER_WINDOW_PER_CHECKER,
  planSearchBanChecks,
  SEARCH_WINDOW_MS,
} from './searchBanPacing';

/**
 * Ban-check batch service (research §9-1).
 *
 * Checker accounts share the load (round-robin per the pacing plan).
 * When a checker exhausts its 15-minute / 50-query budget, the run
 * pauses for a short *simulated* wait (default ~1.2 s) and logs the
 * real 15-minute wait it stands in for — it never actually blocks
 * for 15 minutes. Every verdict is persisted as a BanCheckResult row
 * and the account's searchBan state is updated by the executor.
 */

export interface BanCheckProgress {
  done: number;
  total: number;
  phase: 'checking' | 'waiting';
  message: string;
}

/** Verdict from the two search tabs (§9-1). null on either side = fetch failed (⚠). */
export function searchBanVerdict(
  topicVisible: boolean | null,
  latestVisible: boolean | null,
): SearchBanState {
  if (topicVisible === null || latestVisible === null) return 'unknown';
  if (topicVisible && latestVisible) return 'visible';
  if (!topicVisible && latestVisible) return 'topic_hidden';
  return 'both_hidden';
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runBanCheckBatch(opts: {
  checkerIds: string[];
  targetIds: string[];
  onProgress?: (p: BanCheckProgress) => void;
  /**
   * Simulated auto-wait pause. Defaults to 1,200 ms; pass 0 in tests.
   * The real 15-minute X window is never waited out in the app.
   */
  waitFn?: (ms: number) => Promise<void>;
}): Promise<BanCheckResult[]> {
  const { onProgress, waitFn = sleep } = opts;
  const all = await listAccounts();
  const byId = new Map(all.map((a) => [a.id, a]));

  const checkers = opts.checkerIds
    .map((id) => byId.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a && a.status === 'logged_in');
  if (checkers.length === 0) {
    throw new Error('チェックに使えるログイン済みアカウントがありません');
  }
  const targets = opts.targetIds
    .map((id) => byId.get(id))
    .filter((a): a is NonNullable<typeof a> => !!a);
  if (targets.length === 0) {
    throw new Error('チェック対象のアカウントがありません');
  }

  const plan = planSearchBanChecks(targets.length, checkers.length);
  const results: BanCheckResult[] = [];
  let done = 0;

  for (const assignment of plan.assignments) {
    const checker = checkers[assignment.checkerIndex];
    let checksByThisChecker = 0;
    for (const targetIndex of assignment.targetIndices) {
      if (checksByThisChecker > 0 && checksByThisChecker % CHECKS_PER_WINDOW_PER_CHECKER === 0) {
        onProgress?.({
          done,
          total: targets.length,
          phase: 'waiting',
          message: `検索制限（15分50回）に達しました。@${checker.handle} は自動で待機します（実際は15分ですが、ここでは短い待機で代用）`,
        });
        await waitFn(1200);
      }
      const target = targets[targetIndex];
      onProgress?.({
        done,
        total: targets.length,
        phase: 'checking',
        message: `@${target.handle} をチェック中（確認: @${checker.handle}）`,
      });
      const verdict = await executor.checkSearchBan(target, checker);
      const row = await recordBanCheckResult({
        accountId: verdict.accountId,
        handle: target.handle,
        checkedByAccountId: verdict.checkedByAccountId,
        topicVisible: verdict.topicVisible,
        latestVisible: verdict.latestVisible,
        checkedAt: verdict.checkedAt,
      });
      results.push(row);
      done++;
      checksByThisChecker++;
      onProgress?.({ done, total: targets.length, phase: 'checking', message: '' });
    }
  }
  return results;
}

/** Remaining simulated wait (ms) for a batch of this size — for display. */
export function plannedWaitMs(targetCount: number, checkerCount: number): number {
  return planSearchBanChecks(targetCount, checkerCount).totalWaitMs;
}

export { SEARCH_WINDOW_MS };

/** Run a single-account check (used by the account-detail page). */
export async function runSingleBanCheck(
  accountId: string,
  checkerId?: string,
): Promise<BanCheckResult | null> {
  const account = await getAccount(accountId);
  if (!account) return null;
  const all = await listAccounts();
  const checker =
    (checkerId ? all.find((a) => a.id === checkerId) : undefined) ??
    all.find((a) => a.id !== accountId && a.status === 'logged_in');
  if (!checker) return null;
  const verdict = await executor.checkSearchBan(account, checker);
  return recordBanCheckResult({
    accountId: verdict.accountId,
    handle: account.handle,
    checkedByAccountId: verdict.checkedByAccountId,
    topicVisible: verdict.topicVisible,
    latestVisible: verdict.latestVisible,
    checkedAt: verdict.checkedAt,
  });
}
