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
| `open-login` | アプリ → ホスト | `{ source, kind, accountId }`（P1-03。ログイン用ウィンドウを開く） |
| `open-login-result` | ホスト → アプリ | `{ source, kind, accountId, ok, xUserId?, handle?, error?, code? }`（P1-03） |

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
- `open-login` → `deps.openLogin` があれば委譲し、
  `open-login-result` を返す。無ければ
  `{ ok: false, code: 'not_implemented' }` を返す（P1-03）。
- 形の壊れた入力には例外を投げず、`ok: false` の result を返す
  （id が取れないときは `id: ''`・`code: 'unknown'`）。
  未知の kind は `not_implemented` の結果を返す。

Phase 1 で `readCheck`（checkAccount）・`postTweet`
（executePost）から順に `deps.handleJob` へ接続する。
その際、メディアはジョブの payload に inline で載せる
（チャンク転送はしない。`DesktopExecutor` のコメント参照）。

## 7. アプリ画面の起動（P1-01）

ホストはアプリ画面も同じウィンドウ（preload ブリッジ付き）で開く。

- `--app`：ビルド済みアプリ `dist/index.html` を `file://` で開く。
  無ければ `npm run build` を促すエラーになる。
- `--app-dev`：開発サーバー `http://localhost:5173/` を開く
  （`npm run dev` を先に起動しておくこと）。
- `--hello-check`：`--app` / `--app-dev` と組み合わせて使い、
  アプリ画面で hello ハンドシェイク（preload → ipcMain →
  ブリッジハンドラの往復）が通ることを確認する。成功時は
  `{ ok: true, hostVersion, title, url }` を JSON で出し、
  スクリーンショットを `electron/hello-check.png` に保存する。

ビルド済みアプリは `file://` で読むため、vite の `base` は
`'./'` にしてある（絶対パス `/assets/...` では `file://` で
JS/CSS が読めない。HTTP 配信時もルート・サブパスどちらでも
同じように読める）。

## 8. アプリ側の部品

- `src/executor/desktopProtocol.ts`：型と検証関数
  （`isDesktopHelloAck` / `isDesktopJobResult` /
  `isDesktopSessionsMessage` / `normalizeDesktopSessions`）。
- `src/executor/desktopTransport.ts`：`DesktopTransport`
  インターフェースと `WindowBridgeTransport`
  （`window.xManagerDesktop` を使う。ブリッジ不在なら
  `DesktopNotConnectedError`、時間切れは `DesktopTimeoutError`）。
## 6. ログイン取り込み（P1-03）

デスクトップ版では auth_token を手入力で取得しない。アカウント
ごとの partition でログイン用ウィンドウを開き、ユーザーが x.com
に普通にログインすると、X が発行した auth_token / ct0 がその
partition の Cookie として保存される。

- 流れ：アプリの Accounts 画面（デスクトップモード）で
  「ログイン」→ `open-login`（`accountId`）→ ホストが
  `electron/src/loginImport.cjs` の `runLoginImport` を実行。
  ログイン用ウィンドウで `https://x.com/i/flow/login` を開き、
  auth_token の出現を 2 秒間隔でポーリング（最長 5 分）する。
  出現したらウィンドウを閉じ、D-04 の読み取り（verify_credentials）
  で `{ id, handle }` を確定して `open-login-result` を返す。
  アプリ側は検出したハンドルで台帳を更新する。
- ログイン用ウィンドウにはブリッジの preload を付けない。
  x.com のページ文脈から `window.xManagerDesktop.invoke` に
  届いてはならないため。partition / contextIsolation /
  nodeIntegration 無効 / sandbox 有効は通常のホストウィンドウと同じ。
- タイムアウト：ホスト側のログイン待ちは 5 分
  （`LOGIN_IMPORT_TIMEOUT_MS`）、アプリ側の輸送層は 6 分
  （`OPEN_LOGIN_TIMEOUT_MS`）。ウィンドウをユーザーが閉じた
  場合は専用の文言で失敗する。
- CLI でも同じ流れを試せる：
  `npm run desktop -- --login-import --account <id>`
  （`--proxy` と併用可。結果を JSON で出す）。
  実ログインの成否は x.com へ届く環境（実PC）でのみ確認できる。

## 8. アプリ側の部品
  失敗文言はデスクトップ向け（`DESKTOP_ERROR_MESSAGES`）。
  メディアは payload に inline、タイムアウトは
  `MEDIA_JOB_TIMEOUT_MS`、転送上限は拡張版と同じ
  （1件32MB・合計64MB）。
- `src/executor/index.ts`：`executorMode === 'desktop'` のとき
  `DesktopExecutor` へ委譲（遅延生成、拡張と同方式）。
