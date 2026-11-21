/**
 * x-manager 実行役 — background service worker。
 *
 * アプリ（content script 経由）からのメッセージを受け、X Web版内部APIで
 * 実際に実行して結果を返す。セッションの切替は session.js が直列化し、
 * 実行の振分は dispatch.js が行う。トークンはここから出ない
 * （x.com への Cookie / ヘッダとしてのみ使う）。
 */
'use strict';

/* global chrome, importScripts, XManagerProtocol, XManagerProtocolHelpers, XManagerSessions, XManagerSession, XManagerQueryIds, XManagerDispatch, XManagerErrors */

importScripts(
  'protocol.js',
  'errors.js',
  'sessionStore.js',
  'queryIds.js',
  'session.js',
  'xClient.js',
  'dispatch.js',
);

function resultMessage(jobId, outcome) {
  return {
    source: XManagerProtocol.EXTENSION_SOURCE,
    kind: 'result',
    id: jobId,
    ...outcome,
    at: Date.now(),
  };
}

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

  // 実行ジョブ：セッションを確認してから dispatch へ。
  if (message.kind === 'job' && message.source === XManagerProtocol.PAGE_SOURCE) {
    if (!XManagerProtocolHelpers.isJobMessage(message)) {
      sendResponse(
        resultMessage(typeof message.id === 'string' ? message.id : 'unknown', {
          ok: false,
          code: 'unknown',
          error: '不正なジョブです。',
        }),
      );
      return false;
    }
    const ctx = {
      sessions: XManagerSessions,
      chrome,
      fetchImpl: fetch,
      resolveQueryId: (op) =>
        XManagerQueryIds.getQueryId(op, {
          fetchImpl: fetch,
          storage: chrome.storage.local,
        }),
      // x-client-transaction-id の生成器はまだ無い（後で差し込むための口）。
      getTransactionId: null,
    };
    XManagerSessions.get(message.accountId)
      .then((session) => {
        if (!session) {
          sendResponse(
            resultMessage(message.id, {
              ok: false,
              code: 'no_session',
              error:
                'このアカウントは拡張に連携されていません。ポップアップから auth_token を登録してください。',
            }),
          );
          return;
        }
        return XManagerDispatch.handleJob(message, ctx).then(
          (data) => sendResponse(resultMessage(message.id, { ok: true, data })),
          (err) =>
            sendResponse(
              resultMessage(message.id, {
                ok: false,
                code: XManagerErrors.codeOf(err),
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
        );
      })
      .catch((err) => {
        sendResponse(
          resultMessage(message.id, {
            ok: false,
            code: 'unknown',
            error: err instanceof Error ? err.message : String(err),
          }),
        );
      });
    return true; // 非同期で sendResponse する
  }

  sendResponse({ ok: false, error: '不明なメッセージ種別です' });
  return false;
});
