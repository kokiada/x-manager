import { describe, expect, it } from 'vitest';
import {
  engagementRate,
  fetchCap,
  fetcherError,
  followerTrend,
  requiredFetchers,
  seededRandom,
  simulateMetrics,
  sortAnalytics,
  trackedPostsFromJobs,
  viewsPerHour,
  type AnalyticsRow,
} from './analytics';
import type { PostJob } from '../db/types';

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

  it('sorts by engagement rate', () => {
    // rows[0]: 13/1000, rows[1]: 60/500, rows[2]: 31/2000 → [1, 2, 0].
    expect(sortAnalytics(rows, 'engagement').map((r) => r.likes)).toEqual([50, 20, 10]);
  });

  it('does not mutate the input array', () => {
    const copy = [...rows];
    sortAnalytics(rows, 'likes');
    expect(rows).toEqual(copy);
  });
});

describe('engagementRate', () => {
  it('computes (likes + reposts + bookmarks) / views', () => {
    expect(engagementRate({ likes: 10, reposts: 2, bookmarks: 1, views: 100 })).toBeCloseTo(0.13);
    expect(engagementRate({ likes: 10, reposts: 2, bookmarks: 1, views: 0 })).toBe(0);
  });
});

describe('seededRandom / simulateMetrics', () => {
  it('is deterministic for the same seed and post', () => {
    expect(seededRandom('abc')()).toBe(seededRandom('abc')());
    expect(simulateMetrics('post-1', 3, 1000)).toEqual(simulateMetrics('post-1', 3, 1000));
  });

  it('grows with age and stays internally consistent', () => {
    const early = simulateMetrics('post-2', 0.5, 1000);
    const late = simulateMetrics('post-2', 48, 1000);
    expect(late.views).toBeGreaterThanOrEqual(early.views);
    expect(late.likes).toBeLessThanOrEqual(late.views);
    expect(late.reposts).toBeLessThanOrEqual(late.likes + 1);
  });
});

describe('viewsPerHour', () => {
  it('divides views by hours since posting', () => {
    expect(viewsPerHour({ views: 200, postedAt: 0 }, 2 * 3600_000)).toBeCloseTo(100);
  });
});

describe('trackedPostsFromJobs', () => {
  it('keeps only finished entries with a post id', () => {
    const job = {
      payload: { segments: ['hello'] },
      startedAt: 1000,
      entries: [
        { accountId: 'a1', handle: 'h1', status: 'done', postId: 'p1', postUrl: 'u1', at: 1100 },
        { accountId: 'a2', handle: 'h2', status: 'failed' },
        { accountId: 'a3', handle: 'h3', status: 'done' },
      ],
    } as unknown as PostJob;
    const posts = trackedPostsFromJobs([job]);
    expect(posts).toHaveLength(1);
    expect(posts[0].postId).toBe('p1');
    expect(posts[0].text).toBe('hello');
  });
});

describe('followerTrend', () => {
  it('computes daily changes and flags gaps', () => {
    const points = followerTrend([
      { date: '2026-11-18', followers: 100 },
      { date: '2026-11-19', followers: 110 },
      { date: '2026-11-21', followers: 105 },
    ]);
    expect(points[0].change).toBeNull();
    expect(points[1].change).toBe(10);
    expect(points[1].gap).toBe(false);
    expect(points[2].change).toBe(-5);
    expect(points[2].gap).toBe(true);
  });
});
