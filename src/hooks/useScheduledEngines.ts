import { useEffect, useRef } from 'react';
import { runScheduledAccountCheck, runScheduledBanCheck } from '../lib/scheduledChecks';
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
