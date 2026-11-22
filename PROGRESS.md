# 進行状況（PROGRESS.md）

未実装機能の洗い出しと計画。タスクは実行可能レベルまで細分化し、1つの
タスクが完了するまでは別の作業には着手しない。タスクの完了基準は
**テスト100%成功**。リーダー：ボブ（2026-11-21 決定）。

## タスク一覧

- [x] **1. メディア付き投稿**（ゆい）— 2026-11-21 完了
  - [x] 1-1 アプリ側：メディア bytes をジョブに載せる（MediaPicker の File 保持、`fileToBase64`、`PostContent.media`、`jobRunner` の `resolveMedia`、BulkPost の解決器）
  - [x] 1-2 拡張側：チャンクアップロード INIT/APPEND/FINALIZE（`xClient.uploadMedia`、upload.x.com、動画は STATUS 確認まで）
  - [x] 1-3 拡張側：CreateTweet への `media_id` 添付（`media_entities`）と、転送路（`media-chunk` 256KBずつ・受領応答つき、`mediaStore.js` 保管庫）
  - [x] 1-4 テスト100%と最終確認（260件全パス、build 通過、拡張 JS は `node --check` 通過、lint エラー0）
  - 概要：画像 png/jpg/gif/webp（1ポスト4件まで・画像5MB／GIF 15MB）と動画 mp4/mov（1件まで・512MB）に対応。転送上限は1件32MB・合計64MB。実アカウントでの疎通は未検証。
- [x] **2. コミュニティ投稿**（ゆい）— 2026-11-21 完了
  - [x] 2-1 アプリ側：コミュニティIDの入力とペイロード（投稿画面のコミュニティID入力・`buildPostContent` の `communityId` 引き継ぎ・バリデーションは既に実装済みだったため、挙動を確認してテストを追加）
  - [x] 2-2 拡張側：CreateTweet への `community_id` 添付とコミュニティ投稿の実行（`xClient.postTweet` に `communityId` を追加、ツリーの続きにも付与、メディア付きコミュニティ投稿も同じ CreateTweet で送れる。ID無し・数字以外は日本語エラー、Xのコミュニティ絡みエラーは権限が分かる日本語に直す）
  - [x] 2-3 テスト100%と最終確認（266件全パス、build 通過、拡張 JS は `node --check` 通過、lint エラー0）
  - 概要：別の操作や別の query ID は要らず、通常の CreateTweet に `community_id` を付けるだけ。実アカウントでの疎通は未検証。
- [ ] **3. 受信メールチェックの設計見直し**（ボブ）— 進行中（ブラウザ一本化に合わせた見直し。台帳は実装済み、設計のみ `docs/EMAIL_DESIGN.md`）
  - [x] 3-1 現行設計とブラウザ一本化の差分洗い出しと方針決定 — 2026-11-22 完了（方針A：Gmail API / Microsoft Graph 経由の OAuth2。Koki 承認済み。`files/task3-design-review-2026-11-22.md`）
  - [x] 3-2 Gmail API readonly の調査・モック実装 — 2026-11-22 完了（`src/lib/gmailApi.ts`：readonly スコープのみ、ヘッダ一覧・未読数、モッククライアント。テスト24件全パス、全体299件全パス、lint エラー0。実機の OAuth2 認可・トークン保存は 3-4 で決める）
  - [x] 3-3 Outlook（Microsoft Graph）の調査・モック実装 — 2026-11-22 完了（`src/lib/outlookApi.ts`：Mail.ReadBasic スコープのみ、ヘッダ一覧・未読数、モッククライアント。一覧1回でヘッダが取れる。テスト25件全パス、全体324件全パス、lint エラー0。実機の OAuth2 認可・トークン保存は 3-4 で決める）
  - [x] 3-4 トークン保存方法の決定 — 2026-11-22 完了（タスク8と同じく拡張の chrome.storage.local にだけ置く。キー `xmanager.mailTokens.v1`、契約は `src/lib/mailTokenStore.ts`。スコープは読み取り専用のみ、トークン値はログに出さない。EMAIL_DESIGN.md の旧記述（アプリパスワード＋safeStorage）を置き換え。テスト7件全パス、全体331件全パス）
  - [ ] 3-5 サブアカウントでの試運転（テストアカウント待ちのため後回し）
