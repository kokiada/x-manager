/**
 * D-02: Electron 最小ホスト — partition 名。
 *
 * デスクトップ方式ではアカウントごとに session.fromPartition で
 * セッションを分離する（DESKTOP_DESIGN.md §3）。partition 名は
 * `persist:xmgr-<accountId>` で統一する。
 */
'use strict';

const MAX_ACCOUNT_ID_LENGTH = 64;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/** アカウントIDから persist partition 名を作る。不正なIDは例外。 */
function partitionName(accountId) {
  if (
    typeof accountId !== 'string' ||
    accountId.length === 0 ||
    accountId.length > MAX_ACCOUNT_ID_LENGTH ||
    !ACCOUNT_ID_PATTERN.test(accountId)
  ) {
    throw new Error('アカウントIDが不正です。英数字・-・_のみ、1〜64文字で指定してください。');
  }
  return `persist:xmgr-${accountId}`;
}

module.exports = { partitionName, MAX_ACCOUNT_ID_LENGTH };
