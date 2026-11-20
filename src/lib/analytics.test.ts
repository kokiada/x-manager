import { describe, expect, it } from 'vitest';
import {
  engagementRate,
  followerTrend,
  simulateMetrics,
  sortTrackedPosts,
  trackedPostsFromJobs,
  viewsPerHour,
} from './analytics';
import type { PostJob, PostMetric } from '../db/types';

describe('simulateMetrics', () => {
  it('is deterministic for the same post', () => {
    const a = simulateMetrics('post-1', 3, 1000);
    const b = simulateMetrics('post-1', 3, 1000);
    expect(a).toEqual(b);
  });
  it('grows with age and stays internally consistent', () => {
    const early = simulateMetrics('post-2', 0.5, 1000);
    const late = simulateMetrics('post-2', 48, 1000);
    expect(late.views).toBeGreaterThanOrEqual(early.views);
    expect(late.likes).toBeLessThanOrEqual(late.views);
    expect(late.reposts).toBeLessThanOrEqual(late.likes + 1);
  });
});

describe('engagementRate / sortTrackedPosts', () => {
  const base: PostMetric = {
    id: 'x', postId: 'p1', accountId: 'a', handle: 'h',
    postUrl: '', text: '', postedAt: 0, at: 0,
    likes: 10, reposts: 2, bookmarks: 1, views: 100,
  };
  it('computes the rate', () => {
    expect(engagementRate(base)).toBeCloseTo(0.13);
    expect(engagementRate({ ...base, views: 0 })).toBe(0);
  });
  it('sorts by views descending', () => {
    const rows = [base, { ...base, postId: 'p2', views: 500, likes: 1 }];
    expect(sortTrackedPosts(rows, 'views')[0].postId).toBe('p2');
    expect(sortTrackedPosts(rows, 'likes')[0].postId).toBe('p1');
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
      { id: 'a:2026-11-18', accountId: 'a', date: '2026-11-18', followers: 100, at: 1 },
      { id: 'a:2026-11-19', accountId: 'a', date: '2026-11-19', followers: 110, at: 2 },
      { id: 'a:2026-11-21', accountId: 'a', date: '2026-11-21', followers: 105, at: 3 },
    ]);
    expect(points[0].change).toBeNull();
    expect(points[1].change).toBe(10);
    expect(points[1].gap).toBe(false);
    expect(points[2].change).toBe(-5);
    expect(points[2].gap).toBe(true);
  });
});

describe('viewsPerHour', () => {
  it('divides views by hours since posting', () => {
    const m = { views: 200, postedAt: 0 } as unknown as PostMetric;
    expect(viewsPerHour(m, 2 * 3600_000)).toBeCloseTo(100);
  });
});
