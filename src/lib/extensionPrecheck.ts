import { checkExtensionConnection, type ExtensionTransport } from '../executor';
import { EXTENSION_COOKIES_UNAVAILABLE_MESSAGE } from './errorMessage';

/**
 * 拡張モードでジョブを送る前の疎通確認。ハンドシェイク＋連携一覧で
 * 拡張の応答を確かめ、さらに Cookie API の可否を見る。
 * ダメなら理由付きで止めるので、ジョブを送って生の TypeError が
 * 画面に出る前に防げる（実連携の確認が無理でも、せめて疎通確認を、
 * という要望に応えるためのもの）。
 *
 * 診断が無い古い拡張（cookiesApiOk が null）は「不明」として通す。
 */
export async function checkExtensionReady(
  transport?: ExtensionTransport,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const conn = await checkExtensionConnection(transport);
  if (!conn.connected) {
    return { ok: false, message: conn.error ?? '拡張に接続できませんでした' };
  }
  if (conn.cookiesApiOk === false) {
    return { ok: false, message: EXTENSION_COOKIES_UNAVAILABLE_MESSAGE };
  }
  return { ok: true };
}
