import { describe, expect, it } from 'vitest';
import {
  CHECKS_PER_WINDOW_PER_CHECKER,
  planSearchBanChecks,
  SEARCH_WINDOW_MS,
} from './searchBanPacing';

describe('planSearchBanChecks (§9-1: 15 min / 50 queries, 1 check = 2 queries)', () => {
  it('25 checks fit one window with a single checker', () => {
    const plan = planSearchBanChecks(25, 1);
    expect(plan.windows).toBe(1);
    expect(plan.totalWaitMs).toBe(0);
    expect(plan.totalQueries).toBe(50);
    expect(plan.assignments[0].targetIndices).toHaveLength(25);
  });

  it('26 checks with one checker trigger a 15-minute auto-wait', () => {
    const plan = planSearchBanChecks(26, 1);
    expect(plan.windows).toBe(2);
    expect(plan.totalWaitMs).toBe(SEARCH_WINDOW_MS);
    expect(plan.assignments[0].windows).toBe(2);
  });

  it('two checkers halve the load so 26 checks fit one window', () => {
    const plan = planSearchBanChecks(26, 2);
    expect(plan.windows).toBe(1);
    expect(plan.totalWaitMs).toBe(0);
    expect(plan.assignments[0].targetIndices).toHaveLength(13);
    expect(plan.assignments[1].targetIndices).toHaveLength(13);
  });

  it('51 checks with one checker span three windows (30 min wait)', () => {
    const plan = planSearchBanChecks(51, 1);
    expect(plan.windows).toBe(3);
    expect(plan.totalWaitMs).toBe(2 * SEARCH_WINDOW_MS);
  });

  it('zero targets need no window and no wait', () => {
    const plan = planSearchBanChecks(0, 1);
    expect(plan.windows).toBe(0);
    expect(plan.totalWaitMs).toBe(0);
    expect(plan.totalQueries).toBe(0);
  });

  it('one checker handles 25 checks per window', () => {
    expect(CHECKS_PER_WINDOW_PER_CHECKER).toBe(25);
    const plan = planSearchBanChecks(100, 4);
    expect(plan.windows).toBe(1);
    expect(plan.totalWaitMs).toBe(0);
  });
});
