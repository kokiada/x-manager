/**
 * D-06: デスクトップブリッジ — レンダラ ⇔ メインプロセスのルータ。
 *
 * preload（contextBridge）が `window.xManagerDesktop.invoke(message)`
 * で受けたメッセージを ipcMain.handle('xmanager:bridge') 経由で
 * このハンドラへ渡す。メッセージの形はアプリ側の
 * `src/executor/desktopProtocol.ts` と同じ（詳しくは
 * docs/DESKTOP_BRIDGE.md）。
 *
 * 純粋なルータ：Electron の実物には触れない。ホスト部品は
 * deps 経由で差し込む（テストでは偽物に差し替え）。
 *  - deps.listSessions: () => [{ accountId, handle }]（無ければ空配列）
 *  - deps.handleJob: (job) => result（無ければ not_implemented）
 *
 * 壊れた入力には例外を投げず、ok:false の result を返す。
 * トークンの値はこの経路には出ない（セッションは partition 内）。
 */
'use strict';

const DESKTOP_HOST_SOURCE = 'x-manager-desktop-host';
const PROTOCOL_VERSION = 1;
const HOST_VERSION = '0.1.0';

const NOT_IMPLEMENTED_ERROR =
  'この操作はまだデスクトップホストで実装されていません。Phase 1 で対応します。';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** ジョブの形かどうか（id・method・accountId が文字列であること）。 */
function isJobShape(value) {
  return (
    isRecord(value) &&
    value.kind === 'job' &&
    typeof value.id === 'string' &&
    value.id.length > 0 &&
    typeof value.method === 'string' &&
    value.method.length > 0 &&
    typeof value.accountId === 'string' &&
    value.accountId.length > 0
  );
}

/** 失敗結果を1件作る。id が取れないときは ''、分類は unknown。 */
function failResult(id, code, error) {
  return {
    source: DESKTOP_HOST_SOURCE,
    kind: 'result',
    id: typeof id === 'string' ? id : '',
    ok: false,
    code,
    error,
    at: Date.now(),
  };
}

/** セッション一覧の形を整える。壊れた項目は落とす。 */
function normalizeSessions(value) {
  if (!Array.isArray(value)) return [];
  const sessions = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.accountId !== 'string' || item.accountId.length === 0) {
      continue;
    }
    sessions.push({
      accountId: item.accountId,
      handle: typeof item.handle === 'string' && item.handle.length > 0 ? item.handle : null,
    });
  }
  return sessions;
}

/**
 * ブリッジハンドラを作る。`async (message) => response` を返す。
 * hello → hello-ack、list-sessions → sessions、job → 結果
 * （deps.handleJob が無ければ not_implemented）。
 * 形の壊れた入力や未知の kind にも例外を投げず、ok:false の
 * result を返す。
 */
function createBridgeHandler(deps = {}) {
  return async (message) => {
    try {
      if (!isRecord(message) || typeof message.kind !== 'string' || message.kind.length === 0) {
        return failResult('', 'unknown', 'ブリッジへのメッセージの形が不正です。');
      }
      if (message.kind === 'hello') {
        return {
          source: DESKTOP_HOST_SOURCE,
          kind: 'hello-ack',
          version: PROTOCOL_VERSION,
          hostVersion: HOST_VERSION,
        };
      }
      if (message.kind === 'list-sessions') {
        const sessions =
          typeof deps.listSessions === 'function' ? normalizeSessions(await deps.listSessions()) : [];
        return { source: DESKTOP_HOST_SOURCE, kind: 'sessions', sessions };
      }
      if (message.kind === 'job') {
        if (!isJobShape(message)) {
          return failResult(message.id, 'unknown', 'ジョブの形が不正です。');
        }
        if (typeof deps.handleJob === 'function') {
          const result = await deps.handleJob(message);
          // 委譲先の結果が形を欠いていても、壊れた応答は返さない。
          if (!isRecord(result) || typeof result.ok !== 'boolean') {
            return failResult(message.id, 'unknown', 'ホストの実行結果の形が不正です。');
          }
          return {
            source: DESKTOP_HOST_SOURCE,
            kind: 'result',
            id: typeof result.id === 'string' ? result.id : message.id,
            ok: result.ok,
            ...(isRecord(result.data) ? { data: result.data } : {}),
            ...(typeof result.error === 'string' ? { error: result.error } : {}),
            ...(typeof result.code === 'string' ? { code: result.code } : {}),
            at: typeof result.at === 'number' ? result.at : Date.now(),
          };
        }
        return failResult(message.id, 'not_implemented', NOT_IMPLEMENTED_ERROR);
      }
      // 未知の kind は not_implemented として返す。
      return failResult(message.id, 'not_implemented', '対応していないメッセージです。');
    } catch (err) {
      // 委譲先の例外もここで吸収し、ok:false の結果にする。
      const id = isRecord(message) && typeof message.id === 'string' ? message.id : '';
      return failResult(id, 'unknown', err instanceof Error ? err.message : String(err));
    }
  };
}

module.exports = {
  DESKTOP_HOST_SOURCE,
  PROTOCOL_VERSION,
  HOST_VERSION,
  createBridgeHandler,
};
