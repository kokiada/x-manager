import { describe, expect, it } from 'vitest';
import type { Account } from '../db/types';
import {
  dateKey,
  inboxItemsForCheck,
  searchBanVerdict,
  searchRateLimitWaitMs,
} from './checkService';

describe('searchBanVerdict', () => {
  it('both visible -> visible', () => {
    expect(searchBanVerdict(true, true)).toBe('visible');
  });
  it('topic hidden only -> topic_hidden', () => {
    expect(searchBanVerdict(false, true)).toBe('topic_hidden');
  });
  it('both hidden -> both_hidden', () => {
    expect(searchBanVerdict(false, false)).toBe('both_hidden');
  });
  it('fetch failure -> unknown', () => {
    expect(searchBanVerdict(null, true)).toBe('unknown');
    expect(searchBanVerdict(true, null)).toBe('unknown');
  });
});

describe('searchRateLimitWaitMs', () => {
  it('no wait under the budget (25 accounts, 1 checker)', () => {
    expect(searchRateLimitWaitMs(25, 1)).toBe(0);
  });
  it('waits 15 minutes once 26 accounts are checked with 1 checker', () => {
    expect(searchRateLimitWaitMs(26, 1)).toBe(15 * 60_000);
  });
  it('two checkers double the budget', () => {
    expect(searchRateLimitWaitMs(50, 2)).toBe(0);
    expect(searchRateLimitWaitMs(51, 2)).toBe(15 * 60_000);
  });
  it('no checkers -> no wait (caller reports the missing checker)', () => {
    expect(searchRateLimitWaitMs(99, 0)).toBe(0);
  });
});

describe('dateKey', () => {
  it('formats a local date', () => {
    const d = new Date(2026, 10, 20, 9, 5);
    expect(dateKey(d.getTime())).toBe('2026-11-20');
  });
});

describe('inboxItemsForCheck', () => {
  const account = {
    handle: 'demo',
    notifications: 5,
    dmCount: 2,
  } as unknown as Account;

  it('creates items only for the increase, capped at 3 per kind', () => {
    const items = inboxItemsForCheck(account, { notifications: 1, dmCount: 0 }, Date.now());
    expect(items.filter((i) => i.kind === 'notification')).toHaveLength(3);
    expect(items.filter((i) => i.kind === 'dm')).toHaveLength(2);
  });

  it('creates nothing when counts did not increase', () => {
    expect(inboxItemsForCheck(account, { notifications: 5, dmCount: 2 }, Date.now())).toHaveLength(0);
  });
});
