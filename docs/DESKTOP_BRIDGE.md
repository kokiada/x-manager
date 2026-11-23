# デスクトップブリッジ仕様（D-06）

レンダラ（既存 Web アプリ）⇔ Electron ホスト（メインプロセス）の
通信仕様。Phase 1 の基盤。設計の全体像は `docs/DESKTOP_DESIGN.md`。

## 1. 経路

```
レンダラ（アプリ画面）
  │ window.xManagerDesktop.invoke(message)   … preload が公開
  ▼
preload（electron/src/preload.cjs）
  │ contextBridge → ipcRenderer.invoke('xmanager:bridge', message)
  ▼
メインプロセス（electron/main.cjs）
  │ ipcMain.handle('xmanager:bridge', …)
  ▼
ブリッジハンドラ（electron/src/bridge.cjs）
  │ createBridgeHandler(deps) → async (message) => response
  ▼
ホスト部品（partition / session / ページ文脈 fetch）
```

- preload は薄い層。`window.xManagerDesktop.invoke` 以外は何も
  公開しない。nodeIntegration は無効、contextIsolation・sandbox
  は有効のまま（`electron/src/host.cjs` の createHostWindow）。
- メッセージは IPC の引数としてそのまま渡る（JSON 化できる値のみ）。

## 2. メッセージ形式

拡張プロトコル（`src/executor/protocol.ts`）と同形。
アプリ側の定義は `src/executor/desktopProtocol.ts` が唯一の定義で、
ホスト側の `electron/src/bridge.cjs` は定数と形をミラーする。

- 送信元識別子：アプリ側は既存の `PAGE_SOURCE`（`'x-manager'`）を
  流用。ホスト側は新規の `DESKTOP_HOST_SOURCE`
  （`'x-manager-desktop-host'`）。
- プロトコル版：`PROTOCOL_VERSION = 1`（拡張と同じ）。
  ホスト自体の版：`DESKTOP_HOST_VERSION = '0.1.0'`（hello-ack に付く）。

| kind | 方向 | 内容 |
| --- | --- | --- |
| `hello` | アプリ → ホスト | `{ source, kind, version }` |
| `hello-ack` | ホスト → アプリ | `{ source, kind, version, hostVersion }` |
| `job` | アプリ → ホスト | `{ source, kind, ...ExtensionJob }`（id / method / accountId / accountHandle / payload / timeoutMs?） |
| `result` | ホスト → アプリ | `{ source, kind, ...ExtensionJobResult }`（id / ok / data? / error? / code? / at） |
| `list-sessions` | アプリ → ホスト | `{ source, kind }` |
| `sessions` | ホスト → アプリ | `{ source, kind, sessions: [{ accountId, handle }] }`（旧形式の `accountIds` にも対応） |

- 相関はジョブの `id` で取る（応答の `id` と一致すること）。
- 失敗の分類 `code` は拡張と同じ6種
  （`not_implemented` / `no_session` / `rate_limited` /
  `x_error` / `extension_broken` / `unknown`）を流用する。
  デスクトップでは `extension_broken` は基本的に出ないが、
  形を揃えるために残す。

## 3. タイムアウト

`protocol.ts` の値を流用する。

- ハンドシェイク（hello / list-sessions）：`HELLO_TIMEOUT_MS`（3秒）
- ジョブ：`job.timeoutMs ?? JOB_TIMEOUT_MS`（30秒）
- メディア付き投稿：`MEDIA_JOB_TIMEOUT_MS`（120秒）

## 4. セキュリティ

- auth_token はブリッジを流れない。ホストの partition 内
  （`session.cookies`）にのみ存在し、ジョブは `accountId` で
  セッションを引く（`docs/DESKTOP_DESIGN.md` §3・§6）。
- ジョブ結果・ログにトークンの値を含めない。
  `bridge.cjs` は値を返す経路を持たない。
- レンダラに渡すのは `invoke` 1関数だけ。Electron の実物
  （`ipcRenderer` など）は contextBridge の内側に留める。

## 5. 対応メソッドの現状（D-06 時点）

ブリッジハンドラは `createBridgeHandler(deps)` の純粋なルータ。

- `hello` → `hello-ack` を返す（骨組みで応答する）。
- `list-sessions` → `sessions` を返す。`deps.listSessions` が
  あればそれを使い、無ければ空配列を返す。
- `job` → `deps.handleJob` があれば委譲する。無ければ
  `{ ok: false, code: 'not_implemented' }` の結果を返す。
  Phase 0 ではホスト部品の接続が無いため、すべてのジョブは
  `not_implemented` になる。
- 形の壊れた入力には例外を投げず、`ok: false` の result を返す
  （id が取れないときは `id: ''`・`code: 'unknown'`）。
  未知の kind は `not_implemented` の結果を返す。

Phase 1 で `readCheck`（checkAccount）・`postTweet`
（executePost）から順に `deps.handleJob` へ接続する。
その際、メディアはジョブの payload に inline で載せる
（チャンク転送はしない。`DesktopExecutor` のコメント参照）。

## 6. アプリ側の部品

- `src/executor/desktopProtocol.ts`：型と検証関数
  （`isDesktopHelloAck` / `isDesktopJobResult` /
  `isDesktopSessionsMessage` / `normalizeDesktopSessions`）。
- `src/executor/desktopTransport.ts`：`DesktopTransport`
  インターフェースと `WindowBridgeTransport`
  （`window.xManagerDesktop` を使う。ブリッジ不在なら
  `DesktopNotConnectedError`、時間切れは `DesktopTimeoutError`）。
- `src/executor/DesktopExecutor.ts`：`Executor` のデスクトップ版。
  失敗文言はデスクトップ向け（`DESKTOP_ERROR_MESSAGES`）。
  メディアは payload に inline、タイムアウトは
  `MEDIA_JOB_TIMEOUT_MS`、転送上限は拡張版と同じ
  （1件32MB・合計64MB）。
- `src/executor/index.ts`：`executorMode === 'desktop'` のとき
  `DesktopExecutor` へ委譲（遅延生成、拡張と同方式）。
