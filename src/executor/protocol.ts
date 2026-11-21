/**
 * x-manager ⇔ Chrome 拡張の通信プロトコル — 唯一の定義。
 *
 * 拡張側の `extension/src/protocol.js` はこのファイルのミラー
 * （定数とワイヤ形式が一致することは `protocol.test.ts` が検証する）。
 * 拡張は素の JS で、ビルド不要のまま読み込めるようにしてある。
 *
 * メッセージの流れ：
 *   Webアプリ (page) → window.postMessage → content script
 *     → chrome.runtime.sendMessage → background (service worker)
 *   応答は逆方向に同じ経路で返す。相関は `id` で取る。
 *
 * セキュリティ：この経路を流れるのはジョブの指示と結果だけ。
 * auth_token はこの経路では送らない（拡張のポップアップで登録し、
 * chrome.storage.local に置く。詳しくは docs/REAL_X_DESIGN.md）。
 */

export const PROTOCOL_VERSION = 1;
export const EXTENSION_VERSION = '0.1.0';

/** window.postMessage の送信元識別子（アプリ側）。 */
export const PAGE_SOURCE = 'x-manager';
/** window.postMessage の送信元識別子（拡張側）。 */
export const EXTENSION_SOURCE = 'x-manager-extension';

/** ジョブ1件の既定タイムアウト（実X操作は数秒〜十数秒かかる）。 */
export const JOB_TIMEOUT_MS = 30_000;
/** ハンドシェイク（拡張の有無確認）のタイムアウト。 */
export const HELLO_TIMEOUT_MS = 3_000;

/** Executor のメソッドと1対1で対応するジョブ種別。 */
export type ExtensionMethod =
  | 'executePost'
  | 'deletePost'
  | 'executeAction'
  | 'checkAccount'
  | 'checkSearchBan'
  | 'fetchPostAnalytics'
  | 'fetchNotifications';

/** アプリ → 拡張：1件の実行ジョブ。 */
export interface ExtensionJob {
  /** 相関ID。応答の `id` と一致する。 */
  id: string;
  method: ExtensionMethod;
  /** 実行対象アカウントのID（拡張はこのIDでセッションを引く）。 */
  accountId: string;
  accountHandle: string;
  /** メソッド固有の引数（JSON化できる値のみ）。 */
  payload: Record<string, unknown>;
}

/** ジョブ失敗の分類。`not_implemented` は「拡張が応答したが、その操作はまだ実装されていない」ことを表す（次の段階で消えていく）。 */
export type ExtensionResultCode =
  | 'not_implemented'
  | 'no_session'
  | 'rate_limited'
  | 'x_error'
  | 'unknown';

/** 拡張 → アプリ：ジョブの結果。 */
export interface ExtensionJobResult {
  id: string;
  ok: boolean;
  /** 成功時のメソッド固有データ（Executor の結果型に写す前の形）。 */
  data?: Record<string, unknown>;
  /** 失敗時の理由（日本語で表示できる文言）。 */
  error?: string;
  /** 失敗の分類。 */
  code?: ExtensionResultCode;
  /** 拡張側で結果を作った時刻（epoch ms）。 */
  at: number;
}

/** アプリ → 拡張：ハンドシェイク。 */
export interface HelloMessage {
  source: typeof PAGE_SOURCE;
  kind: 'hello';
  version: number;
}

/** 拡張 → アプリ：ハンドシェイク応答。 */
export interface HelloAckMessage {
  source: typeof EXTENSION_SOURCE;
  kind: 'hello-ack';
  version: number;
  extensionVersion: string;
}

/** 拡張に連携済みの1アカウント（セッション）。 */
export interface ExtensionSession {
  /** アプリ側のアカウントID（拡張のセッションキー）。 */
  accountId: string;
  /** Xハンドル（@なし）。ポップアップで未入力なら null。 */
  handle: string | null;
}

/** アプリ → 拡張：連携済みアカウントIDの一覧要求。 */
export interface ListSessionsMessage {
  source: typeof PAGE_SOURCE;
  kind: 'list-sessions';
}