- [ ] **4. 書き込み系の検証**（ガッツ）— 未着手（投稿・いいね・リポスト・ブックマーク・フォロー・削除の実アカウント検証）
- [x] **5. 分析・通知/DM集約の実データ確認**（ボブ）— 2026-11-22 完了
  - [x] 5-1 通知・DMの実データ形状の確認 — 拡張の getNotifications は notifications/all.json＋DM inbox_timeline（trusted）を試し、形式違いは not_implemented。確認で不具合を1件発見：通知の at が取得時刻（Date.now()）で、台帳の重複排除キー（accountId|kind|title|at）が再取得で変わり、同じ通知が何度も増える
  - [x] 5-2 通知の at を応答の時刻から取る（`notification.timestamp` → `sortIndex` → 取得時刻、秒・ミリ秒対応、変な値は弾く）。DM の at も time が読めないときは取得時刻（NaN にならない）
  - [x] 5-3 集約サービスのテスト追加（`src/lib/notificationService.test.ts`：2回目の取得は0件、空は0件、失敗は黙って0件にしない）
  - [x] 5-4 分析の写像の検証（`tweetMetrics`：views・bookmark_count 無しは0、墓碑は弾く、可視性ラッパーはほどく。UserTweets からの実測値は Analytics 画面の最終スナップショットに既に配線済み、途中経過だけ simulateMetrics の近似）
  - [x] 5-5 テスト100%と最終確認（337件全パス、build 通過、拡張 JS は `node --check` 通過、lint エラー0）
  - 概要：実アカウントでの疎通は未検証（テストアカウント待ち。3-5 と同じ）
- [x] **6. 自動投稿・定期チェックの通し確認**（ボブ）— 2026-11-22 完了
  - [x] 6-1 自動投稿エンジンの通しテスト（`src/lib/autoPostEngine.test.ts`：期日スロットの発火→ジョブ→実行記録、15分遅れスキップ、空テンプレート、サーチバン見送り、ルール同時実行1件、無効ルール）
  - [x] 6-2 定期チェックの抽出とテスト（フック内に埋もれていた定期アカウントチェック・定期バン判定チェックを `src/lib/scheduledChecks.ts` に移し、`src/lib/scheduledChecks.test.ts` で検証。有効・時刻・1日1回・グループ・1件失敗時の継続）
  - [x] 6-3 1日の流れの通しテスト（朝のチェック→バン判定→自動投稿が同じ台帳でつながる）
  - [x] 6-4 確認で見つけた不具合2件を修正：(1) tickAutoPost が今日の発火済みキーしか見ず、処理済みの遅刻スロットを毎日スキップ記録として重ねていた（今日＋昨日のキーを見るようにした）。(2) timeTodayMs が '25:00' のような範囲外の時刻を翌日へ繰り越して有効にしてしまっていた（0-23時・0-59分で弾く）。ついでにタスク5のテストのフレーキー（通知行の並びを主キー順と決めつけていた）も直した
  - [x] 6-5 テスト100%と最終確認（356件全パス、5回連続で全パス、build 通過、拡張 JS は `node --check` 通過、lint エラー0）
  - 概要：実アカウントでの疎通は未検証（テストアカウント待ち。3-5 と同じ）。自動アクションの定期サイクル（`runAutoActionCycle`、発火元はデモ投稿）は未検証のまま
