import type { FollowerSnapshot, PostJob, PostMetric } from '../db/types';

/**
 * Post analytics (research §12).
 *
 * - Tracked posts come from finished bulk-post jobs (§12-2: XBoard
 *   tracks posts made from the app, plus posts found from outside).
 * - Metrics are snapshots at the §12-2 checkpoints (30m / 1h / 3h /
 *   12h / 24h / 48h). The simulator derives plausible counts from the
 *   post ID and its age, so the curve exists without a live X
 *   connection; a real executor would fill these from public counts.
 * - Follower trend (§12-3) is one snapshot per account per day,
 *   recorded by account checks.
 */

/** Checkpoints (hours after posting) at which metrics are recorded. */
export const METRIC_CHECKPOINTS_HOURS = [0.5, 1, 3, 12, 24, 48];

/** Deterministic PRNG (mulberry32) seeded from a string. */
export function seededRandom(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Plausible metrics for a post of a given age. Views grow fast early
 * and flatten toward 48h; likes/reposts/bookmarks scale off views.
 * Deterministic per post ID so re-reads agree until a new snapshot
 * is recorded.
 */
export function simulateMetrics(
  postId: string,
  ageHours: number,
  followers: number,
): { likes: number; reposts: number; bookmarks: number; views: number } {
  const rng = seededRandom(postId);
  const base = Math.max(20, followers * (0.25 + rng() * 0.5));
  // Growth curve: ~55% of the 48h total by 3h, ~95% by 24h.
  const growth = Math.min(1, 0.35 + 0.65 * (1 - Math.exp(-ageHours / 9)));
  const views = Math.max(1, Math.round(base * growth * (0.9 + rng() * 0.2)));
  const likes = Math.max(0, Math.round(views * (0.015 + rng() * 0.02)));
  const reposts = Math.max(0, Math.round(likes * (0.15 + rng() * 0.2)));
  const bookmarks = Math.max(0, Math.round(likes * (0.08 + rng() * 0.15)));
  return { likes, reposts, bookmarks, views };
}

/** Engagement rate: (likes + reposts + bookmarks) / views. */
export function engagementRate(m: Pick<PostMetric, 'likes' | 'reposts' | 'bookmarks' | 'views'>): number {
  if (m.views <= 0) return 0;
  return (m.likes + m.reposts + m.bookmarks) / m.views;
}

export type TrackedPostSortKey = 'postedAt' | 'likes' | 'reposts' | 'bookmarks' | 'views' | 'engagement';

/** Sort tracked-post metrics by the chosen key (descending). */
export function sortTrackedPosts(metrics: PostMetric[], key: TrackedPostSortKey): PostMetric[] {
  const value = (m: PostMetric): number =>
    key === 'engagement' ? engagementRate(m) : m[key];
  return [...metrics].sort((a, b) => value(b) - value(a));
}

export interface TrackedPost {
  postId: string;
  accountId: string;
  handle: string;
  postUrl: string;
  text: string;
  postedAt: number;
}

/** Finished bulk-post entries become tracked posts (§12-2). */
export function trackedPostsFromJobs(jobs: PostJob[]): TrackedPost[] {
  const posts: TrackedPost[] = [];
  for (const job of jobs) {
    for (const entry of job.entries) {
      if (entry.status !== 'done' || !entry.postId) continue;
      posts.push({
        postId: entry.postId,
        accountId: entry.accountId,
        handle: entry.handle,
        postUrl: entry.postUrl ?? `https://x.com/${entry.handle}/status/${entry.postId}`,
        text: job.payload.segments[0] ?? '',
        postedAt: entry.at ?? job.startedAt,
      });
    }
  }
  return posts.sort((a, b) => b.postedAt - a.postedAt);
}

/** "表示/時" (§12-1): views per hour since posting. */
export function viewsPerHour(m: PostMetric, now: number): number {
  const hours = Math.max(0.5, (now - m.postedAt) / 3600_000);
  return m.views / hours;
}

export interface FollowerTrendPoint {
  date: string;
  followers: number;
  /** Change vs the previous recorded day; null for the first point or a gap. */
  change: number | null;
  /** True when the previous day is missing (shown dashed, §12-3). */
  gap: boolean;
}

/** Build the per-day trend for one account from its snapshots. */
export function followerTrend(snapshots: FollowerSnapshot[]): FollowerTrendPoint[] {
  const sorted = [...snapshots].sort((a, b) => a.date.localeCompare(b.date));
  return sorted.map((s, i) => {
    const prev = sorted[i - 1];
    if (!prev) return { date: s.date, followers: s.followers, change: null, gap: false };
    const prevDate = new Date(`${prev.date}T00:00:00`);
    const thisDate = new Date(`${s.date}T00:00:00`);
    const gapDays = Math.round((thisDate.getTime() - prevDate.getTime()) / 86_400_000);
    return {
      date: s.date,
      followers: s.followers,
      change: s.followers - prev.followers,
      gap: gapDays > 1,
    };
  });
}
