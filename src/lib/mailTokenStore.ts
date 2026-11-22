/**
 * メール受信チェックの OAuth2 トークン保存方法 — タスク3-4（決定）。
 *
 * 決定：タスク8（auth_token の安全な取り込み）と同じく、拡張の
 * `chrome.storage.local` にだけ置く。アプリ側の IndexedDB（Dexie）
 * やファイルには置かない。ブラウザでは OS の資格情報ストアを
 * 使えないため採用しない。
 *
 * 保管するもの：プロバイダごとの OAuth2 トークン 1 件ずつ。
 * スコープは読み取り専用の最小権限だけ（Gmail: gmail.readonly、
 * Outlook: Mail.ReadBasic）。送信・既読化の権限は取らない。
 * トークン値はログやエラーメッセージに出さない。診断には
 * `describeMailToken` の要約（期限とスコープだけ）を使う。
 */
import { GMAIL_READONLY_SCOPE } from './gmailApi';
import { OUTLOOK_READ_SCOPE } from './outlookApi';

export type MailProvider = 'gmail' | 'outlook';

/** 拡張の chrome.storage.local に置くキー（タスク8の保管庫と同じ型）。 */
export const MAIL_TOKENS_STORAGE_KEY = 'xmanager.mailTokens.v1';

export function mailTokenStorageKey(): string {
  return MAIL_TOKENS_STORAGE_KEY;
}

export interface MailTokenRecord {
  accessToken: string;
  refreshToken?: string;
  /** アクセストークンの有効期限（UNIX ミリ秒）。 */
  expiresAtMs: number;
  scope: string;
}

/** プロバイダごとに許すスコープは 1 つだけ（取り違え防止）。 */
export function expectedMailScope(provider: MailProvider): string {
  return provider === 'gmail' ? GMAIL_READONLY_SCOPE : OUTLOOK_READ_SCOPE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 保存してよいレコードかどうか。形・トークン・期限・スコープを全部見る。 */
export function isValidMailTokenRecord(
  provider: MailProvider,
  data: unknown,
): data is MailTokenRecord {
  if (!isRecord(data)) return false;
  if (typeof data.accessToken !== 'string' || !data.accessToken.trim()) {
    return false;
  }
  if (
    data.refreshToken !== undefined &&
    typeof data.refreshToken !== 'string'
  ) {
    return false;
  }
  if (
    typeof data.expiresAtMs !== 'number' ||
    !Number.isFinite(data.expiresAtMs) ||
    data.expiresAtMs <= 0
  ) {
    return false;
  }
  return data.scope === expectedMailScope(provider);
}

/**
 * トークンが期限切れかどうか。既定で 60 秒の余裕を見る
 * （期限ぎりぎりのトークンで API を呼ばないため）。
 */
export function isMailTokenExpired(
  record: MailTokenRecord,
  nowMs: number = Date.now(),
  skewMs: number = 60_000,
): boolean {
  return nowMs + skewMs >= record.expiresAtMs;
}

/** 診断・ログ用の安全な要約。トークン値は含まない。 */
export function describeMailToken(
  provider: MailProvider,
  record: MailTokenRecord,
): {
  provider: MailProvider;
  scope: string;
  expiresAtMs: number;
  hasRefreshToken: boolean;
} {
  return {
    provider,
    scope: record.scope,
    expiresAtMs: record.expiresAtMs,
    hasRefreshToken: !!record.refreshToken,
  };
}
