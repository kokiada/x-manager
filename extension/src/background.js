/**
 * x-manager 実行役 — background service worker。
 *
 * アプリ（content script 経由）からのメッセージを受け、X Web版内部APIで
 * 実際に実行して結果を返す。セッションの切替は session.js が直列化し、
 * 実行の振分は dispatch.js が行う。トークンはここから出ない
 * （x.com への Cookie / ヘッダとしてのみ使う）。
 */
'use strict';

/* global chrome, importScripts, XManagerProtocol, XManagerProtocolHelpers, XManagerSessions, XManagerSession, XManagerQueryIds, XManagerDispatch, XManagerErrors, XManagerMediaStore */

importScripts(
  'protocol.js',
  'errors.js',
  'sessionStore.js',
  'queryIds.js',
  'session.js',
  'xClient.js',
  'transactionId.js',
  'mediaStore.js',
  'dispatch.js',
);

// メディア転送データの一時保管庫（チャンクを組み立て直す）。
const pendingMedia = XManagerMediaStore.createMediaStore({});

// x-client-transaction-id の生成器。初期化は初回の書き込み時に遅延し、
// 失敗したら null を返してヘッダ無しで送る（従来の動作にフォールバック）。
const transactionIdGenerator = XManagerTransactionId.createGenerator({
  fetchImpl: fetch,
});

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
  // 診断（Cookie API の可否）も一緒に返し、アプリ側がジョブを送る
  // 前に「実行できる状態か」を判断できるようにする。
  if (message.kind === 'hello' && message.source === XManagerProtocol.PAGE_SOURCE) {
    sendResponse({
      source: XManagerProtocol.EXTENSION_SOURCE,
      kind: 'hello-ack',
      version: XManagerProtocol.VERSION,
      extensionVersion: XManagerProtocol.EXTENSION_VERSION,
      diagnostics: {
        cookiesApi: XManagerSession.cookiesApiAvailable(chrome),
      },
    });
    return false;
  }

  // 連携済みアカウントの一覧（ID＋ハンドル）。
  // `sessions` が新形式。旧版のアプリ向けに `accountIds` も残す。
  if (message.kind === 'list-sessions' && message.source === XManagerProtocol.PAGE_SOURCE) {
    XManagerSessions.list()
      .then((sessions) => {
        const normalized = XManagerProtocolHelpers.normalizeSessions(sessions);
        sendResponse({
          source: XManagerProtocol.EXTENSION_SOURCE,
          kind: 'sessions',
          sessions: normalized,
          accountIds: normalized.map((s) => s.accountId),
        });
      })
      .catch((err) => {
        sendResponse({
          source: XManagerProtocol.EXTENSION_SOURCE,
          kind: 'sessions',
          sessions: [],
          accountIds: [],
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true; // 非同期で sendResponse する
  }

  // メディア本体のチャンク転送：保管庫に積み、受領応答を返す。
  if (message.kind === 'media-chunk' && message.source === XManagerProtocol.PAGE_SOURCE) {
    try {
      pendingMedia.storeChunk(message);
      sendResponse({
        source: XManagerProtocol.EXTENSION_SOURCE,
        kind: 'media-chunk-ack',
        uploadId: message.uploadId,
        index: message.index,
      });
    } catch (err) {
      sendResponse({
        source: XManagerProtocol.EXTENSION_SOURCE,
        kind: 'media-chunk-ack',
        uploadId: typeof message.uploadId === 'string' ? message.uploadId : '',
        index: typeof message.index === 'number' ? message.index : -1,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return false;
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
      pendingMedia,
      resolveQueryId: (op) =>
        XManagerQueryIds.getQueryId(op, {
          fetchImpl: fetch,
          storage: chrome.storage.local,
        }),
      // x-client-transaction-id の生成器（transactionId.js）。
      getTransactionId: (method, url) => transactionIdGenerator(method, url),
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
