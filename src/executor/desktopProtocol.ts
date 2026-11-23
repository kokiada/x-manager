/**
 * x-manager ⇔ デスクトップホスト（Electron）の通信プロトコル。
 *
 * 拡張プロトコル（`protocol.ts`）と同形。違いは輸送路だけ：
 * 拡張は window.postMessage、デスクトップは Electron の IPC
 * （preload の contextBridge → ipcRenderer.invoke）。
 * ジョブ／結果／セッションの型は protocol.ts のものをそのまま
 * 再利用し、送信元識別子だけデスクトップ用に変える。
 *
 * セキュリティ：この経路を流れるのはジョブの指示と結果だけ。
 * auth_token はこの経路では送らない（ホストの partition 内に
 * のみ置く。詳しくは docs/DESKTOP_BRIDGE.md）。
 */
import {
  PAGE_SOURCE,
  PROTOCOL_VERSION,
  type ExtensionJob,
  type ExtensionJobResult,
  type ExtensionResultCode,
  type ExtensionSession,
  type HelloMessage,
} from './protocol';

export { PROTOCOL_VERSION };
export type { ExtensionJob, ExtensionJobResult, ExtensionResultCode, ExtensionSession };

/** IPC の送信元識別子（デスクトップホスト側）。 */
export const DESKTOP_HOST_SOURCE = 'x-manager-desktop-host';
/** デスクトップホスト自体の版（hello-ack に付く）。 */
export const DESKTOP_HOST_VERSION = '0.1.0';

/** アプリ → ホスト：ハンドシェイク（拡張の HelloMessage と同形）。 */
export type DesktopHelloMessage = HelloMessage;

/** ホスト → アプリ：ハンドシェイク応答。 */
export interface DesktopHelloAckMessage {
  source: typeof DESKTOP_HOST_SOURCE;
  kind: 'hello-ack';
  version: number;
  hostVersion: string;
}

/** ホスト → アプリ：ジョブの結果。 */
export type DesktopJobResultMessage = {
  source: typeof DESKTOP_HOST_SOURCE;
  kind: 'result';
} & ExtensionJobResult;

/** ホスト → アプリ：連携済みアカウントの一覧。 */
export interface DesktopSessionsMessage {
  source: typeof DESKTOP_HOST_SOURCE;
  kind: 'sessions';
  /**
   * 連携済みセッション（ID＋ハンドル）。旧形式の `accountIds`
   * だけを返すホストにも対応する（normalizeDesktopSessions 参照）。
   */
  sessions?: ExtensionSession[];
  /** 旧形式：連携済みアカウントIDの一覧（後方互換のため残す）。 */
  accountIds?: string[];
}

/** アプリ → ホスト：IPC 経由で送るメッセージ。 */
export type DesktopPageMessage =
  | DesktopHelloMessage
  | ({ source: typeof PAGE_SOURCE; kind: 'job' } & ExtensionJob)
  | { source: typeof PAGE_SOURCE; kind: 'list-sessions' };

/** ホスト → アプリ：IPC 経由で返すメッセージ。 */
export type DesktopHostMessage =
  | DesktopHelloAckMessage
  | DesktopJobResultMessage
  | DesktopSessionsMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** デスクトップホストからのメッセージかどうか（送信元と形だけ見る）。 */
export function isDesktopMessage(value: unknown): value is DesktopHostMessage {
  if (!isRecord(value) || value.source !== DESKTOP_HOST_SOURCE) return false;
  return value.kind === 'hello-ack' || value.kind === 'result' || value.kind === 'sessions';
}

export function isDesktopHelloAck(value: unknown): value is DesktopHelloAckMessage {
  return (
    isRecord(value) &&
    value.source === DESKTOP_HOST_SOURCE &&
    value.kind === 'hello-ack' &&
    typeof value.version === 'number' &&
    typeof value.hostVersion === 'string'
  );
}

export function isDesktopJobResult(value: unknown): value is DesktopJobResultMessage {
  return (
    isRecord(value) &&
    value.source === DESKTOP_HOST_SOURCE &&
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
 * （normalizeDesktopSessions が落とす）。1件の壊れた項目で
 * 一覧全体を弾かないための緩い判定。
 */
function isDesktopSessionShape(value: unknown): value is ExtensionSession {
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
export function isDesktopSessionsMessage(value: unknown): value is DesktopSessionsMessage {
  if (!isRecord(value) || value.source !== DESKTOP_HOST_SOURCE || value.kind !== 'sessions') {
    return false;
  }
  if (value.sessions !== undefined) {
    return Array.isArray(value.sessions) && value.sessions.every(isDesktopSessionShape);
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
export function normalizeDesktopSessions(value: unknown): ExtensionSession[] {
  if (!isDesktopSessionsMessage(value)) return [];
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
