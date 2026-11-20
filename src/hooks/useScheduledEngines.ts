import { useEffect, useRef } from 'react';
import { executor } from '../executor';
import {
  getMeta,
  getSettings,
  listAccounts,
  localDateString,
  recordFollowerHistory,
  setMeta,
} from '../db/repository';
import { runBanCheckBatch } from '../lib/banCheckService';
import { tickAutoPost } from '../lib/autoPostEngine';
import { runAutoActionCycle } from '../lib/autoActionEngine';

/**
 * Scheduled engines (M3/M4) — runs while the app is open.
 *
 * Every 60 s (and once on mount):
 *  (1) scheduled account check from Settings (enabled + today's time
 *      not yet run + within the 15-min late window; research §10);
 *      follower history for today is written from the results (§12-3).
 *  (2) scheduled search-ban check likewise (§9-1). The research §10
 *      note that scheduled account checks do NOT do the combined
 *      ban判定 applies to the account check itself; the ban check is
 *      its own scheduled item here, which §9-1 explicitly supports.
 *  (3) auto-action cycle tick (simulated incoming post, modest
 *      probability, §7-2).
 *
 * Auto-post ticks every 30 s on its own interval (§6-6).
 * All ticks are best-effort, guarded against overlap, and silent on
 * success. Nothing fires while the app is closed.
 */

const LATE_MS = 15 * 60_000;

function timeTodayMs(time: string, now: number): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const d = new Date(now);
  d.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return d.getTime();
}

async function runScheduledAccountCheck(now: number): Promise<void> {
  const settings = await getSettings();
  const schedule = settings.accountCheck;
  if (!schedule.enabled) return;
  const scheduledAt = timeTodayMs(schedule.time, now);
  if (scheduledAt === null) return;
  if (now < scheduledAt || now - scheduledAt > LATE_MS) return;
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

async function runScheduledBanCheck(now: number): Promise<void> {
  const settings = await getSettings();
  const schedule = settings.searchBanCheck;
  if (!schedule.enabled) return;
  const scheduledAt = timeTodayMs(schedule.time, now);
  if (scheduledAt === null) return;
  if (now < scheduledAt || now - scheduledAt > LATE_MS) return;
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

export function useScheduledEngines(): void {
  const busy = useRef(false);

  useEffect(() => {
    let disposed = false;

    const tickHourly = async () => {
      if (busy.current) return;
      busy.current = true;
      try {
        const now = Date.now();
        await runScheduledAccountCheck(now);
        if (disposed) return;
        await runScheduledBanCheck(now);
        if (disposed) return;
        await runAutoActionCycle({ probability: 0.5 });
      } catch {
        /* best-effort: the next tick retries */
      } finally {
        busy.current = false;
      }
    };

    const tickAutoPostJob = async () => {
      try {
        await tickAutoPost(Date.now());
      } catch {
        /* best-effort */
      }
    };

    void tickHourly();
    void tickAutoPostJob();
    const hourlyTimer = setInterval(tickHourly, 60_000);
    const autoPostTimer = setInterval(tickAutoPostJob, 30_000);
    return () => {
      disposed = true;
      clearInterval(hourlyTimer);
      clearInterval(autoPostTimer);
    };
  }, []);
}
