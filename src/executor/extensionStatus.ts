import { WindowPostMessageTransport, type ExtensionTransport } from './transport';

/** 拡張の接続状態（設定画面の表示用）。 */
export interface ExtensionConnection {
  /** 拡張が応答したかどうか。 */
  connected: boolean;
  /** プロトコル版（接続時のみ）。 */
  version?: number;
  /** 拡張自体の版（接続時のみ）。 */
  extensionVersion?: string;
  /** 拡張にセッション登録済みのアカウントID（接続時のみ）。 */
  linkedAccountIds?: string[];
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
    const linkedAccountIds = await transport.listSessions();
    return {
      connected: true,
      version: handshake.version,
      extensionVersion: handshake.extensionVersion,
      linkedAccountIds,
    };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : '拡張に接続できませんでした',
    };
  }
}
