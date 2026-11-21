import type { FollowerHistory, PostJob } from '../db/types';

/**
 * Post-analytics helpers (research §12-1).
 *
 * - Fetch caps: trial = 50 posts; a paid plan = plan accounts × 10.
 * - Fetcher accounts (up to 3): 1,000 posts need ≥2, 2,000 need ≥3.
 * - Results sort by likes / reposts / bookmarks / views / date.
 */

export const ANALYTICS_TRIAL_CAP = 50;
export const ANALYTICS_MAX_FETCHERS = 3;

export type AnalyticsSortKey = 'likes' | 'reposts' | 'bookmarks' | 'views' | 'date' | 'engagement';

export interface AnalyticsRow {
  likes: number;
  reposts: number;
  bookmarks: number;
  views: number;
  postedAt: number;
}

/** Fetch cap for the current plan (trial is always 50). */
export function fetchCap(planAccounts: number, trial: boolean): number {
  return trial ? ANALYTICS_TRIAL_CAP : planAccounts * 10;
}

/**
 * Minimum fetcher accounts for a requested post count (§12-1):
 * 1,000 posts need ≥2, 2,000 need ≥3.
 */
export function requiredFetchers(postCount: number): number {
  if (postCount >= 2000) return 3;
  if (postCount >= 1000) return 2;
  return 1;
}

/** Validation message when the fetcher selection cannot serve the request, else null. */
export function fetcherError(postCount: number, fetcherCount: number): string | null {
  const required = requiredFetchers(postCount);
  if (fetcherCount === 0) return '取得に使うアカウントを1つ以上選んでください';
  if (fetcherCount > ANALYTICS_MAX_FETCHERS) {
    return `取得に使うアカウントは最大${ANALYTICS_MAX_FETCHERS}つまでです`;
  }
  if (fetcherCount < required) {
    return `${postCount.toLocaleString('ja-JP')}件を取得するには取得アカウントが${required}つ以上必要です`;
  }
  return null;
}

const KEY_VALUE: Record<Exclude<AnalyticsSortKey, 'date' | 'engagement'>, (r: AnalyticsRow) => number> = {
  likes: (r) => r.likes,
  reposts: (r) => r.reposts,
  bookmarks: (r) => r.bookmarks,
  views: (r) => r.views,
};

/** Engagement rate: (likes + reposts + bookmarks) / views. */
export function engagementRate(
  m: Pick<AnalyticsRow, 'likes' | 'reposts' | 'bookmarks' | 'views'>,
): number {
  if (m.views <= 0) return 0;
  return (m.likes + m.reposts + m.bookmarks) / m.views;
}

/** Sort a copy of the rows, descending, by the chosen key. */
export function sortAnalytics<T extends AnalyticsRow>(rows: readonly T[], key: AnalyticsSortKey): T[] {
  return [...rows].sort((a, b) => {
    const av = key === 'date' ? a.postedAt : key === 'engagement' ? engagementRate(a) : KEY_VALUE[key](a);
    const bv = key === 'date' ? b.postedAt : key === 'engagement' ? engagementRate(b) : KEY_VALUE[key](b);
    return bv - av;
  });
}

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
 * is recorded. Used to backfill the 30m–48h tracking checkpoints
 * (§12-2) from a single fetch; a real executor would fill these
 * from live public counts.
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

/** "表示/時" (§12-1): views per hour since posting. */
export function viewsPerHour(
  m: Pick<AnalyticsRow, 'views' | 'postedAt'>,
  now: number,
): number {
  const hours = Math.max(0.5, (now - m.postedAt) / 3600_000);
  return m.views / hours;
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

export interface FollowerTrendPoint {
  date: string;
  followers: number;
  /** Change vs the previous recorded day; null for the first point or a gap. */
  change: number | null;
  /** True when the previous day is missing (shown dashed, §12-3). */
  gap: boolean;
}

/** Build the per-day trend for one account from its snapshots. */
export function followerTrend(
  snapshots: Pick<FollowerHistory, 'date' | 'followers'>[],
): FollowerTrendPoint[] {
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
