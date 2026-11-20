/**
 * Post-analytics helpers (research §12-1).
 *
 * - Fetch caps: trial = 50 posts; a paid plan = plan accounts × 10.
 * - Fetcher accounts (up to 3): 1,000 posts need ≥2, 2,000 need ≥3.
 * - Results sort by likes / reposts / bookmarks / views / date.
 */

export const ANALYTICS_TRIAL_CAP = 50;
export const ANALYTICS_MAX_FETCHERS = 3;

export type AnalyticsSortKey = 'likes' | 'reposts' | 'bookmarks' | 'views' | 'date';

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

const KEY_VALUE: Record<Exclude<AnalyticsSortKey, 'date'>, (r: AnalyticsRow) => number> = {
  likes: (r) => r.likes,
  reposts: (r) => r.reposts,
  bookmarks: (r) => r.bookmarks,
  views: (r) => r.views,
};

/** Sort a copy of the rows, descending, by the chosen key. */
export function sortAnalytics<T extends AnalyticsRow>(rows: readonly T[], key: AnalyticsSortKey): T[] {
  return [...rows].sort((a, b) => {
    const av = key === 'date' ? a.postedAt : KEY_VALUE[key](a);
    const bv = key === 'date' ? b.postedAt : KEY_VALUE[key](b);
    return bv - av;
  });
}
