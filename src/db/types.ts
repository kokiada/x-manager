/**
 * Domain models for x-manager.
 * Specs follow the XBoard research in docs/xboard-research.md:
 * - account status is one of the five values the account check reports
 * - an account belongs to at most one proxy group; a proxy group can
 *   hold many accounts (manual recommends ~5 per proxy group)
 * - all data lives on-device (IndexedDB), never sent to a server
 */

export type AccountStatus =
  | 'logged_in'
  | 'logged_out'
  | 'locked'
  | 'frozen'
  | 'connection_error';

export const ACCOUNT_STATUSES: AccountStatus[] = [
  'logged_in',
  'logged_out',
  'locked',
  'frozen',
  'connection_error',
];

export const STATUS_LABELS: Record<AccountStatus, string> = {
  logged_in: 'ログイン済',
  logged_out: '未ログイン',
  locked: 'ロック中',
  frozen: '凍結中',
  connection_error: '接続エラー',
};

/** Search-ban visibility verdict from the last search-ban check. */
export type SearchBanState = 'visible' | 'topic_hidden' | 'both_hidden' | 'unknown';

export const SEARCH_BAN_LABELS: Record<SearchBanState, string> = {
  visible: '表示OK',
  topic_hidden: '話題のみ非表示',
  both_hidden: '両方非表示',
  unknown: '未判定',
};

/** Display grouping of accounts (XBoard "グループ"). */
export interface Group {
  id: string;
  name: string;
  order: number;
  createdAt: number;
}

/** A proxy endpoint accounts connect through (XBoard "プロキシグループ"). */
export interface ProxyGroup {
  id: string;
  name: string;
  host: string;
  port: number;
  /** Auth credentials — only for authenticated proxies. Stored on-device only. */
  username?: string;
  password?: string;
  note?: string;
  createdAt: number;
}

