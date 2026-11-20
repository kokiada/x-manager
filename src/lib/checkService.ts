import type { Account, CheckRun, CheckRunEntry, SearchBanState } from '../db/types';
import {
  addInboxItems,
  createCheckRun,
  listAccounts,
  recordFollowerSnapshot,
  updateCheckRun,
} from '../db/repository';
import type { AccountCheckResult, Executor, SearchBanCheckResult } from '../executor/Executor';

/**
 * Check services (research §9-1 search-ban check, §10 account check).
 *
 * - Account check: status + notification/DM counts + follower count,
 *   recorded as a CheckRun; follower counts feed the trend (§12-3)
 *   and notification/DM deltas feed the inbox (§11).
 * - Search-ban check: each target is checked from another logged-in
 *   account (round-robin when several checkers are picked); the X
 *   search limit is 50 searches / 15 min per checker account and one
 *   account check spends 2 searches (topic + latest).
 * - Both are also fired by the periodic engine (useCheckScheduler)
 *   from the schedules saved in Settings.
 */

/** Local "YYYY-MM-DD" for a timestamp (follower snapshots are per-day). */
export function dateKey(ts: number): string {
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

/**
 * Milliseconds to wait for the X search rate limit to clear, given
 * how many accounts have already been checked with this many checker
 * accounts in the current 15-minute window. 0 = no wait needed.
 */
export function searchRateLimitWaitMs(checkedCount: number, checkerCount: number): number {
  if (checkerCount <= 0) return 0;
  const searchesUsed = checkedCount * 2;
  const budget = 50 * checkerCount;
  return searchesUsed <= budget ? 0 : 15 * 60_000;
}

/** Usable as a search-ban checker (§9-1): logged in, not locked/frozen. */
export function isUsableChecker(account: Account): boolean {
  return account.status === 'logged_in';
}

/* ------------------------- inbox feed from checks ------------------------ */

const NOTIFICATION_TITLES = [
  'いいねされました',
  'リポストされました',
  '返信がありました',
  'メンションされました',
  'フォローされました',
];

/** Turn notification/DM count increases into inbox items (§11). */
export function inboxItemsForCheck(
  account: Account,
  before: { notifications: number; dmCount: number },
  at: number,
): { kind: 'notification' | 'dm'; title: string; body: string }[] {
  const items: { kind: 'notification' | 'dm'; title: string; body: string }[] = [];
  const addedNotifications = Math.max(0, account.notifications - before.notifications);
  const addedDm = Math.max(0, account.dmCount - before.dmCount);
  for (let i = 0; i < Math.min(addedNotifications, 3); i++) {
    const title = NOTIFICATION_TITLES[(at + i) % NOTIFICATION_TITLES.length];
    items.push({
      kind: 'notification',
      title,
      body: `@${account.handle} への${title}。アカウントチェックで件数が増えていました。`,
    });
  }
  for (let i = 0; i < Math.min(addedDm, 3); i++) {
    items.push({
      kind: 'dm',
      title: '新しいDMが届きました',
      body: `@${account.handle} にDMが届いています。内容はXで確認してください。`,
    });
  }
  return items;
}

/* ------------------------------ account check ---------------------------- */

export interface RunAccountChecksOptions {
  scheduled?: boolean;
  onProgress?: (done: number, total: number, handle: string) => void;
}

/**
 * Run account checks for the given accounts through the executor.
 * Executor results are already written back to the account rows by
 * the executor itself; this service adds the CheckRun record, the
 * follower snapshots, and the inbox items.
 */
export async function runAccountChecks(
  accounts: readonly Account[],
  executor: Executor,
  opts: RunAccountChecksOptions = {},
): Promise<CheckRun> {
  const run = await createCheckRun({
    kind: 'account',
    status: 'running',
    scheduled: opts.scheduled ?? false,
    entries: [],
  });
  const entries: CheckRunEntry[] = [];
  const today = dateKey(Date.now());
  for (let i = 0; i < accounts.length; i++) {
    const account = accounts[i];
    opts.onProgress?.(i, accounts.length, account.handle);
    const before = { notifications: account.notifications, dmCount: account.dmCount };
    try {
      const result: AccountCheckResult = await executor.checkAccount(account);
      entries.push({
        accountId: account.id,
        handle: account.handle,
        status: result.status,
        notifications: result.notifications,
        dmCount: result.dmCount,
        followers: result.followers,
      });
      await recordFollowerSnapshot(account.id, today, result.followers);
      const fresh = { ...account, notifications: result.notifications, dmCount: result.dmCount };
      const items = inboxItemsForCheck(fresh, before, result.checkedAt);
      if (items.length > 0) {
        await addInboxItems(
          items.map((item) => ({
            accountId: account.id,
            handle: account.handle,
            kind: item.kind,
            title: item.title,
            body: item.body,
            at: result.checkedAt,
            read: false,
          })),
        );
      }
    } catch (err) {
      entries.push({
        accountId: account.id,
        handle: account.handle,
        status: account.status,
        error: err instanceof Error ? err.message : 'チェックに失敗しました',
      });
    }
    await updateCheckRun(run.id, { entries: [...entries] });
  }
  opts.onProgress?.(accounts.length, accounts.length, '');
  await updateCheckRun(run.id, { status: 'done', finishedAt: Date.now(), entries });
  return { ...run, status: 'done', finishedAt: Date.now(), entries };
}

/* ----------------------------- search-ban check -------------------------- */

export interface RunSearchBanChecksOptions {
  scheduled?: boolean;
  onProgress?: (done: number, total: number, handle: string) => void;
  /** When set, pause at the rate limit instead of stopping. Not used by the UI run. */
  waitForRateLimit?: (ms: number) => Promise<void>;
}

/**
 * Run search-ban checks. Checkers are used round-robin so the
 * 15-minute search budget is spread across them (§9-1). Returns the
 * finished CheckRun; entries with null visibility are ⚠ (fetch failed).
 */
export async function runSearchBanChecks(
  targets: readonly Account[],
  checkers: readonly Account[],
  executor: Executor,
  opts: RunSearchBanChecksOptions = {},
): Promise<CheckRun> {
  const run = await createCheckRun({
    kind: 'search_ban',
    status: 'running',
    scheduled: opts.scheduled ?? false,
    entries: [],
  });
  const usable = checkers.filter(isUsableChecker);
  const entries: CheckRunEntry[] = [];
  let checked = 0;
  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    opts.onProgress?.(i, targets.length, target.handle);
    if (usable.length === 0) {
      entries.push({
        accountId: target.id,
        handle: target.handle,
        topicVisible: null,
        latestVisible: null,
        error: 'チェックに使えるログイン済みアカウントがありません',
      });
      continue;
    }
    const waitMs = searchRateLimitWaitMs(checked, usable.length);
    if (waitMs > 0) {
      if (opts.waitForRateLimit) {
        await opts.waitForRateLimit(waitMs);
        checked = 0;
      } else {
        entries.push({
          accountId: target.id,
          handle: target.handle,
          topicVisible: null,
          latestVisible: null,
          error: `検索の制限（15分50回）に達しました。${Math.round(waitMs / 60000)}分待ってから続けてください`,
        });
        continue;
      }
    }
    const via = usable[checked % usable.length];
    try {
      const result: SearchBanCheckResult = await executor.checkSearchBan(target, via);
      checked++;
      entries.push({
        accountId: target.id,
        handle: target.handle,
        topicVisible: result.topicVisible,
        latestVisible: result.latestVisible,
        checkedByAccountId: result.checkedByAccountId,
        checkedByHandle: via.handle,
      });
    } catch (err) {
      entries.push({
        accountId: target.id,
        handle: target.handle,
        topicVisible: null,
        latestVisible: null,
        checkedByAccountId: via.id,
        checkedByHandle: via.handle,
        error: err instanceof Error ? err.message : 'チェックに失敗しました',
      });
    }
    await updateCheckRun(run.id, { entries: [...entries] });
  }
  opts.onProgress?.(targets.length, targets.length, '');
  await updateCheckRun(run.id, { status: 'done', finishedAt: Date.now(), entries });
  return { ...run, status: 'done', finishedAt: Date.now(), entries };
}

/** Accounts in a group (null = all), for check target selection. */
export async function accountsForGroup(groupId: string | null): Promise<Account[]> {
  const all = await listAccounts();
  return groupId ? all.filter((a) => a.groupId === groupId) : all;
}