/** 拡張 → アプリ：連携済みアカウントの一覧。 */
export interface SessionsMessage {
  source: typeof EXTENSION_SOURCE;
  kind: 'sessions';
  /**
   * 連携済みセッション（ID＋ハンドル）。旧版の拡張はこれが無く
   * `accountIds` だけを返すので、受け取り側は両方に対応する
   * （normalizeSessionsMessage 参照）。
   */
  sessions?: ExtensionSession[];
  /** 旧形式：連携済みアカウントIDの一覧（後方互換のため残す）。 */
  accountIds?: string[];
}

/** アプリ → 拡張：window 経由で送るメッセージ。 */
export type PageMessage =
  | (HelloMessage & { kind: 'hello' })
  | ({ source: typeof PAGE_SOURCE; kind: 'job' } & ExtensionJob)
  | ListSessionsMessage;

/** 拡張 → アプリ：window 経由で返すメッセージ。 */
export type ExtensionMessage =
  | HelloAckMessage
  | ({ source: typeof EXTENSION_SOURCE; kind: 'result' } & ExtensionJobResult)
  | SessionsMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 拡張からのメッセージかどうか（送信元と形だけ見る）。 */
export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isRecord(value) || value.source !== EXTENSION_SOURCE) return false;
  return value.kind === 'hello-ack' || value.kind === 'result' || value.kind === 'sessions';
}

export function isHelloAck(value: unknown): value is HelloAckMessage {
  return (
    isRecord(value) &&
    value.source === EXTENSION_SOURCE &&
    value.kind === 'hello-ack' &&
    typeof value.version === 'number' &&
    typeof value.extensionVersion === 'string'
  );
}

export function isJobResult(value: unknown): value is ExtensionJobResult & {
  source: typeof EXTENSION_SOURCE;
  kind: 'result';
} {
  return (
    isRecord(value) &&
    value.source === EXTENSION_SOURCE &&
    value.kind === 'result' &&
    typeof value.id === 'string' &&
    typeof value.ok === 'boolean' &&
    typeof value.at === 'number' &&
    (value.data === undefined || isRecord(value.data)) &&
    (value.error === undefined || typeof value.error === 'string') &&
    (value.code === undefined || typeof value.code === 'string')
  );
}

/**
 * sessions 項目の形だけを見る。IDが空のものもここでは通す
 * （normalizeSessionsMessage が落とす）。1件の壊れた項目で
 * 一覧全体を弾かないための緩い判定。
 */
function isExtensionSessionShape(value: unknown): value is ExtensionSession {
  return (
    isRecord(value) &&
    typeof value.accountId === 'string' &&
    (value.handle === null || value.handle === undefined || typeof value.handle === 'string')
  );
}

/**
 * sessions メッセージかどうか。新形式（`sessions`：ID＋ハンドル）と
 * 旧形式（`accountIds`：IDだけ）の両方を受け付ける。
 */
export function isSessionsMessage(value: unknown): value is SessionsMessage {
  if (!isRecord(value) || value.source !== EXTENSION_SOURCE || value.kind !== 'sessions') {
    return false;
  }
  if (value.sessions !== undefined) {
    return Array.isArray(value.sessions) && value.sessions.every(isExtensionSessionShape);
  }
  return (
    Array.isArray(value.accountIds) && value.accountIds.every((id) => typeof id === 'string')
  );
}

/**
 * sessions メッセージを `ExtensionSession[]` に正規化する。
 * 新形式はそのまま（ハンドルは空文字・未入力を null に揃える）。
 * 旧形式（`accountIds` だけ）はハンドル null として変換する。
 * 壊れた項目（IDが空など）は落とす。同一IDの重複は最初のものを残す。
 */
export function normalizeSessionsMessage(value: unknown): ExtensionSession[] {
  if (!isSessionsMessage(value)) return [];
  const sessions: ExtensionSession[] = [];
  if (value.sessions !== undefined) {
    for (const s of value.sessions) {
      if (s.accountId.length === 0) continue;
      const handle =
        typeof s.handle === 'string' && s.handle.trim().length > 0
          ? s.handle.replace(/^@/, '').trim()
          : null;
      sessions.push({ accountId: s.accountId, handle });
    }
  } else if (value.accountIds !== undefined) {
    for (const id of value.accountIds) {
      if (typeof id === 'string' && id.length > 0) sessions.push({ accountId: id, handle: null });
    }
  }
  const seen = new Set<string>();
  return sessions.filter((s) => {
    if (seen.has(s.accountId)) return false;
    seen.add(s.accountId);
    return true;
  });
}