- [x] **7. ドキュメント・コード整理**（ボブ）— 2026-11-22 完了（exe 廃止に伴うブラウザ前提への寄せ）
  - [x] 7-1 コード：`electron/`（main.cjs / preload.cjs）、`src/electron.d.ts`、`build/icons/`、`scripts/make-icons.py` を削除。設定画面の Electron 限定ボタンと説明文を削除。`electron` / `electron-builder` の依存を外し、`app` / `dist:win` スクリプトと `main` / `build` 設定を `package.json` から削除（`npm ci` で lockfile の整合性を確認済み）
  - [x] 7-2 ドキュメント：`docs/APP_BUILD.md` をブラウザ版のビルド・起動手順に書き換え。`docs/EMAIL_DESIGN.md` から廃止済みの Electron 限定設計と IMAP 実装手順を削除し、残課題（OAuth2 認可フロー・試運転）を明記。`docs/REAL_X_DESIGN.md` のデータ置き場所をブラウザ前提に修正。`extension/README.md` から Electron 版の読み込み節を削除
  - [x] 7-3 検証：テスト356件全パス、build 通過、拡張 JS は `node --check` 通過、lint エラー0。`npm ci` も通過
  - 残したもの：`docs/xboard-research.md` の XBoard 本家インストーラの記述（他社製品の調査記録のため）、PROGRESS.md の過去の記録
- [x] **8. auth_tokenの安全な取り込み**（ゆい）— 2026-11-21 完了
  - [x] 8-1 拡張側：ログイン中アカウントのCookie読み取りと身元解決（`sessionImport.js` 新規。auth_token・ct0 を Cookie から直接読む。ct0 が無ければ x.com を開いてから再読。`xClient.getCurrentUser` は `account/verify_credentials.json` で数値ユーザーIDとハンドルを確認。返り値はIDとハンドルのみでトークンは出さない。Cookie API が使えなければ extension_broken、未ログインは日本語エラー）
  - [x] 8-2 画面側：取り込みボタンと表示（ポップアップに「今ログイン中のアカウントを取り込む」ボタンを追加。成功時は `@ハンドル を取り込みました。` と表示して一覧を更新。background に `import-current-account`（送信元 `x-manager-popup`）の受付を追加。手入力の登録は予備として残す。プロトコル正本・ミラーに `POPUP_SOURCE` を追加して同期テストも更新）
  - [x] 8-3 テスト100%と最終確認（275件全パス、build 通過、拡張 JS は `node --check` 通過、lint エラー0）
  - 概要：トークンをコピー＆ペーストする方式をやめ、拡張が自分の Cookie 権限で直接読む方式に。実アカウントでの疎通は未検証。

## 3-5 試運転中の不具合修正（2026-11-22、テスト計画 0-1〜3-2 の実行で発覚）
- 2-1 再実行は OK（チェック成功、フォロワー 304→303、最終チェック 10:47 に更新）。
- 3-1 は HTTP 422 で投稿失敗。原因は `extension/src/xClient.js` の CreateTweet variables が存在しないフィールド `possibly_media: []` を送っていたこと。X の実スキーマは `media: { media_entities, possibly_sensitive: false }`（公開の twikit / x-kit 等と一致）。`possibly_sensitive: false` に修正。テストで media の形を固定（`extensionExecution.test.ts`：`possibly_media` が無いことも確認）。
- 同時に `requestJson` の汎用エラー分岐で X の応答本文を落としていた問題も修正。422 などは `errors[0].message`（無ければ本文先頭300文字）を含めて返す。422 の本文伝達テストを追加。
- サイドバーが常に `EXECUTOR: SIMULATOR` と表示されていたのは `AppShell.tsx` の固定文言が原因。保存済みの `executorMode` を読んで `EXECUTOR: EXTENSION / SIMULATOR` を出すように修正。アカウント画面の「チェックはシミュレータ Executor 経由」も実行方法に合わせて切り替わるように修正。
- 3-1 失敗後に一括投稿の「予約・履歴」タブを開くと画面全体が真っ黒になり操作不能になる現象が2回再現。描画例外時に ErrorBoundary が無く React 全体が落ちていたのが原因とみられる（静的解析では特定の throw は断定できず）。対策：`src/components/ErrorBoundary.tsx` を追加し `main.tsx` でアプリ全体を囲む（例外時はメッセージと再読み込みボタンを表示）。ついでに `JobHistory.tsx` の `segments[0].slice` と `job.entries` を空安全にした。
- 検証：テスト357件全パス（新規422テスト含む）、tsc OK、lint エラー0、build 通過、拡張 JS は `node --check` 通過。
- 再テスト待ち：3-1 の再実行と履歴タブの確認は、Koki 側で `git pull` → `npm run build` → アプリ再起動＋拡張の再読み込み後にブラウザで実施する。

