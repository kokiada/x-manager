import { describe, expect, it } from 'vitest';
import {
  autoActionMatches,
  autoActionReactors,
  autoPostSlots,
  dailyCapReached,
  dueAutoPostSlots,
  skipForSearchBan,
  slotKey,
  timeOnDate,
} from './automation';
import type { Account, AutomationRule } from '../db/types';

const rule = (over: Partial<AutomationRule>): AutomationRule => ({
  id: 'r1',
  kind: 'auto_post',
  name: 'test',
  enabled: true,
  accountIds: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

describe('autoPostSlots — window mode', () => {
  it('spreads posts across the window, one per slot', () => {
    const now = new Date(2026, 10, 20, 12, 0).getTime();
    const slots = autoPostSlots(
      rule({ mode: 'window', windowStart: '06:00', windowEnd: '20:00', postsPerDay: 4 }),
      now,
    );
    expect(slots).toHaveLength(4);
    expect(slots[0]).toBeGreaterThanOrEqual(timeOnDate('2026-11-20', '06:00') - 15 * 60_000);
    expect(slots[3]).toBeLessThanOrEqual(timeOnDate('2026-11-20', '20:00') + 15 * 60_000);
    expect([...slots].sort((a, b) => a - b)).toEqual(slots);
  });
  it('is deterministic per rule + date', () => {
    const now = new Date(2026, 10, 20, 12, 0).getTime();
    const r = rule({ mode: 'window', windowStart: '06:00', windowEnd: '20:00', postsPerDay: 4 });
    expect(autoPostSlots(r, now)).toEqual(autoPostSlots(r, now));
  });
});

describe('autoPostSlots — times / weekly mode', () => {
  it('applies jitter to fixed times', () => {
    const now = new Date(2026, 10, 20, 12, 0).getTime();
    const slots = autoPostSlots(rule({ mode: 'times', times: ['09:00'], jitterMin: 15 }), now);
    expect(slots).toHaveLength(1);
    expect(Math.abs(slots[0] - timeOnDate('2026-11-20', '09:00'))).toBeLessThanOrEqual(15 * 60_000);
  });
  it('weekly mode only fires on chosen weekdays (2026-11-20 is a Friday)', () => {
    const now = new Date(2026, 10, 20, 12, 0).getTime();
    expect(new Date(now).getDay()).toBe(5);
    const friday = rule({ mode: 'weekly', times: ['09:00'], weekdays: [5] });
    expect(autoPostSlots(friday, now)).toHaveLength(1);
    const monday = rule({ mode: 'weekly', times: ['09:00'], weekdays: [1] });
    expect(autoPostSlots(monday, now)).toHaveLength(0);
  });
});

describe('dueAutoPostSlots', () => {
  it('fires a slot at its time and skips it once fired or 15+ min overdue', () => {
    const r = rule({ mode: 'times', times: ['09:00'], jitterMin: 0 });
    const slot = timeOnDate('2026-11-20', '09:00');
    const atSlot = slot + 60_000;
    expect(dueAutoPostSlots(r, atSlot, new Set())).toEqual([slot]);
    expect(dueAutoPostSlots(r, atSlot, new Set([slotKey('r1', slot)]))).toEqual([]);
    expect(dueAutoPostSlots(r, slot + 16 * 60_000, new Set())).toEqual([]);
    expect(dueAutoPostSlots(r, slot - 60_000, new Set())).toEqual([]);
  });
});

describe('skipForSearchBan', () => {
  const now = Date.now();
  it('skips a recently banned account, not an old verdict or a clean one', () => {
    const banned = { searchBan: 'topic_hidden', lastCheckedAt: now - 3600_000 } as Account;
    expect(skipForSearchBan(banned, now)).toBe(true);
    const stale = { searchBan: 'both_hidden', lastCheckedAt: now - 25 * 3600_000 } as Account;
    expect(skipForSearchBan(stale, now)).toBe(false);
    const clean = { searchBan: 'visible', lastCheckedAt: now } as Account;
    expect(skipForSearchBan(clean, now)).toBe(false);
  });
});

describe('autoActionMatches / reactors / cap', () => {
  const now = Date.now();
  it('requires freshness and the keyword', () => {
    const r = rule({ kind: 'auto_action', actionKinds: ['like'], keyword: '鹿島' });
    expect(autoActionMatches(r, { text: '鹿島すごい', postedAt: now - 3600_000 }, now)).toBe(true);
    expect(autoActionMatches(r, { text: '関係ない話', postedAt: now - 3600_000 }, now)).toBe(false);
    expect(autoActionMatches(r, { text: '鹿島すごい', postedAt: now - 7 * 3600_000 }, now)).toBe(false);
  });
  it('excludes the author and same-proxy accounts', () => {
    const author = { id: 'a1', proxyGroupId: 'px1', status: 'logged_in' } as Account;
    const sameProxy = { id: 'a2', proxyGroupId: 'px1', status: 'logged_in' } as Account;
    const other = { id: 'a3', proxyGroupId: 'px2', status: 'logged_in' } as Account;
    const locked = { id: 'a4', proxyGroupId: null, status: 'locked' } as Account;
    expect(autoActionReactors([author, sameProxy, other, locked], author)).toEqual([other]);
  });
  it('enforces the daily cap', () => {
    expect(dailyCapReached(9, 10)).toBe(false);
    expect(dailyCapReached(10, 10)).toBe(true);
    expect(dailyCapReached(999, undefined)).toBe(false);
  });
});
