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