## 1-2 の仮ハンドル（linked-…）の解消（2026-11-22）
- 原因：拡張のポップアップの手入力フォームはハンドルが任意で、空のまま連携するとセッションにハンドルが入らない。アプリの取り込みはハンドル無しのセッションに `linked-<IDの先頭8文字>` の仮ハンドルを付けて台帳へ作っていた。そのハンドルはX上に存在しないため、チェックは必ず「見つかりません」になっていた（チェック側に仮ハンドル専用の案内文言まであった）。
- 修正：
  - 拡張に `resolveAccountIdentity` ジョブを追加（dispatch.js／protocol.js の METHODS／`src/executor/protocol.ts` の ExtensionMethod／Executor インタフェース／ExtensionExecutor／SimulatorExecutor／DelegatingExecutor）。verify_credentials で数値IDと本物のハンドルを返す。
  - `src/lib/sessionImport.ts`：仮ハンドルを作るのをやめた。ハンドル無しのセッションは `needsHandle` に回し、呼び出し側が本人確認して本物のハンドルで作る。解決できなければ作らない。`placeholderHandle` は削除し、仮ハンドル判定の `isPlaceholderHandle` を追加。
  - `src/pages/Accounts.tsx` の取り込み：ハンドル無しのセッションは本人確認してから作る。過去の取り込みで残った仮ハンドル（linked-…）も、連携セッションと突き合わせて本人確認で直す。直せないものは作らず、件数をトーストで知らせる。
  - 拡張ポップアップ：手入力フォームのハンドルを必須にした（空なら保存せず、「今ログイン中のアカウントを取り込む」を案内する）。
  - `docs/REAL_X_DESIGN.md` の取り込み手順と Executor メソッド表を更新。
- 検証：テスト359件全パス（resolveAccountIdentity の dispatch・Executor テスト含む）、tsc OK、lint エラー0、build 通過、拡張 JS は `node --check` 通過。
- 再テスト待ち：Koki 側で `git pull` → `npm run build` → アプリ再起動＋拡張の再読み込み後、「拡張の連携を取り込む」で仮ハンドルが本物のハンドル（@korosukeada）に直ることを確認する。1-2 は NG のまま記録する。

## 2026-11-22 11:21〜11:41 再テスト結果と不具合修正

### 再テスト結果（ブラウザ、アプリは http://127.0.0.1:47831/ で実行）
- 1-2：OK。取り込み前から一覧は @korosukeada 1件のみで仮ハンドルは表示されず。「拡張の連携を取り込む」→「取り込むアカウントはありませんでした（1件は連携済みでした）」。バッジ「ログイン済」「連携済み」。
- 3-1：NG。422 は直っていない。「動作確認テスト」「動作確認テスト2」とも HTTP 422。X のエラー詳細も表示されず。
- 履歴タブ：NG。開くと今回も画面全体が真っ黒（今回で3回目）。再読み込みで復旧。
- サイドバー：再保存＋再読み込み後も「EXECUTOR: SIMULATOR」のまま。
- 5-1：スキップ（参加中のコミュニティなし。GOT7 は未加入）。
- 6-1〜6-3：アプリ経由は自分の投稿のため設計上除外（0/1件成功）。X で直接トグルして確認し、元に戻し済み（いいね 2→3→2、リポスト 0→1→0、ブックマーク追加→削除）。
- 6-4：X で直接実施（@X のフォロー→解除を確認）。
- 7-1：OK。通知 0 件／DM 0 件で実データと一致。本文表示と重複排除は実データが無いため未確認。
- 7-2：OK。ポスト分析 20件、実データと一致。表示回数はすべて 0。注記は「取得はシミュレータ Executor 経由です。」のままだった。
- 8-1：△。11:34 に発火したが HTTP 422 で失敗。別件：ルール作成直後の 11:31 に「スキップ」「予定時刻（11:34）を15分以上過ぎたためスキップ」と誤ったスキップ履歴が記録された（11:34 はまだ未来）。
- 8-2・9-1・9-2：未実施（タブが操作不能になったため）。4-1・4-2：スキップ（使える画像ファイルなし）。
- 残作業：自動投稿ルール「自動投稿テスト」の削除確認、8-2・9-1・9-2 の実施。テンプレート No.1「自動投稿テスト」は残っている。

