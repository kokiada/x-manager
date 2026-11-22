import type { Account, AccountStatus, ReplyPermission } from '../db/types';

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

/**
 * 1件の添付メディア（ファイル本体付き）。アプリ側が File から
 * base64 にして Executor に渡す。シミュレータは bytes を見ない。
 * 拡張モードでは ExtensionExecutor がチャンク転送で拡張へ送り、
 * 拡張が upload.x.com へ上げる。`dataBase64` は生バイナリの
 * base64（data: URL の接頭辞なし）。
 */
export interface PostMediaItem {
  name: string;
  mime: string;
  kind: 'image' | 'video';
  /** デコード後のバイト数（base64 長から換算する前の実サイズ）。 */
  size: number;
  dataBase64: string;
}

export interface PostContent {
  text: string;
  targetType?: PostTargetType;
  /** Required when targetType is 'reply'. */
  replyToUrl?: string;
  /** Required when targetType is 'community'. */
  communityId?: string;
  /** Number of media items attached (max 20 per post). */
  mediaCount?: number;
  /** Media items with their bytes (segment 1 only). Absent when none. */
  media?: PostMediaItem[];
  /** Follow-up texts posted as a reply chain (ツリー投稿). */
  threadTexts?: string[];
  /** Who may reply — normal posts only; on tree posts, segment 1 (§6-4). */
  replyPermission?: ReplyPermission;
  paidPartnership?: boolean;
}

export interface PostResult {
  accountId: string;
  ok: boolean;
  /** ID/URL of the created post when ok. */
  postId?: string;
  postUrl?: string;
  /** IDs of the tree continuations that were posted, in order. */
  threadPostIds?: string[];
  error?: string;
  at: number;
}

/** Result of deleting one previously created post (research §6-1). */
export interface DeletePostResult {
  accountId: string;
  postId: string;
  ok: boolean;
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
  /**
   * Xが 401/403 を返した（セッション切れ）ために status が
   * logged_out になった場合に true。呼び出し元はこれを見て
   * 「セッションが切れています」と分かる文言を表示する
   * （成功扱いの結果に紛れ込ませないため）。
   */
  sessionExpired?: boolean;
}

/** Result of one search-ban check (research §9-1). null = fetch failed (⚠). */
export interface SearchBanCheckResult {
  accountId: string;
  checkedByAccountId: string;
  topicVisible: boolean | null;
  latestVisible: boolean | null;
  checkedAt: number;
}

/** One post row returned by a post-analytics fetch (research §12-1). */
export interface PostAnalyticsItem {
  accountId: string;
  postId: string;
  postUrl: string;
  text: string;
  likes: number;
  reposts: number;
  bookmarks: number;
  views: number;
  postedAt: number;
  fetchedAt: number;
}

/** One notification / DM item (research §11). */
export interface NotificationItem {
  kind: 'notification' | 'dm';
  title: string;
  body: string;
  fromHandle?: string;
  at: number;
}

export interface Executor {
  /** Post one (possibly threaded) post as the account. */
  executePost(account: Account, content: PostContent): Promise<PostResult>;
  /**
   * Delete one post previously created by executePost. Tree posts are
   * deleted by calling this for the main post and each continuation —
   * the console groups those calls into one operator action (§6-1).
   */
  deletePost(account: Account, postId: string): Promise<DeletePostResult>;
  /** Run one bulk action (like / repost / bookmark / follow). */
  executeAction(
    account: Account,
    kind: BulkActionKind,
    target: ActionTarget,
  ): Promise<ActionResult>;
  /** Refresh status, notification/DM counts and follower count. */
  checkAccount(account: Account): Promise<AccountCheckResult>;
  /**
   * Resolve the real handle for a linked extension session
   * (verify_credentials). Used when importing a session that has no
   * handle, so the ledger never gets a placeholder handle (linked-…).
   * Extension mode only.
   */
  resolveAccountIdentity(accountId: string): Promise<{ accountId: string; handle: string }>;
  /**
   * Check search visibility of `account`'s posts from the viewpoint of
   * `viaAccount` (must be logged in and not locked/frozen).
   */
  checkSearchBan(account: Account, viaAccount: Account): Promise<SearchBanCheckResult>;
  /**
   * Fetch the account's recent posts with engagement metrics for post
   * analytics (research §12-1). `fetcherAccounts` are the accounts
   * used to fetch (up to 3; see lib/analytics for the count rules).
   */
  fetchPostAnalytics(
    account: Account,
    fetcherAccounts: Account[],
  ): Promise<PostAnalyticsItem[]>;
  /**
   * Fetch the account's recent notifications and DMs (research §11).
   * Only counts are documented by the manual; a real executor would
   * fetch the actual items — the simulator generates plausible demo
   * items from the account's current counts (labelled as demo in the
   * simulator's comments).
   */
  fetchNotifications(account: Account): Promise<NotificationItem[]>;
}
