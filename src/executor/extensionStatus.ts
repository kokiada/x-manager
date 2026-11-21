import { WindowPostMessageTransport, type ExtensionTransport } from './transport';
import type { ExtensionSession } from './protocol';

/** 拡張の接続状態（設定画面の表示用）。 */
export interface ExtensionConnection {
  /** 拡張が応答したかどうか。 */
  connected: boolean;
  /** プロトコル版（接続時のみ）。 */
  version?: number;
  /** 拡張自体の版（接続時のみ）。 */
  extensionVersion?: string;
  /** 拡張にセッション登録済みのアカウント（ID＋ハンドル、接続時のみ）。 */
  linkedSessions?: ExtensionSession[];
  /** 拡張にセッション登録済みのアカウントID（接続時のみ）。 */
  linkedAccountIds?: string[];
  /**
   * 拡張の Cookie API が使えるか（接続時のみ）。true/false。
   * 古い拡張（診断を返さない）は null＝不明として扱う。
   */
  cookiesApiOk?: boolean | null;
  /** 未接続時の理由（日本語）。 */
  error?: string;
}

/**
 * 拡張にハンドシェイクして接続状態を調べる。未接続でも例外は投げず、
 * `connected: false` を返す（設定画面で表示するため）。
 */
export async function checkExtensionConnection(
  transport: ExtensionTransport = new WindowPostMessageTransport(),
): Promise<ExtensionConnection> {
  try {
    const handshake = await transport.ping();
    const linkedSessions = await transport.listSessions();
    return {
      connected: true,
      version: handshake.version,
      extensionVersion: handshake.extensionVersion,
      linkedSessions,
      linkedAccountIds: linkedSessions.map((s) => s.accountId),
      cookiesApiOk: handshake.diagnostics ? handshake.diagnostics.cookiesApi : null,
    };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : '拡張に接続できませんでした',
    };
  }
}
