/**
 * 失敗理由の文言を取り出す。トークンなどの秘密値はここを通らない
 * （呼び出し元がエラーメッセージに入れない設計になっている）。
 *
 * Executor（特に拡張経由）のエラーは `Error.message` に日本語の
 * 理由が入っているので、それをそのまま画面に出す。Error でない
 * 値や空のメッセージのときだけフォールバックを使う。
 */
/**
 * 拡張の Cookie 機能が使えないときに表示する文言。拡張側の
 * session.js が投げる `extension_broken` と同じ意味・同じ対処で、
 * こちらはアプリ側のフォールバック（生の TypeError を包む）にも使う。
 */
export const EXTENSION_COOKIES_UNAVAILABLE_MESSAGE =
  '拡張のCookie機能が使えません。拡張を再読み込みしてください（chrome://extensions で「更新」→アプリを再起動）。それでも直らなければ、拡張の権限が無効になっている可能性があります。';

/**
 * 拡張の Cookie API が無いときに V8 が出す生の TypeError
 * （`Cannot read properties of undefined (reading 'set')` など）。
 * 拡張側のガードが間に合わなかった場合の安全網として、この形の
 * メッセージは Cookie 機能の説明に置き換える。
 */
const RAW_COOKIE_TYPE_ERROR = /Cannot read propert(?:y|ies) of undefined \(reading '(?:set|get)'\)/;

export function errorMessageOf(err: unknown, fallback: string): string {
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (raw.trim() && RAW_COOKIE_TYPE_ERROR.test(raw)) {
    return EXTENSION_COOKIES_UNAVAILABLE_MESSAGE;
  }
  if (err instanceof Error && err.message.trim()) return err.message;
  if (typeof err === 'string' && err.trim()) return err;
  return fallback;
}

/**
 * Xのセッション切れ（401/403）のときに表示する文言。
 * 拡張の xClient が返す文言と同じ意味で、アプリ側はチェック結果が
 * 「ログアウト状態」として返ってきたときにこれを表示する。
 */
export const SESSION_EXPIRED_MESSAGE =
  'Xのセッションが切れています。拡張で auth_token を登録し直してください。';
