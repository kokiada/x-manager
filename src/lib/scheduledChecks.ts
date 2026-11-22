import { executor } from '../executor';
import {
  getMeta,
  getSettings,
  listAccounts,
  localDateString,
  recordFollowerHistory,
  setMeta,
} from '../db/repository';
import { runBanCheckBatch } from './banCheckService';

/**
 * Scheduled checks (research §10, §9-1, §12-3).
 *
 * Runs while the app is open, on the hourly tick in
 * useScheduledEngines: a scheduled account check and a scheduled
 * search-ban check. Each runs at most once per day, only inside the
 * 15-minute late window after its scheduled time, and never stops
 * the rest of the tick when one account fails.
 *
 * Extracted from useScheduledEngines so the schedule logic can be
 * tested without React.
 */

export const SCHEDULED_CHECK_LATE_MS = 15 * 60_000;

export function timeTodayMs(time: string, now: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const h = Number(match[1]);
  const m = Number(match[2]);
  // setHours は範囲外を翌日へ繰り越してしまうため、ここで弾く。
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

/**
 * Scheduled account check from Settings (enabled + today's time not
 * yet run + within the 15-min late window; §10). Follower history
 * for today is written from the results (§12-3).
 */
export async function runScheduledAccountCheck(now: number): Promise<void> {
  const settings = await getSettings();
  const schedule = settings.accountCheck;
  if (!schedule.enabled) return;
  const scheduledAt = timeTodayMs(schedule.time, now);
  if (scheduledAt === null) return;
  if (now < scheduledAt || now - scheduledAt > SCHEDULED_CHECK_LATE_MS) return;
  const dateKey = localDateString(now);
  const metaKey = `sched:accountCheck:${dateKey}`;
  if (await getMeta<boolean>(metaKey, false)) return;
  await setMeta(metaKey, true); // claim the day before running

  const accounts = await listAccounts();
  const targets = schedule.groupId
    ? accounts.filter((a) => a.groupId === schedule.groupId)
    : accounts;
  for (const account of targets) {
    try {
      const result = await executor.checkAccount(account);
      await recordFollowerHistory(account.id, result.followers, dateKey);
    } catch {
      /* one account failing must not stop the rest */
    }
  }
}

/** Scheduled search-ban check, same once-a-day + late-window rule (§9-1). */
export async function runScheduledBanCheck(now: number): Promise<void> {
  const settings = await getSettings();
  const schedule = settings.searchBanCheck;
  if (!schedule.enabled) return;
  const scheduledAt = timeTodayMs(schedule.time, now);
  if (scheduledAt === null) return;
  if (now < scheduledAt || now - scheduledAt > SCHEDULED_CHECK_LATE_MS) return;
  const dateKey = localDateString(now);
  const metaKey = `sched:searchBanCheck:${dateKey}`;
  if (await getMeta<boolean>(metaKey, false)) return;
  await setMeta(metaKey, true);

  const accounts = await listAccounts();
  const targets = (schedule.groupId
    ? accounts.filter((a) => a.groupId === schedule.groupId)
    : accounts
  ).map((a) => a.id);
  const checkers = accounts
    .filter((a) => a.status === 'logged_in')
    .slice(0, 3)
    .map((a) => a.id);
  if (targets.length === 0 || checkers.length === 0) return;
  try {
    await runBanCheckBatch({ checkerIds: checkers, targetIds: targets });
  } catch {
    /* best-effort: tomorrow's run retries */
  }
}
