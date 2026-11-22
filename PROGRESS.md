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
- [ ] **7. ドキュメント・コード整理**（ボブ）— 未着手（exe 廃止に伴うブラウザ前提への寄せ）
- [x] **8. auth_tokenの安全な取り込み**（ゆい）— 2026-11-21 完了
  - [x] 8-1 拡張側：ログイン中アカウントのCookie読み取りと身元解決（`sessionImport.js` 新規。auth_token・ct0 を Cookie から直接読む。ct0 が無ければ x.com を開いてから再読。`xClient.getCurrentUser` は `account/verify_credentials.json` で数値ユーザーIDとハンドルを確認。返り値はIDとハンドルのみでトークンは出さない。Cookie API が使えなければ extension_broken、未ログインは日本語エラー）
  - [x] 8-2 画面側：取り込みボタンと表示（ポップアップに「今ログイン中のアカウントを取り込む」ボタンを追加。成功時は `@ハンドル を取り込みました。` と表示して一覧を更新。background に `import-current-account`（送信元 `x-manager-popup`）の受付を追加。手入力の登録は予備として残す。プロトコル正本・ミラーに `POPUP_SOURCE` を追加して同期テストも更新）
  - [x] 8-3 テスト100%と最終確認（275件全パス、build 通過、拡張 JS は `node --check` 通過、lint エラー0）
  - 概要：トークンをコピー＆ペーストする方式をやめ、拡張が自分の Cookie 権限で直接読む方式に。実アカウントでの疎通は未検証。
