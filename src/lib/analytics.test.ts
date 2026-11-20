import { describe, expect, it } from 'vitest';
import {
  fetchCap,
  fetcherError,
  requiredFetchers,
  sortAnalytics,
  type AnalyticsRow,
} from './analytics';

const rows: AnalyticsRow[] = [
  { likes: 10, reposts: 2, bookmarks: 1, views: 1000, postedAt: 3000 },
  { likes: 50, reposts: 1, bookmarks: 9, views: 500, postedAt: 1000 },
  { likes: 20, reposts: 8, bookmarks: 3, views: 2000, postedAt: 2000 },
];

describe('fetchCap (§12-1: trial 50 / plan accounts × 10)', () => {
  it('trial is always 50', () => {
    expect(fetchCap(20, true)).toBe(50);
    expect(fetchCap(500, true)).toBe(50);
  });

  it('paid plan cap is plan accounts × 10', () => {
    expect(fetchCap(20, false)).toBe(200);
    expect(fetchCap(100, false)).toBe(1000);
    expect(fetchCap(500, false)).toBe(5000);
  });
});

describe('requiredFetchers (§12-1: 1000→≥2, 2000→≥3)', () => {
  it('small fetches need one account', () => {
    expect(requiredFetchers(50)).toBe(1);
    expect(requiredFetchers(999)).toBe(1);
  });

  it('1,000 posts need two accounts', () => {
    expect(requiredFetchers(1000)).toBe(2);
    expect(requiredFetchers(1500)).toBe(2);
  });

  it('2,000 posts need three accounts', () => {
    expect(requiredFetchers(2000)).toBe(3);
    expect(requiredFetchers(5000)).toBe(3);
  });
});

describe('fetcherError', () => {
  it('accepts a sufficient fetcher set', () => {
    expect(fetcherError(200, 1)).toBeNull();
    expect(fetcherError(1000, 2)).toBeNull();
    expect(fetcherError(2000, 3)).toBeNull();
  });

  it('rejects too few fetchers and none at all', () => {
    expect(fetcherError(1000, 1)).toContain('2つ以上');
    expect(fetcherError(2000, 2)).toContain('3つ以上');
    expect(fetcherError(100, 0)).toContain('1つ以上');
  });

  it('rejects more than three fetchers', () => {
    expect(fetcherError(100, 4)).toContain('最大3つ');
  });
});

describe('sortAnalytics', () => {
  it('sorts descending by each metric key', () => {
    expect(sortAnalytics(rows, 'likes').map((r) => r.likes)).toEqual([50, 20, 10]);
    expect(sortAnalytics(rows, 'reposts').map((r) => r.reposts)).toEqual([8, 2, 1]);
    expect(sortAnalytics(rows, 'bookmarks').map((r) => r.bookmarks)).toEqual([9, 3, 1]);
    expect(sortAnalytics(rows, 'views').map((r) => r.views)).toEqual([2000, 1000, 500]);
  });

  it('sorts by date, newest first', () => {
    expect(sortAnalytics(rows, 'date').map((r) => r.postedAt)).toEqual([3000, 2000, 1000]);
  });

  it('does not mutate the input array', () => {
    const copy = [...rows];
    sortAnalytics(rows, 'likes');
    expect(rows).toEqual(copy);
  });
});