### 重要：修正が実行中のアプリ／拡張に反映されていなかった
- 2a7e6c6・7245098 の効果が3か所とも出ていない（サイドバー、X エラー詳細、ErrorBoundary）。実行中のビルドは 2dbafcb 相当のまま。
- 原因：リポジトリ内に 47831 の記述は無い。47831 は旧 Electron exe が内蔵 dist を配信しているもので、`npm run build` では更新されない。新しいコードは `npm run dev`（http://localhost:5173/）で動かす必要がある。拡張の xClient.js も chrome://extensions での再読み込みが必要。
- 次の再テストは 5173（npm run dev）＋拡張の再読み込みで実施すること。3-1・履歴タブの再テストは未完了のまま。

### 8-1 の誤スキップの修正（a156374）
- 原因：tickAutoPost は昨日＋今日のスロットを評価する。11:31 に作ったルールの昨日の 11:34 スロットは 23時間以上遅れなので遅刻スキップとして記録され、理由のラベルが時刻だけ（11:34）だったため、今日の 11:34 が未来なのにスキップされたように見えた。
- 修正：`src/lib/autoPostEngine.ts` — ルール作成時刻より前のスロットは評価対象外にした（作ったばかりのルールは昨日のスロットを遡ってスキップしないし、作った直後に過ぎた当日スロットも発火しない）。スキップ理由に日付を入れた（11/21 11:34）。
- 分析ページの「取得はシミュレータ Executor 経由です。」の注記を、保存済み executorMode で切り替わるようにした（アカウント画面と同じパターン）。
- 検証：テスト360件全パス（新規ルールの遡りスキップ無し＋11:34 発火、理由の日付フォーマット。通しテストのルール作成時刻を2日前にして前提を保った）、tsc OK、lint エラー0、build 通過、拡張 JS は `node --check` 通過。コミット a156374 をプッシュ済み（リモート main = a156374 を ls-remote で確認）。

## 2026-11-22 バージョン表記を追加（72de40b）

- Koki の要望：毎回アプリのバージョン表記で修正が適用されているかチェックしたい。
- `vite.config.ts` の `define` でビルド時のコミット（`git rev-parse --short HEAD`、取れなければ `dev`）とビルド時刻（ISO）を注入。`src/lib/version.ts` で表示用に整形（`M/D HH:MM`）。
- サイドバー下部に `VERSION: <コミット> · <ビルド時刻>` を表示。設定画面に「バージョン」セクションを追加（コミット＋ビルド時刻、リモート main の先頭と見比べる旨の注記）。
- `docs/APP_BUILD.md` に確認手順と注意点を追記：`npm run dev` は起動時のコミットを表示するので `git pull` のあとは dev サーバーを再起動すること。旧 Electron 版（47831）は内蔵 dist を配信するため `npm run build` では更新されない。拡張のコードはアプリのバージョン表示の対象外なので、拡張を変更したときは chrome://extensions で再読み込みすること。
- 検証：テスト363件全パス（version.test.ts 3件を含む）、tsc OK、lint エラー0、build 通過。ビルド後の dist にコミットハッシュが含まれていることも確認。コミット 72de40b をプッシュ済み（リモート main = 72de40b を ls-remote で確認）。
