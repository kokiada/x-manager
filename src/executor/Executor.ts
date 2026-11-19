import type { Account, AccountStatus } from '../db/types';

/**
 * Executor — the layer that actually delivers operations to X.
 *
 * XBoard does everything through per-account browser sessions instead
 * of the X API. A web app cannot reproduce that directly (browser
 * security model), so x-manager isolates it behind this interface:
 * the console (UI + queueing logic + spec-faithful parameters) is
 * complete on its own, and a local agent / browser extension /
 * desktop wrapper can later implement this same interface to perform
 * real operations. M1 ships SimulatorExecutor.
 *
 * Spec anchors (docs/xboard-research.md):
 * - bulk post: accounts processed top-to-bottom, interval 1–60 s,
 *   targets normal / reply / community, up to 20 media per post
 * - account check: status + notification/DM counts + follower count
 * - search-ban check: visibility in "話題" (topic) and "最新" (latest)
 *   search, performed *from another logged-in account*
 */

export type PostTargetType = 'normal' | 'reply' | 'community';

export interface PostContent {
  text: string;
  targetType?: PostTargetType;
  /** Required when targetType is 'reply'. */
  replyToUrl?: string;
  /** Required when targetType is 'community'. */
  communityId?: string;
  /** Number of media items attached (max 20 per post). */
  mediaCount?: number;
  /** Follow-up texts posted as a reply chain (ツリー投稿). */
  threadTexts?: string[];
  paidPartnership?: boolean;
}

export interface PostResult {
  accountId: string;
  ok: boolean;
  /** ID/URL of the created post when ok. */
  postId?: string;
  postUrl?: string;
  error?: string;
  at: number;
}

export type BulkActionKind = 'like' | 'repost' | 'bookmark' | 'follow';

export interface ActionTarget {
  /** For like / repost / bookmark. */
  postUrl?: string;
  /** For follow: the handle to follow. */
  targetHandle?: string;
}

export interface ActionResult {
  accountId: string;
  kind: BulkActionKind;
  ok: boolean;
  error?: string;
  at: number;
}

/** Result of one account check (research §10). */
export interface AccountCheckResult {
  accountId: string;
  status: AccountStatus;
  notifications: number;
  dmCount: number;
  followers: number;
  checkedAt: number;
}

/** Result of one search-ban check (research §9-1). null = fetch failed (⚠). */
export interface SearchBanCheckResult {
  accountId: string;
  checkedByAccountId: string;
  topicVisible: boolean | null;
  latestVisible: boolean | null;
  checkedAt: number;
}

export interface Executor {
  /** Post one (possibly threaded) post as the account. */
  executePost(account: Account, content: PostContent): Promise<PostResult>;
  /** Run one bulk action (like / repost / bookmark / follow). */
  executeAction(
    account: Account,
    kind: BulkActionKind,
    target: ActionTarget,
  ): Promise<ActionResult>;
  /** Refresh status, notification/DM counts and follower count. */
  checkAccount(account: Account): Promise<AccountCheckResult>;
  /**
   * Check search visibility of `account`'s posts from the viewpoint of
   * `viaAccount` (must be logged in and not locked/frozen).
   */
  checkSearchBan(account: Account, viaAccount: Account): Promise<SearchBanCheckResult>;
}
