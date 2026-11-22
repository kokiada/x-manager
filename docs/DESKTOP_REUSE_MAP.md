# デスクトップ開発・実行層の流用マップ（D-01 途中経過その1）

- 対象：`main` 19c267e（2026-11-22、設計書 `docs/DESKTOP_DESIGN.md` あり。手元HEADと一致、pull済み）
- 行数は 0c08d46 時点のもの（19c267e との差分は PROGRESS.md のみのため同じ）。
- 判定の意味：**流用**＝そのまま／小さい手直しで使える、**作り直し**＝Electron用に書き直す、
  **不要**＝デスクトップ方式では要らない、**要確認**＝Phase 0（D-02〜D-05）で確定する。
- 設計書 §5 の粗いマップをファイル単位に切り分けたもの。残り（`src/lib` 実行系の精査）は次の切り分けで追加する。

## extension/src（拡張の実行役）

| ファイル | 行数 | 役割 | 判定 | 備考 |
|---|---|---|---|---|
| `xClient.js` | 814 | X内部APIクライアント（GraphQL呼び出し、メディアUPLOAD、コミュニティ投稿） | 流用 | エンドポイント定義と呼び出し形をそのまま流用。ページ文脈で動かすため fetch の送り先だけホスト側に寄せる |
| `queryIds.js` | 191 | GraphQL query IDの解決（動的スキャン＋フォールバック） | 流用 | ロジックはそのまま。ページ文脈ではスキャン対象の取得方法だけ変わる可能性あり |
| `dispatch.js` | 291 | アプリからのジョブをX内部API呼び出しに振り分ける | 流用 | 各メソッドの処理はそのまま。受け口が postMessage から Electron ブリッジに変わる |
| `errors.js` | 33 | 失敗の分類付きエラー（code付き） | 流用 | 分類と日本語文案はそのまま |
| `transactionId.js` | 614 | x-client-transaction-id生成器（Service Worker移植版） | 要確認 | 生成器流用かDOM実装に戻すかはPhase 0で確定（設計書§4）。どちらにせよ生成ロジック自体は流用の種 |
| `sessionImport.js` | 131 | ログイン中アカウントの取り込み（Cookie直読＋verify_credentialsで身元解決） | 作り直し | 身元解決の考え方は流用。Cookie読み取りが `chrome.cookies` から partition の `session.cookies` に変わる |
| `session.js` | 195 | アカウント別セッションの切替（Cookie差し替え） | 作り直し | 差し替え方式そのものが partition 分離に置き換わる。不要になる側 |
| `sessionStore.js` | 69 | セッション保管庫（chrome.storage.local） | 作り直し | 保管先がホスト側になる。auth_tokenはホスト内にだけ置く原則は継承 |
| `mediaStore.js` | 139 | メディア転送データの一時保管庫（base64チャンク） | 作り直し | チャンク転送は postMessage 用の仕組み。IPC経由の受け渡しに置き換え。UPLOAD本体（xClient側）は流用 |
| `background.js` | 251 | Service Worker本体（メッセージ受付→実行） | 作り直し | Electronメインプロセスのホストに置き換わる |
| `content.js` | 23 | 中継（window.postMessage ⇔ background） | 作り直し | Electronブリッジ（contextBridge/IPC）に置き換わる |
| `popup.js` / `popup.html` | 117 | 連携アカウント管理（取り込みボタン、手入力フォーム） | 作り直し | ホスト側のセッション管理画面に置き換わる。手入力フォームは予備として残すかPhase 1で決める |
| `protocol.js` | 102 | 通信プロトコルのミラー（正本は `src/executor/protocol.ts`） | 不要 | 拡張用のミラーは要らない。protocol.ts を土台に desktop 版を定義する（D-06） |
| `clientIdentity.js` | 119 | 固定ID（x-client-uuid/deviceid）の送信 | 不要 | 実ブラウザ文脈のため不要になる見込み。Phase 0で要否を確認（設計書§5） |
| `manifest.json` | — | 拡張マニフェスト（DNRのRefererルール含む） | 不要 | Electronでは使わない。DNRのRefererルールはページ文脈では自然なRefererになるため不要 |

