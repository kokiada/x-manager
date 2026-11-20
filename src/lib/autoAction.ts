import type { Account, AutoActionKindFilter } from '../db/types';

/**
 * Auto-action stagger / eligibility logic (research §7-2).
 *
 * - Same account's actions are staggered 10–30 s apart; actions
 *   across accounts are 2–6 s apart, one action at a time.
 * - The daily cap is shared across all rules (実行待ち分も含めて数える).
 * - The same post never fires twice from the same rule.
 * - The post's author and accounts on the author's proxy are excluded,
 *   as are locked / frozen / logged-out / paused accounts.
 * - Traction ("伸びたとき") compares against the author's 24h median
 *   and only applies once ≥5 posts are recorded; the 1.5× trigger
 *   threshold is a demo choice — the manual gives no number.
 */

export const SAME_ACCOUNT_STAGGER_MIN_MS = 10_000;
export const SAME_ACCOUNT_STAGGER_MAX_MS = 30_000;
export const CROSS_ACCOUNT_STAGGER_MIN_MS = 2_000;
export const CROSS_ACCOUNT_STAGGER_MAX_MS = 6_000;

/** Delay between two actions by the same account (10–30 s). */
export function sameAccountStaggerMs(rng: () => number = Math.random): number {
  return Math.round(
    SAME_ACCOUNT_STAGGER_MIN_MS +
      rng() * (SAME_ACCOUNT_STAGGER_MAX_MS - SAME_ACCOUNT_STAGGER_MIN_MS),
  );
}

/** Delay between actions across different accounts (2–6 s). */
export function crossAccountStaggerMs(rng: () => number = Math.random): number {
  return Math.round(
    CROSS_ACCOUNT_STAGGER_MIN_MS +
      rng() * (CROSS_ACCOUNT_STAGGER_MAX_MS - CROSS_ACCOUNT_STAGGER_MIN_MS),
  );
}

/** True when the shared daily cap is exhausted. */
export function dailyCapReached(doneToday: number, cap: number): boolean {
  return doneToday >= cap;
}

/** True when this rule already reacted to this post (§7-2: no double reaction). */
export function isDuplicateAction(
  events: readonly { ruleId: string; postUrl: string }[],
  ruleId: string,
  postUrl: string,
): boolean {
  return events.some((e) => e.ruleId === ruleId && e.postUrl === postUrl);
}

/**
 * Accounts eligible to act on a post: exclude the author, accounts
 * sharing the author's proxy, and any locked / frozen / logged-out /
 * paused account. `actingIds` is the rule's list, or 'all'.
 */
export function eligibleActingAccounts(
  accounts: readonly Account[],
  author: Account,
  actingIds: readonly string[],
  pausedAccountIds: ReadonlySet<string> = new Set(),
): Account[] {
  const wanted = actingIds.includes('all') ? null : new Set(actingIds);
  return accounts.filter((a) => {
    if (a.id === author.id) return false;
    if (wanted && !wanted.has(a.id)) return false;
    if (a.status !== 'logged_in') return false;
    if (pausedAccountIds.has(a.id)) return false;
    // Same-proxy exclusion (§7-2): accounts on the author's proxy
    // never act on the author's posts.
    if (author.proxyGroupId && a.proxyGroupId === author.proxyGroupId) return false;
    return true;
  });
}

/** Kind filter: image posts count GIFs as image (§7-2). */
export function matchesKindFilter(
  kindFilter: AutoActionKindFilter,
  hasImage: boolean,
  hasVideo: boolean,
): boolean {
  switch (kindFilter) {
    case 'any':
      return true;
    case 'image':
      return hasImage;
    case 'video':
      return hasVideo;
    case 'text':
      return !hasImage && !hasVideo;
  }
}

/** All keywords must appear in the text (case-insensitive). Empty = match all. */
export function matchesKeywords(text: string, keywords: readonly string[]): boolean {
  if (keywords.length === 0) return true;
  const lower = text.toLowerCase();
  return keywords.every((k) => k.trim() !== '' && lower.includes(k.trim().toLowerCase()));
}

/** Median of a numeric list; null when empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Traction trigger: current engagement at least 1.5× the 24h median. */
export function tractionTriggered(current: number, baselineMedian: number): boolean {
  return baselineMedian > 0 && current >= baselineMedian * 1.5;
}
