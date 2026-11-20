import type { Account, AutomationRule, SearchBanState } from '../db/types';
import { seededRandom } from './analytics';

/**
 * Automation scheduling (research §6-6 auto-post, §7-2 auto-action).
 *
 * - Auto-post "window" mode spreads the day's posts across the
 *   window so they do not bunch up; "times" mode posts at fixed
 *   times with an optional ± jitter; "weekly" posts at one time on
 *   chosen weekdays (±5 min). A slot more than 15 minutes overdue is
 *   skipped (§6-6).
 * - Auto-action reacts only to posts from registered accounts found
 *   within 6 hours, never twice to the same post with the same rule,
 *   and never from the posting account or an account sharing its
 *   proxy (§7-2).
 * - Slot times are deterministic per rule + date so a reload does not
 *   move the day's schedule.
 */

export function parseTimeToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => Number.parseInt(v, 10));
  return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0);
}

export function minutesToTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Local "YYYY-MM-DD" for a timestamp. */
export function localDateKey(ts: number): string {
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Epoch ms for a local date + "HH:MM". */
export function timeOnDate(dateKey: string, hhmm: string): number {
  const [y, mo, d] = dateKey.split('-').map(Number);
  const minutes = parseTimeToMinutes(hhmm);
  return new Date(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60).getTime();
}

/**
 * Today's auto-post slots for a rule. Window mode spreads posts
 * evenly across the window with ±15 min deterministic jitter; an
 * end earlier than the start means the window runs into the next
 * day (§6-6). Times mode applies the rule's jitter to each time;
 * weekly mode uses times[0] on the chosen weekdays only.
 */
export function autoPostSlots(rule: AutomationRule, now: number): number[] {
  const today = localDateKey(now);
  const weekday = new Date(now).getDay();
  const rng = seededRandom(`${rule.id}:${today}`);

  if (rule.mode === 'times' || !rule.mode) {
    const jitter = rule.jitterMin ?? 15;
    return (rule.times ?? []).map((t) => {
      const base = timeOnDate(today, t);
      const shift = jitter > 0 ? Math.round((rng() * 2 - 1) * jitter) : 0;
      return base + shift * 60_000;
    });
  }

  if (rule.mode === 'weekly') {
    if (!(rule.weekdays ?? []).includes(weekday)) return [];
    const t = rule.times?.[0];
    if (!t) return [];
    const shift = Math.round((rng() * 2 - 1) * 5);
    return [timeOnDate(today, t) + shift * 60_000];
  }

  // window mode
  const start = parseTimeToMinutes(rule.windowStart ?? '07:00');
  let end = parseTimeToMinutes(rule.windowEnd ?? '23:00');
  if (end <= start) end += 1440;
  const perDay = Math.max(1, rule.postsPerDay ?? 3);
  const span = end - start;
  const slots: number[] = [];
  for (let i = 0; i < perDay; i++) {
    const mid = start + ((i + 0.5) * span) / perDay;
    const shift = Math.round((rng() * 2 - 1) * 15);
    slots.push(timeOnDate(today, minutesToTime(Math.round(mid))) + shift * 60_000);
  }
  return slots.sort((a, b) => a - b);
}

/** Slots due right now: within [now - 15min, now], not yet fired (§6-6). */
export function dueAutoPostSlots(
  rule: AutomationRule,
  now: number,
  firedKeys: ReadonlySet<string>,
): number[] {
  const overdueLimit = 15 * 60_000;
  return autoPostSlots(rule, now).filter((slot) => {
    if (slot > now || now - slot > overdueLimit) return false;
    return !firedKeys.has(slotKey(rule.id, slot));
  });
}

/** Stable key for a fired slot (rule + slot time). */
export function slotKey(ruleId: string, slot: number): string {
  return `${ruleId}@${slot}`;
}

/** Skip accounts with a search-ban verdict in the last 24h (§6-6). */
export function skipForSearchBan(account: Account, now: number): boolean {
  const banned: SearchBanState[] = ['topic_hidden', 'both_hidden'];
  if (!banned.includes(account.searchBan)) return false;
  if (!account.lastCheckedAt) return false;
  return now - account.lastCheckedAt <= 24 * 3600_000;
}

/** Auto-action trigger: post is fresh and matches the rule's filter (§7-2). */
export function autoActionMatches(
  rule: AutomationRule,
  post: { text: string; postedAt: number },
  now: number,
): boolean {
  if (now - post.postedAt > 6 * 3600_000) return false;
  if (post.postedAt > now) return false;
  const keyword = (rule.keyword ?? '').trim();
  if (keyword && !post.text.toLowerCase().includes(keyword.toLowerCase())) return false;
  return (rule.actionKinds ?? []).length > 0;
}

/** Accounts that may react to a post: not the author, not sharing the author's proxy (§7-2). */
export function autoActionReactors(
  candidates: readonly Account[],
  author: Account,
): Account[] {
  return candidates.filter((a) => {
    if (a.id === author.id) return false;
    if (author.proxyGroupId && a.proxyGroupId === author.proxyGroupId) return false;
    return a.status === 'logged_in';
  });
}

/** Daily cap check (§7-2): executed + queued today vs the cap. */
export function dailyCapReached(doneToday: number, cap?: number): boolean {
  if (!cap || cap <= 0) return false;
  return doneToday >= cap;
}
