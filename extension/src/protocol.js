/**
 * x-manager ⇔ Chrome 拡張の通信プロトコル — ミラー。
 *
 * 正本は `src/executor/protocol.ts`。このファイルは素の JS で、
 * content script / background / popup から importScripts や
 * <script> で読めるようにした写し。定数・ワイヤ形式が正本と
 * 一致することは `src/executor/protocol.test.ts` が検証する。
 * ここを変えたら必ず正本も同じにすること。
 */
'use strict';

/* global self */

const XManagerProtocol = {
  VERSION: 1,
  EXTENSION_VERSION: '0.1.0',
  PAGE_SOURCE: 'x-manager',
  EXTENSION_SOURCE: 'x-manager-extension',
  /** ポップアップ → background の送信元識別子（取り込み要求など）。 */
  POPUP_SOURCE: 'x-manager-popup',
  JOB_TIMEOUT_MS: 30000,
  /** メディア付きジョブのタイムアウト（アップロード分を見込む）。 */
  MEDIA_JOB_TIMEOUT_MS: 120000,
  HELLO_TIMEOUT_MS: 3000,
  /** メディア転送の1チャンクの base64 文字数（正本と一致させる）。 */
  MEDIA_CHUNK_SIZE: 262144,
  METHODS: [
    'executePost',
    'deletePost',
    'executeAction',
    'checkAccount',
    'resolveAccountIdentity',
    'checkSearchBan',
    'fetchPostAnalytics',
    'fetchNotifications',
  ],
};

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** アプリからのメッセージかどうか。 */
function isPageMessage(value) {
  return (
    isRecord(value) &&
    value.source === XManagerProtocol.PAGE_SOURCE &&
    (value.kind === 'hello' ||
      value.kind === 'job' ||
      value.kind === 'list-sessions' ||
      value.kind === 'media-chunk')
  );
}

/** ジョブの形が正しいかどうか（最低限の検査）。 */
function isJobMessage(value) {
  return (
    isRecord(value) &&
    value.source === XManagerProtocol.PAGE_SOURCE &&
    value.kind === 'job' &&
    typeof value.id === 'string' &&
    XManagerProtocol.METHODS.includes(value.method) &&
    typeof value.accountId === 'string' &&
    isRecord(value.payload)
  );
}

/**
 * 連携一覧を `{accountId, handle}` の配列に正規化する。
 * 正本の `normalizeSessionsMessage` と同じ規則：旧形式の ID だけの
 * 配列はハンドル null に変換し、ID の空文字・重複は落とす。
 * background が `list-sessions` の応答を作るときに使う。
 */
function normalizeSessions(value) {
  const raw = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.sessions)
      ? value.sessions
      : isRecord(value) && Array.isArray(value.accountIds)
        ? value.accountIds.map((id) => ({ accountId: id, handle: null }))
        : [];
  const seen = new Set();
  const out = [];
  for (const s of raw) {
    if (!isRecord(s) || typeof s.accountId !== 'string' || s.accountId.length === 0) continue;
    if (seen.has(s.accountId)) continue;
    seen.add(s.accountId);
    out.push({
      accountId: s.accountId,
      handle:
        typeof s.handle === 'string' && s.handle.trim().length > 0
          ? s.handle.replace(/^@/, '').trim()
          : null,
    });
  }
  return out;
}

if (typeof self !== 'undefined') {
  self.XManagerProtocol = XManagerProtocol;
  self.XManagerProtocolHelpers = { isRecord, isPageMessage, isJobMessage, normalizeSessions };
}
