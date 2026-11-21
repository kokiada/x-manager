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
/** ポップアップ → background の送信元識別子（取り込み要求など）。 */
export const POPUP_SOURCE = 'x-manager-popup';

/** ジョブ1件の既定タイムアウト（実X操作は数秒〜十数秒かかる）。 */
export const JOB_TIMEOUT_MS = 30_000;
/** メディア付きジョブのタイムアウト（アップロード分を見込む）。 */
export const MEDIA_JOB_TIMEOUT_MS = 120_000;
/** ハンドシェイク（拡張の有無確認）のタイムアウト。 */
export const HELLO_TIMEOUT_MS = 3_000;

/**
 * メディア転送（アプリ → 拡張）の1チャンクの base64 文字数。
 * chrome.runtime.sendMessage は大きなメッセージに弱いため、
 * メディア本体はこのサイズに切って `media-chunk` で送る。
 */
export const MEDIA_CHUNK_SIZE = 256 * 1024;
/**
 * 転送路（チャンク分割した runtime メッセージ）の実用上の上限。
 * 1件 32MB・1ポスト合計 64MBを超えるメディアは、拡張に送る前に
 * アプリ側で弾く（base64 化して何千通も送るのは現実的でない）。
 * X自体の上限（画像5MB・GIF15MB・動画512MB）とは別枠。
 */
export const MEDIA_MAX_ITEM_BYTES = 32 * 1024 * 1024;
export const MEDIA_MAX_POST_BYTES = 64 * 1024 * 1024;

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
  /**
   * このジョブだけのタイムアウト（ms）。未指定なら JOB_TIMEOUT_MS。
   * メディア付き投稿はアップロード分の 120 秒を使う。
   */
  timeoutMs?: number;
}

/** アプリ → 拡張：メディア本体の1チャンク。 */
export interface MediaChunkMessage {
  source: typeof PAGE_SOURCE;
  kind: 'media-chunk';
  /** 転送セッションID（ジョブの media 参照と一致させる）。 */
  uploadId: string;
  /** 0始まりのチャンク番号。 */
  index: number;
  /** 全チャンク数。 */
  totalChunks: number;
  /** このチャンクの base64（接頭辞なし）。 */
  data: string;
}

/** 拡張 → アプリ：メディアチャンクの受領応答。 */
export interface MediaChunkAckMessage {
  source: typeof EXTENSION_SOURCE;
  kind: 'media-chunk-ack';
  uploadId: string;
  index: number;
  /** 受領できなかった場合の理由（日本語）。 */
  error?: string;
}

/** ジョブ失敗の分類。`not_implemented` は「拡張が応答したが、その操作はまだ実装されていない」ことを表す（次の段階で消えていく）。`extension_broken` は拡張自体が壊れた状態（Cookie API が使えない等）で、再読み込みが必要。 */
export type ExtensionResultCode =
  | 'not_implemented'
  | 'no_session'
  | 'rate_limited'
  | 'x_error'
  | 'extension_broken'
  | 'unknown';

/** 拡張の自己診断（ハンドシェイク応答に付く）。 */
export interface ExtensionDiagnostics {
  /** `chrome.cookies`（set/get）が使えるかどうか。 */
  cookiesApi: boolean;
}

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
  /**
   * 拡張の自己診断。古い拡張はこれを付けないので、受け取り側は
   * 無い場合を「不明」として扱う（helloAckDiagnostics 参照）。
   */
  diagnostics?: ExtensionDiagnostics;
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

/**
 * ポップアップ → background：今ログイン中の X アカウントを取り込む。
 * 拡張が自分の Cookie 権限で auth_token を読み、本人確認をしてから
 * セッション保管庫へ入れる。トークンの値はこのメッセージにも
 * 応答にも出ない（応答はアカウントIDとハンドルだけ）。
 */
export interface ImportCurrentAccountMessage {
  source: typeof POPUP_SOURCE;
  kind: 'import-current-account';
}

/** background → ポップアップ：取り込みの結果。 */
export interface ImportCurrentAccountResult {
  /** 成功したかどうか。 */
  ok: boolean;
  /** 成功時：取り込んだアカウントのID（Xの数値ユーザーID）。 */
  accountId?: string;
  /** 成功時：取り込んだアカウントのハンドル（@なし）。 */
  handle?: string;
  /** 失敗時の理由（日本語で表示できる文言）。 */
  error?: string;
  /** 失敗の分類。 */
  code?: ExtensionResultCode;
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
  | ListSessionsMessage
  | MediaChunkMessage;

/** 拡張 → アプリ：window 経由で返すメッセージ。 */
export type ExtensionMessage =
  | HelloAckMessage
  | ({ source: typeof EXTENSION_SOURCE; kind: 'result' } & ExtensionJobResult)
  | SessionsMessage
  | MediaChunkAckMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 拡張からのメッセージかどうか（送信元と形だけ見る）。 */
export function isExtensionMessage(value: unknown): value is ExtensionMessage {
  if (!isRecord(value) || value.source !== EXTENSION_SOURCE) return false;
  return (
    value.kind === 'hello-ack' ||
    value.kind === 'result' ||
    value.kind === 'sessions' ||
    value.kind === 'media-chunk-ack'
  );
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

/**
 * hello-ack から自己診断を取り出す。診断が無い（古い拡張）・形が
 * 壊れている場合は null を返す。呼び出し側は null を「不明」として
 * 扱い、疎通自体は通ったものとして進める。
 */
export function helloAckDiagnostics(value: unknown): ExtensionDiagnostics | null {
  if (!isRecord(value)) return null;
  const d = value.diagnostics;
  if (!isRecord(d) || typeof d.cookiesApi !== 'boolean') return null;
  return { cookiesApi: d.cookiesApi };
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
 * メディアチャンクの形かどうか。base64 の中身までは見ない
 * （拡張側が受け取り時に長さ・番号を検査する）。
 */
export function isMediaChunkMessage(value: unknown): value is MediaChunkMessage {
  return (
    isRecord(value) &&
    value.source === PAGE_SOURCE &&
    value.kind === 'media-chunk' &&
    typeof value.uploadId === 'string' &&
    value.uploadId.length > 0 &&
    typeof value.index === 'number' &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    typeof value.totalChunks === 'number' &&
    Number.isInteger(value.totalChunks) &&
    value.totalChunks >= 1 &&
    value.index < value.totalChunks &&
    typeof value.data === 'string'
  );
}

export function isMediaChunkAck(value: unknown): value is MediaChunkAckMessage {
  return (
    isRecord(value) &&
    value.source === EXTENSION_SOURCE &&
    value.kind === 'media-chunk-ack' &&
    typeof value.uploadId === 'string' &&
    typeof value.index === 'number'
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
