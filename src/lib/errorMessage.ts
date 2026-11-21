/**
 * 失敗理由の文言を取り出す。トークンなどの秘密値はここを通らない
 * （呼び出し元がエラーメッセージに入れない設計になっている）。
 *
 * Executor（特に拡張経由）のエラーは `Error.message` に日本語の
 * 理由が入っているので、それをそのまま画面に出す。Error でない
 * 値や空のメッセージのときだけフォールバックを使う。
 */
export function errorMessageOf(err: unknown, fallback: string): string {
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
