import { useEffect } from 'react';
import { listDueReservations } from '../db/repository';
import { fireReservation } from '../lib/bulkPostService';

/**
 * Lightweight reservation scheduler (M2 scope of research §6-5).
 *
 * While the app is open, due reservations fire through the same job
 * runner as immediate bulk posts. Checks run once on mount (app load)
 * and then every 30 seconds. Like XBoard's auto-post, nothing fires
 * while the app is closed; a reservation whose time passed while the
 * app was closed fires on the next launch check.
 */
export function useReservationScheduler(): void {
  useEffect(() => {
    let disposed = false;
    const tick = async () => {
      try {
        const due = await listDueReservations(Date.now());
        for (const reservation of due) {
          if (disposed) return;
          // fireReservation guards against overlapping ticks.
          void fireReservation(reservation);
        }
      } catch {
        /* best-effort: the next tick retries */
      }
    };
    void tick();
    const timer = setInterval(tick, 30_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, []);
}
