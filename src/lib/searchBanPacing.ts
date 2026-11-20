/**
 * Search-ban query-budget planner (research §9-1).
 *
 * X's search is limited to 50 queries per 15 minutes; one account
 * check costs 2 queries (「話題」 + 「最新」). With a single checker
 * account, 26+ checks hit the limit and the run must auto-wait for
 * the window to reset. Multiple checker accounts split the load, so
 * the wait shrinks by the number of checkers.
 *
 * Pure function: it plans the batch; the service layer executes it.
 */

export const SEARCH_QUERIES_PER_WINDOW = 50;
export const SEARCH_QUERIES_PER_CHECK = 2;
export const SEARCH_WINDOW_MS = 15 * 60_000;
/** Checks one checker account can run inside a single 15-min window. */
export const CHECKS_PER_WINDOW_PER_CHECKER =
  SEARCH_QUERIES_PER_WINDOW / SEARCH_QUERIES_PER_CHECK; // 25

export interface CheckerAssignment {
  checkerIndex: number;
  /** Indices into the target list, in execution order. */
  targetIndices: number[];
  /** 15-min windows this checker needs. */
  windows: number;
}

export interface BanCheckPlan {
  assignments: CheckerAssignment[];
  /** Number of 15-min windows the whole batch spans. */
  windows: number;
  /** Simulated auto-wait (ms) before the last check can run. */
  totalWaitMs: number;
  totalQueries: number;
}

/**
 * Plan a ban-check batch. Targets are dealt round-robin across the
 * checker accounts so the load — and the auto-wait — is shared.
 */
export function planSearchBanChecks(
  targetCount: number,
  checkerCount: number,
): BanCheckPlan {
  const checkers = Math.max(1, checkerCount);
  const assignments: CheckerAssignment[] = Array.from(
    { length: checkers },
    (_, checkerIndex) => ({ checkerIndex, targetIndices: [] as number[], windows: 0 }),
  );
  for (let i = 0; i < targetCount; i++) {
    assignments[i % checkers].targetIndices.push(i);
  }
  let maxWindows = 0;
  for (const a of assignments) {
    a.windows =
      a.targetIndices.length === 0
        ? 0
        : Math.ceil(a.targetIndices.length / CHECKS_PER_WINDOW_PER_CHECKER);
    maxWindows = Math.max(maxWindows, a.windows);
  }
  const windows = targetCount === 0 ? 0 : Math.max(1, maxWindows);
  return {
    assignments,
    windows,
    totalWaitMs: Math.max(0, windows - 1) * SEARCH_WINDOW_MS,
    totalQueries: targetCount * SEARCH_QUERIES_PER_CHECK,
  };
}