export interface Account {
  id: string;
  /** X handle without the leading @. */
  handle: string;
  displayName: string;
  groupId: string | null;
  /** At most one proxy group per account (XBoard spec). */
  proxyGroupId: string | null;
  status: AccountStatus;
  /**
   * X auth_token (40-char cookie value) used for token login.
   * Stored only in this device's IndexedDB and always masked in the UI.
   */
  authToken?: string;
  /**
   * X login credentials, kept for the operator's ledger and for the
   * account CSV (§5-1). Stored on-device only; settable via the CSV
   * only when the account is first created (XBoard rule).
   */
  loginId?: string;
  loginPassword?: string;
  /** 2FA (TOTP) secret token, same handling as the login credentials. */
  twoFactorSecret?: string;
  /** Display order within the account's group (CSV row order, §5-1). */
  order?: number;
  followers: number;
  following: number;
  /** Unread notification / DM counts as of the last account check. */
  notifications: number;
  dmCount: number;
  searchBan: SearchBanState;
  memo?: string;
  lastCheckedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export type NewAccount = Omit<Account, 'id' | 'createdAt' | 'updatedAt'>;

/* ====================== M5: plans & app settings ====================== */

/** Contract plans from the LP (research §18-1). No feature differences. */
export interface PlanTier {
  /** Max number of registered accounts. */
  accounts: number;
  monthlyPriceJpy: number;
}

export const PLAN_TIERS: PlanTier[] = [
  { accounts: 20, monthlyPriceJpy: 3000 },
  { accounts: 50, monthlyPriceJpy: 6000 },
  { accounts: 100, monthlyPriceJpy: 10000 },
  { accounts: 300, monthlyPriceJpy: 20000 },
  { accounts: 500, monthlyPriceJpy: 30000 },
];

/**
 * A daily scheduled-check setting (research §9-1 / §10). Only the
 * setting is stored here; the scheduling engines themselves are a
 * separate work package (M3).
 */
export interface CheckSchedule {
  enabled: boolean;
  /** Local time of day, "HH:MM". */
  time: string;
  /** Target group; null = all accounts. */
  groupId: string | null;
}

export interface AppSettings {
  /** Contracted plan, expressed as its account cap (see PLAN_TIERS). */
  planAccounts: number;
  /**
   * Browsers kept open simultaneously （同時に開いておくブラウザ数）.
   * Default 20; cannot exceed the plan's account cap.
   */
  maxConcurrentBrowsers: number;
  /** Default interval (seconds) pre-filled on the bulk-post screen. */
  defaultIntervalSec: number;
  accountCheck: CheckSchedule;
  searchBanCheck: CheckSchedule;
}

export const DEFAULT_SETTINGS: AppSettings = {
  planAccounts: 20,
  maxConcurrentBrowsers: 20,
  defaultIntervalSec: 5,
  accountCheck: { enabled: false, time: '09:00', groupId: null },
  searchBanCheck: { enabled: false, time: '09:30', groupId: null },
};

/** Single-row settings record stored in the `settings` table. */
export interface SettingsRow {
  key: 'app';
  settings: AppSettings;
}

/* ============================ M2: bulk post ============================ */

/** Spec limits from the XBoard research (docs/xboard-research.md §6). */
export const TEMPLATE_MAX = 2000;
export const TEMPLATE_GROUP_MAX = 100;
export const TEMPLATE_TITLE_MAX = 50;
export const MEDIA_SELECT_MAX = 200;
export const MEDIA_PER_POST_MAX = 20;
export const INTERVAL_MIN_SEC = 1;
export const INTERVAL_MAX_SEC = 60;
/** A reservation must be at least this far in the future (§6-5). */
export const RESERVATION_MIN_LEAD_MS = 5 * 60_000;

/**
 * Metadata for one attached media file.
 *
 * M2 limitation: media *blobs* are not persisted. The compose screen
 * keeps the picked File objects and their object URLs in memory for
 * the session only; what is stored (in templates, jobs, reservations)
 * is this metadata. A real Executor would receive the files from the
 * compose session at run time.
 */
export interface MediaMeta {
  name: string;
  kind: 'image' | 'video';
  /** MIME type as reported by the file picker (may be ''). */
  mime: string;
  size: number;
  /** Video duration in seconds, when the browser could read it. */
  durationSec?: number;
}

export interface PollData {
  /** 2–4 non-empty choices. A poll cannot be combined with media (X spec). */
  choices: string[];
}

/** Who may reply to a post (research §6-4). Normal posts only. */
export type ReplyPermission = 'everyone' | 'following' | 'verified' | 'mentioned';

export const REPLY_PERMISSIONS: ReplyPermission[] = [
  'everyone',
  'following',
  'verified',
  'mentioned',
];

export const REPLY_PERMISSION_LABELS: Record<ReplyPermission, string> = {
  everyone: '全員',
  following: 'フォローしているアカウント',
  verified: '認証済みアカウント',
  mentioned: 'メンションしたアカウントのみ',
};

export type ComposeTargetType = 'normal' | 'reply' | 'community';

/**
 * Everything needed to post once (per account). `segments[0]` is the
 * main post; segments[1..] are tree continuations, each posted as a
 * reply to the previous segment (§6-2).
 */
export interface ComposePayload {
  segments: string[];
  targetType: ComposeTargetType;
  /** Required when targetType is 'reply'. */
  replyToUrl?: string;
  /** Required when targetType is 'community'. */
  communityId?: string;
  media: MediaMeta[];
  /** 'all' attaches in order (capped at 20); 'random' picks N per post. */
  mediaMode: 'all' | 'random';
  mediaRandomCount?: number;
  poll: PollData | null;
  /** Applies to normal posts only; on tree posts, to segment 1 (§6-4). */
  replyPermission: ReplyPermission;
  paidPartnership: boolean;
}

/* ------------------------------ templates ------------------------------ */

/** Display grouping for templates (research §6-3). Max 100 groups. */
export interface TemplateGroup {
  id: string;
  name: string;
  order: number;
  createdAt: number;
}

export interface Template {
  id: string;
  /**
   * Stable management number, 1–2000 (§6-3). Numbers are never
   * renumbered on delete; a new template takes the smallest free one.
   */
  no: number;
  /** Management-only title, up to 50 chars; never posted. */
  title: string;
  body: string;
  groupId: string | null;
  /** Media metadata (max 200). Blobs are not persisted — see MediaMeta. */
  media: MediaMeta[];
  poll: PollData | null;
  /** Tree continuations (ツリーの続き) saved with the template (§6-2). */
  thread: string[];
  createdAt: number;
  updatedAt: number;
}

export type NewTemplate = Omit<Template, 'id' | 'no' | 'createdAt' | 'updatedAt'>;

/** One [RandomN] word list (research §6-3). Keyed by its number. */
export interface RandomWordSet {
  no: number;
  words: string[];
}

/* ------------------------------ post jobs ------------------------------ */

export type PostJobEntryStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export const POST_JOB_ENTRY_LABELS: Record<PostJobEntryStatus, string> = {
  pending: '待機中',
  running: '投稿中',
  done: '完了',
  failed: '失敗',
  skipped: 'スキップ',
};

export interface PostJobEntry {
  accountId: string;
  handle: string;
  status: PostJobEntryStatus;
  postId?: string;
  postUrl?: string;
  /** Post IDs of the tree continuations, in order (for grouped delete). */
  threadPostIds?: string[];
  error?: string;
  /** Set once the created post(s) have been deleted via the executor. */
  deletedAt?: number;
  at?: number;
}

export type PostJobStatus = 'running' | 'done' | 'partial' | 'cancelled';

export interface PostJob {
  id: string;
  kind: 'immediate' | 'reservation';
  reservationId?: string;
  status: PostJobStatus;
  payload: ComposePayload;
  intervalSec: number;
  /** One entry per target account, in execution order (top-to-bottom). */
  entries: PostJobEntry[];
  createdAt: number;
  startedAt: number;
  finishedAt?: number;
}

/* ----------------------------- reservations ---------------------------- */

export type ReservationStatus = 'pending' | 'fired' | 'cancelled';

export interface Reservation {
  id: string;
  status: ReservationStatus;
  /** Epoch ms of the scheduled post time (device-local interpretation). */
  scheduledAt: number;
  /** Target accounts in execution order. */
  accountIds: string[];
  payload: ComposePayload;
  intervalSec: number;
  createdAt: number;
  /** The post job created when this reservation fired. */
  jobId?: string;
}

/* ==================== M3: check runs & follower trend ==================== */

/** One account's outcome inside a check run (research §9-1 / §10). */
export interface CheckRunEntry {
  accountId: string;
  handle: string;
  /** Account-check outcome (status + counts + followers). */
  status?: AccountStatus;
  notifications?: number;
  dmCount?: number;
  followers?: number;
  /** Search-ban outcome: null = fetch failed (⚠). */
  topicVisible?: boolean | null;
  latestVisible?: boolean | null;
  checkedByAccountId?: string;
  checkedByHandle?: string;
  error?: string;
}

export type CheckRunKind = 'account' | 'search_ban';

export interface CheckRun {
  id: string;
  kind: CheckRunKind;
  status: 'running' | 'done';
  /** True when fired by the periodic engine (M3), false when manual. */
  scheduled: boolean;
  startedAt: number;
  finishedAt?: number;
  entries: CheckRunEntry[];
}

/**
 * One day's follower count for one account (research §12-3).
 * Recorded by account checks; at most one row per account per day
 * (later checks the same day overwrite), kept 400 days max.
 */
export interface FollowerSnapshot {
  /** `${accountId}:${date}` */
  id: string;
  accountId: string;
  /** Local date, "YYYY-MM-DD". */
  date: string;
  followers: number;
  at: number;
}

/* ================= M4: bulk actions, analytics, automation ============= */

/** Bulk-action kinds (research §7-1 / §8). Executor mirrors this union. */
export type BulkActionKind = 'like' | 'repost' | 'bookmark' | 'follow';

export const BULK_ACTION_LABELS: Record<BulkActionKind, string> = {
  like: 'いいね',
  repost: 'リポスト',
  bookmark: 'ブックマーク',
  follow: 'フォロー',
};

export type ActionJobEntryStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface ActionJobEntry {
  accountId: string;
  handle: string;
  /** Post URL (like / repost / bookmark) or @handle (follow). */
  target: string;
  status: ActionJobEntryStatus;
  error?: string;
  at?: number;
}

export type ActionJobStatus = 'running' | 'done' | 'partial' | 'cancelled';

export interface ActionJob {
  id: string;
  kind: BulkActionKind;
  /** Targets in execution order. */
  targets: string[];
  /** Research §7-1: process one target across all accounts, then the next. */
  queueOneByOne: boolean;
  status: ActionJobStatus;
  entries: ActionJobEntry[];
  /** Automation rule that created this job, if any. */
  ruleId?: string;
  createdAt: number;
  startedAt: number;
  finishedAt?: number;
}

/**
 * One metrics snapshot for a tracked post (research §12-2).
 * The simulator derives plausible values from the post ID and age,
 * so every tracked post has a full 30m–48h curve without a live X
 * connection; a real executor would fill these from public counts.
 */
export interface PostMetric {
  /** `${postId}:${at}` */
  id: string;
  postId: string;
  accountId: string;
  handle: string;
  postUrl: string;
  text: string;
  postedAt: number;
  at: number;
  likes: number;
  reposts: number;
  bookmarks: number;
  views: number;
}

/** Automation rules (research §6-6 auto-post, §7-2 auto-action). */
export type AutomationKind = 'auto_post' | 'auto_action';
export type AutoPostMode = 'window' | 'times' | 'weekly';

export interface AutomationRule {
  id: string;
  kind: AutomationKind;
  name: string;
  enabled: boolean;
  /** Accounts the rule runs as (auto-post) or reacts with (auto-action). */
  accountIds: string[];
  /** Auto-post: template to post. Auto-action reply: template for replies. */
  templateId?: string;
  /** Auto-post schedule mode. */
  mode?: AutoPostMode;
  /** 'window' mode: local "HH:MM" bounds for the day's posts. */
  windowStart?: string;
  windowEnd?: string;
  /** 'window' mode: posts per day inside the window. */
  postsPerDay?: number;
  /** 'times' / 'weekly' mode: local "HH:MM" times (max 48). */
  times?: string[];
  /** 'times' mode jitter: 0 | 5 | 15 | 30 minutes. */
  jitterMin?: number;
  /** 'weekly' mode: 0 = Sunday … 6 = Saturday. */
  weekdays?: number[];
  /** 'window' mode: 'shuffle' = shuffled round-robin, else sequential. */
  order?: 'shuffle' | 'sequential';
  /** Skip accounts with a search-ban verdict in the last 24h (§6-6). */
  skipSearchBanned?: boolean;
  /** Auto-action: which reactions to run. */
  actionKinds?: BulkActionKind[];
  /** Auto-action: only react to posts containing this phrase. */
  keyword?: string;
  /** Auto-action: shared daily cap across all rules (§7-2). */
  dailyCap?: number;
  createdAt: number;
  updatedAt: number;
}

/* ======================== M4: notification / DM ======================== */

/**
 * One aggregated notification / DM item (research §11).
 * Counts come from account checks (§10); the items themselves are
 * the simulator's stand-in for the feed a real executor would fetch.
 * Marking read only affects this device's inbox view.
 */
export interface InboxItem {
  id: string;
  accountId: string;
  handle: string;
  kind: 'notification' | 'dm';
  title: string;
  body: string;
  at: number;
  read: boolean;
}
