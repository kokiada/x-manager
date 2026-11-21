/**
 * x-manager 実行役 — background service worker。
 *
 * アプリ（content script 経由）からのメッセージを受け、結果を返す。
 * この段階では実行そのものは未実装で、受付の応答（receipt）だけ返す。
 * 次の段階でここに X Web API 呼び出し（セッション切替＋実行）が入る。
 */
'use strict';

/* global chrome, importScripts, XManagerProtocol, XManagerSessions */

importScripts('protocol.js', 'sessionStore.js');

const NOT_IMPLEMENTED =
  'この操作はまだ拡張機能で実装されていません。次の段階で対応します。';

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') {
    sendResponse({ ok: false, error: '不正なメッセージです' });
    return false;
  }

  // ハンドシェイク：アプリが拡張の有無を確認する。
  if (message.kind === 'hello' && message.source === XManagerProtocol.PAGE_SOURCE) {
    sendResponse({
      source: XManagerProtocol.EXTENSION_SOURCE,
      kind: 'hello-ack',
      version: XManagerProtocol.VERSION,
      extensionVersion: XManagerProtocol.EXTENSION_VERSION,
    });
    return false;
  }

  // 連携済みアカウントの一覧。
  if (message.kind === 'list-sessions' && message.source === XManagerProtocol.PAGE_SOURCE) {
    XManagerSessions.list()
      .then((sessions) => {
        sendResponse({
          source: XManagerProtocol.EXTENSION_SOURCE,
          kind: 'sessions',
          accountIds: sessions.map((s) => s.accountId),
        });
      })
      .catch((err) => {
        sendResponse({
          source: XManagerProtocol.EXTENSION_SOURCE,
          kind: 'sessions',
          accountIds: [],
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true; // 非同期で sendResponse する
  }

  // 実行ジョブ：この段階では受付だけ返し、実行はしない。
  if (message.kind === 'job' && message.source === XManagerProtocol.PAGE_SOURCE) {
    XManagerSessions.get(message.accountId)
      .then((session) => {
        if (!session) {
          sendResponse({
            source: XManagerProtocol.EXTENSION_SOURCE,
            kind: 'result',
            id: message.id,
            ok: false,
            code: 'no_session',
            error: 'このアカウントは拡張に連携されていません。ポップアップから auth_token を登録してください。',
            at: Date.now(),
          });
          return;
        }
        sendResponse({
          source: XManagerProtocol.EXTENSION_SOURCE,
          kind: 'result',
          id: message.id,
          ok: false,
          code: 'not_implemented',
          error: NOT_IMPLEMENTED,
          at: Date.now(),
        });
      })
      .catch((err) => {
        sendResponse({
          source: XManagerProtocol.EXTENSION_SOURCE,
          kind: 'result',
          id: message.id,
          ok: false,
          code: 'unknown',
          error: err instanceof Error ? err.message : String(err),
          at: Date.now(),
        });
      });
    return true; // 非同期で sendResponse する
  }

  sendResponse({ ok: false, error: '不明なメッセージ種別です' });
  return false;
});
