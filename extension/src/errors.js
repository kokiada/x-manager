/**
 * ジョブ失敗の分類付きエラー。
 *
 * 拡張の各モジュールは失敗時に `code` 付きの Error を投げる。
 * code はプロトコル（src/executor/protocol.ts）の分類と一致させる。
 * トークンなどの秘密値はここに絶対に入れない。
 */
'use strict';

/* global self */

const XManagerErrors = {
  /**
   * 分類付きエラーを作る。
   * @param {'not_implemented'|'no_session'|'rate_limited'|'x_error'|'extension_broken'|'unknown'} code
   * @param {string} message 日本語で表示できる文言
   */
  makeError(code, message) {
    const err = new Error(message);
    err.code = code;
    return err;
  },

  /** エラーから分類を取り出す。付いていなければ 'unknown'。 */
  codeOf(err) {
    if (err && typeof err.code === 'string') return err.code;
    return 'unknown';
  },
};

if (typeof self !== 'undefined') {
  self.XManagerErrors = XManagerErrors;
}
