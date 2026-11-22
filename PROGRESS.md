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
- [ ] **5. 分析・通知/DM集約の実データ確認**（ボブ）— 未着手
- [ ] **6. 自動投稿・定期チェックの通し確認**（ボブ）— 未着手
- [ ] **7. ドキュメント・コード整理**（ボブ）— 未着手（exe 廃止に伴うブラウザ前提への寄せ）
- [x] **8. auth_tokenの安全な取り込み**（ゆい）— 2026-11-21 完了
  - [x] 8-1 拡張側：ログイン中アカウントのCookie読み取りと身元解決（`sessionImport.js` 新規。auth_token・ct0 を Cookie から直接読む。ct0 が無ければ x.com を開いてから再読。`xClient.getCurrentUser` は `account/verify_credentials.json` で数値ユーザーIDとハンドルを確認。返り値はIDとハンドルのみでトークンは出さない。Cookie API が使えなければ extension_broken、未ログインは日本語エラー）
  - [x] 8-2 画面側：取り込みボタンと表示（ポップアップに「今ログイン中のアカウントを取り込む」ボタンを追加。成功時は `@ハンドル を取り込みました。` と表示して一覧を更新。background に `import-current-account`（送信元 `x-manager-popup`）の受付を追加。手入力の登録は予備として残す。プロトコル正本・ミラーに `POPUP_SOURCE` を追加して同期テストも更新）
  - [x] 8-3 テスト100%と最終確認（275件全パス、build 通過、拡張 JS は `node --check` 通過、lint エラー0）
  - 概要：トークンをコピー＆ペーストする方式をやめ、拡張が自分の Cookie 権限で直接読む方式に。実アカウントでの疎通は未検証。