## src/executor（アプリ側の実行層）

| ファイル | 行数 | 役割 | 判定 | 備考 |
|---|---|---|---|---|
| `Executor.ts` | 191 | Executorインターフェース（実行をXへ届ける層） | 流用 | 差し替え点はここ。`executorMode` に `'desktop'` を追加する |
| `protocol.ts` | 362 | 通信プロトコルの唯一の定義 | 流用 | ジョブ／結果／セッション一覧の形を土台に揃える。desktop版はここから派生（D-06） |
| `ExtensionExecutor.ts` | 320 | 拡張経由のExecutor実装 | 流用 | 拡張方式は当面存続し併用・切り戻し可能にするため残す |
| `SimulatorExecutor.ts` | 287 | シミュレータのExecutor実装 | 流用 | 残す |
| `index.ts` | 96 | Executorの切り替え（mode別） | 流用 | `'desktop'` 分岐を追加する |
| `transport.ts` | 205 | WindowPostMessageTransport | 作り直し | IPCトランスポートに置き換わる。postMessage版は拡張方式用に残す |
| `extensionStatus.ts` | 49 | 拡張の接続状態（設定画面の表示用） | 作り直し | ホストの接続状態表示に置き換わる |
| `ExtensionExecutor.test.ts` / `protocol.test.ts` / `transport.test.ts` / `extensionExecution.test.ts` / `extensionStatus.test.ts` / `transactionId.test.ts` | — | 各テスト | 流用 | 完了条件はテスト100%。desktop版は対応するテストを新規追加する |

## src/lib（実行に直結するもの）

| ファイル | 行数 | 役割 | 判定 | 備考 |
|---|---|---|---|---|
| `jobRunner.ts` | — | ジョブ実行の台帳側 | 流用 | Executor越しに動くため、desktop対応はExecutor層で吸収する |
| `bulkPostService.ts` / `bulkPost.ts` | — | 一括投稿サービス | 流用 | 同上 |
| `banCheckService.ts` | — | バンチェック | 流用 | 同上。実行の直列化はアカウント内直列（設計書§4）に変わるが、呼び出し側は同じ |
| `notificationService.ts` | — | 通知・DM集約 | 流用 | 同上 |
| `autoPostEngine.ts` / `autoActionEngine.ts` / `scheduledChecks.ts` | 214 / — / 98 | 自動投稿・定期チェック | 流用 | 同上 |
| `sessionImport.ts` | 78 | 連携セッションを台帳へ取り込む純粋関数 | 流用 | ハンドル無しは作らない方針（1-2修正）はそのまま |
| `gmailApi.ts` / `outlookApi.ts` | 264 / 254 | メール受信チェック（OAuth2 readonly） | 流用 | 設計書§5の通り流用。ブラウザで開く認可フローはデスクトップ側の受け口をPhase 1で決める |
| `mailTokenStore.ts` | 97 | メール用OAuth2トークンの保存方法 | 要確認 | 現行は拡張の chrome.storage.local に置く決定（タスク3-4）。デスクトップ方式での保管先はホスト側に見直す |

## 未決・要確認（Phase 0 で確定するもの）

- `transactionId.js`：生成器流用かDOM実装に戻すか（D-05で確定）。
- `clientIdentity.js`：固定IDが本当に不要か（D-02〜D-05の実測で確認）。
- `mailTokenStore.ts`：メール用トークンの保管先（ホスト側への移し替え）。
- `queryIds.js`：ページ文脈でのスキャン対象の取得方法。
- `popup.js` の手入力フォーム：予備として残すかどうか（Phase 1）。

## 次の切り分け（D-01の残り）

- `src/lib` の残り（`bulkActionService.ts`、`autoAction.ts`、`searchBanPacing.ts`、`emailLinkCheck.ts` 等）の実行層との関わりを精査し、この表へ追加する。
- D-02〜D-05の結果を受けて「要確認」を「流用／作り直し／不要」に倒し、PROGRESS.md の D-01 を完了にする。
