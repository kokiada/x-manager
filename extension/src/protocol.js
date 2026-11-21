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
  JOB_TIMEOUT_MS: 30000,
  HELLO_TIMEOUT_MS: 3000,
  METHODS: [
    'executePost',
    'deletePost',
    'executeAction',
    'checkAccount',
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
    (value.kind === 'hello' || value.kind === 'job' || value.kind === 'list-sessions')
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

if (typeof self !== 'undefined') {
  self.XManagerProtocol = XManagerProtocol;
  self.XManagerProtocolHelpers = { isRecord, isPageMessage, isJobMessage };
}
