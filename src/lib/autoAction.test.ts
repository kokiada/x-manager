import { describe, expect, it } from 'vitest';
import type { Account } from '../db/types';
import {
  CROSS_ACCOUNT_STAGGER_MAX_MS,
  CROSS_ACCOUNT_STAGGER_MIN_MS,
  dailyCapReached,
  eligibleActingAccounts,
  isDuplicateAction,
  matchesKeywords,
  matchesKindFilter,
  median,
  sameAccountStaggerMs,
  crossAccountStaggerMs,
  tractionTriggered,
  SAME_ACCOUNT_STAGGER_MAX_MS,
  SAME_ACCOUNT_STAGGER_MIN_MS,
} from './autoAction';

function account(partial: Partial<Account> & { id: string }): Account {
  return {
    handle: partial.id,
    displayName: partial.id,
    groupId: null,
    proxyGroupId: null,
    status: 'logged_in',
    followers: 100,
    following: 10,
    notifications: 0,
    dmCount: 0,
    searchBan: 'visible',
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  };
}

describe('stagger delays (§7-2)', () => {
  it('same-account stagger is 10–30 s', () => {
    expect(sameAccountStaggerMs(() => 0)).toBe(SAME_ACCOUNT_STAGGER_MIN_MS);
    expect(sameAccountStaggerMs(() => 1)).toBe(SAME_ACCOUNT_STAGGER_MAX_MS);
    expect(sameAccountStaggerMs(() => 0.5)).toBe(20_000);
  });

  it('cross-account stagger is 2–6 s', () => {
    expect(crossAccountStaggerMs(() => 0)).toBe(CROSS_ACCOUNT_STAGGER_MIN_MS);
    expect(crossAccountStaggerMs(() => 1)).toBe(CROSS_ACCOUNT_STAGGER_MAX_MS);
    expect(crossAccountStaggerMs(() => 0.5)).toBe(4_000);
  });
});

describe('dailyCapReached', () => {
  it('reaches the cap exactly at the limit', () => {
    expect(dailyCapReached(9, 10)).toBe(false);
    expect(dailyCapReached(10, 10)).toBe(true);
    expect(dailyCapReached(11, 10)).toBe(true);
  });
});

describe('isDuplicateAction', () => {
  const events = [{ ruleId: 'r1', postUrl: 'https://x.com/a/status/1' }];
  it('detects the same rule + post firing twice', () => {
    expect(isDuplicateAction(events, 'r1', 'https://x.com/a/status/1')).toBe(true);
    expect(isDuplicateAction(events, 'r1', 'https://x.com/a/status/2')).toBe(false);
    expect(isDuplicateAction(events, 'r2', 'https://x.com/a/status/1')).toBe(false);
  });
});

describe('eligibleActingAccounts (§7-2 exclusions)', () => {
  const author = account({ id: 'author', proxyGroupId: 'px-1' });
  const pool = [
    author,
    account({ id: 'same-proxy', proxyGroupId: 'px-1' }),
    account({ id: 'ok-1', proxyGroupId: 'px-2' }),
    account({ id: 'locked', status: 'locked' }),
    account({ id: 'logged-out', status: 'logged_out' }),
    account({ id: 'frozen', status: 'frozen' }),
    account({ id: 'paused', proxyGroupId: 'px-2' }),
  ];

  it('excludes the author, same-proxy accounts, bad statuses and paused accounts', () => {
    const eligible = eligibleActingAccounts(pool, author, ['all'], new Set(['paused']));
    expect(eligible.map((a) => a.id)).toEqual(['ok-1']);
  });

  it('respects an explicit acting-account list', () => {
    const eligible = eligibleActingAccounts(pool, author, ['ok-1', 'locked']);
    expect(eligible.map((a) => a.id)).toEqual(['ok-1']);
  });

  it('does not apply the proxy exclusion when the author has no proxy', () => {
    const noProxyAuthor = account({ id: 'author2', proxyGroupId: null });
    const eligible = eligibleActingAccounts(pool, noProxyAuthor, ['all']);
    expect(eligible.map((a) => a.id)).toContain('same-proxy');
  });
});

describe('matchesKindFilter', () => {
  it('any matches everything', () => {
    expect(matchesKindFilter('any', false, false)).toBe(true);
    expect(matchesKindFilter('any', true, true)).toBe(true);
  });
  it('image / video / text split on media presence', () => {
    expect(matchesKindFilter('image', true, false)).toBe(true);
    expect(matchesKindFilter('image', false, true)).toBe(false);
    expect(matchesKindFilter('video', false, true)).toBe(true);
    expect(matchesKindFilter('text', false, false)).toBe(true);
    expect(matchesKindFilter('text', true, false)).toBe(false);
  });
});

describe('matchesKeywords', () => {
  it('empty keywords match everything; all keywords must appear', () => {
    expect(matchesKeywords('hello world', [])).toBe(true);
    expect(matchesKeywords('試合お疲れさま', ['試合'])).toBe(true);
    expect(matchesKeywords('試合お疲れさま', ['試合', 'お疲れ'])).toBe(true);
    expect(matchesKeywords('試合お疲れさま', ['試合', 'チケット'])).toBe(false);
  });
});

describe('median / tractionTriggered', () => {
  it('median of odd and even lists', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it('traction needs 1.5× the 24h median', () => {
    expect(tractionTriggered(150, 100)).toBe(true);
    expect(tractionTriggered(149, 100)).toBe(false);
    expect(tractionTriggered(10, 0)).toBe(false);
  });
});
