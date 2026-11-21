# 実X連携の設計（REAL_X）

2026-11-21、こうきくんの指示「全ての機能がXに連携して動作する状態にして」を受け、
XBoardクローンの全機能を本物のXで動かすための設計。土台（プロトコル・拡張の骨格・
Webアプリ側の切替）に続き、実行そのもの（X Web版内部APIの呼び出し）も実装済み。
ただし実アカウントでの疎通確認はまだで、初回試運転が次の段階。

## なぜ拡張が必要か

ブラウザで開くWebアプリには、x.com への Cookie 注入やアカウント別プロキシ経由の
ブラウザ操作ができない（ブラウザのセキュリティモデル）。本家XBoardはPC常駐アプリが
アカウントごとのブラウザセッションを持ってXを直接操作することで実投稿を実現している。
x-manager は同じ役割を **Chrome拡張** に担わせる。コンソール（管理画面・予約・自動投稿・
チェックの仕組み）はそのまま使い、実行だけを拡張に委譲する。

## 構成

```
┌─────────────────────────────┐      window.postMessage       ┌──────────────────────────┐
│ x-manager Webアプリ          │ ───────────────────────────▶ │ Chrome拡張「実行役」       │
│ ・全10セクションの画面       │ ◀─────────────────────────── │ ・content script（中継）  │
│ ・キュー・予約・自動ルール   │   ジョブ指示 / 結果          │ ・background（振分・実行） │
│ ・Executor（差し替え口）     │                              │ ・セッション保管庫         │
│ ・トークンを持たない         │                              │   chrome.storage.local    │
└─────────────────────────────┘                              └──────────┬───────────────┘
                                                                        │ cookies / fetch
                                                                        ▼
                                                              ┌──────────────────┐
                                                              │ x.com            │
                                                              └──────────────────┘
```

- **Webアプリ**：画面・キュー・予約・自動ルールのすべて。Executor インターフェース
  （`src/executor/Executor.ts`）が差し替え口で、モードでシミュレータと拡張を切り替える。
- **content script**：アプリのページで動き、`window.postMessage` と
  `chrome.runtime.sendMessage` を中継するだけ。トークンはここを通らない。
- **background（service worker）**：アプリからのジョブを受け、連携済みセッションで
  Xを操作して結果を返す。実行の本体。
- **セッション保管庫**：`chrome.storage.local` に `{accountId: {authToken, handle, linkedAt}}`。
  拡張のポップアップで登録・解除する。

## セッション戦略（アカウント別）

- 実行は **1ジョブ＝1アカウント**。background はジョブごとに、そのアカウントの
  `auth_token` と `ct0` を `chrome.cookies` で `x.com` にセットしてから実行する。
  並行ジョブは直列化し、Cookie の取り違えを防ぐ（次の段階で実装するキューで保証）。
- プロキシはこの段階では扱わない。本家はアカウントごとに個別プロキシを使うが、
  拡張だけではアカウント別プロキシの切替ができない。実運用では利用者の回線
  （自宅IP）で動かす前提とし、プロキシ対応はローカルエージェント版の課題とする。
  （`docs/xboard-research.md` のプロキシ仕様は、プロキシグループの割当として
  アプリ側の台帳には既に入っている。）
- 1アカウント＝1セッション。ロック・凍結・未ログインのアカウントは実行前に
  弾く（アプリ側の `status` と拡張側の応答の両方で確認する）。

## 実行の仕組み（実装済み・2026-11-21）

拡張は X の **Web版内部API** を、ユーザーのブラウザのセッションで呼ぶ。
実装は `extension/src/xClient.js`（呼び出し）＋ `extension/src/session.js`
（セッション切替）＋ `extension/src/dispatch.js`（振分）。

- 投稿：`POST https://x.com/i/api/graphql/<queryId>/CreateTweet`。
  ツリーは1件ずつ返信として連ねる。メディア付き・コミュニティ投稿は
  未対応（`not_implemented` を返す）。
- 削除：`DeleteTweet`。いいね：`FavoriteTweet`。リポスト：`CreateRetweet`。
  ブックマーク：`CreateBookmark`。いずれも GraphQL（POST）。
- フォロー：`GET UserByScreenName` でハンドル→ユーザーIDを解決してから
  `POST https://api.x.com/1.1/friendships/create.json`（REST 1.1）。
- アカウントチェック：`UserByScreenName` でフォロワー数を取得。401/403 は
  「ログアウト状態」というチェック結果として返す。通知/DM数は
  `GET https://x.com/i/api/2/badge_count.json` を試し、取れなければ
  -1（不明）としてアプリ側が保存済みの値を残す。
- サーチバンチェック：チェッカーアカウントのセッションで `UserTweets` から
  対象の最新ポストを1件取り、`SearchTimeline`（`from:<handle>`、product
  Top / Latest）でそのポストが表示されるかを確認する（本家の手順どおり）。
- 分析：`UserTweets`（最大50件）から計測値（いいね・リポスト・ブックマーク・
  閲覧数）を集計する。
- 通知／DM：`GET https://x.com/i/api/2/notifications/all.json` と
  `GET https://x.com/i/api/1.1/dm/inbox_timeline/trusted.json` を試す。
  応答形式が想定と違えば `not_implemented` を返す（成功を偽らない）。

### query ID の解決

GraphQL の query ID は X の更新で数週間単位で変わる。`extension/src/queryIds.js`
が二段構えで解決する：① x.com トップページから JS バンドル（abs.twimg.com）
を拾って `/i/api/graphql/<id>/<操作名>` を走査する（24時間キャッシュ）、
② 見つからなければ 2026-02 時点の公開情報によるフォールバック ID を使う
（CreateTweet / UserByScreenName / UserTweets / SearchTimeline / Followers
のみ）。それでも無ければ `not_implemented`。
走査には締切がある（既定15秒。アプリ側のジョブタイムアウト30秒に収まる
よう）。締切までに見つかった分とフォールバックで返すので、走査が遅い
せいでジョブ全体が時間切れになることはない。並行する解決は1回の走査を
共有する。

### 最大のリスク：x-client-transaction-id

2026年から X は書き込み系の GraphQL 呼び出しに `x-client-transaction-id`
ヘッダを求めることがある。生成器は `extension/src/transactionId.js` に
ある。@lami/x-client-transaction-id 0.3.3（MIT）の公開実装を、Service
Worker 向けに移植したもの（DOM を使う部分だけ、シェル HTML の文字列
解析に置き換え。計算は同じ）。x.com のアプリシェルから verification
鍵と ondemand.s を取り、アニメーション鍵を導いて SHA-256＋XOR で
組み立てる。background が `getTransactionId` として差し込み済みで、
`xClient.js` が書き込みのたびに付ける。生成に失敗したらヘッダ無しで
送る（従来の動作にフォールバック）ので、生成器の不調で投稿自体が
止まることはない。403 の文言は「ヘッダ付きで拒否されたか」「生成に
失敗してヘッダ無しで拒否されたか」で分かれる。

未検証の点：シェル（https://x.com/i/jf/）の取得は、ログインしていない
ブラウザだとログイン画面に回されることがある。拡張の background から
の fetch がシェルを返すかどうかは、実アカウントでの試運転（ブラウザ
での一括投稿の再試行）で確認する。シェルが取れなければ生成器は
null を返し、ヘッダ無しの従来動作になる。その場合は、ログイン済みの
x.com タブからシェル HTML をもらう content script 経由の取得を検討する。
生成器が難しい場合は **DOM操作フォールバック**（x.com の画面を実際に操作する）
を検討する。実アカウントでの初回試運転で、書き込みが通るかどうかが
最初に分かる（`extension/README.md` の試運転手順を参照）。

内部APIは X 側の変更で壊れることがある。壊れた場合は拡張の更新で追従する。
どの方法でも、**操作の間隔・上限はアプリ側の仕様（1〜60秒間隔、1日の上限など）を守る**。

## 通信プロトコル

正本は `src/executor/protocol.ts`。拡張側の `extension/src/protocol.js` はそのミラー
（同期は `src/executor/protocol.test.ts` が検証）。

- ハンドシェイク：アプリ `hello` → 拡張 `hello-ack`（プロトコル版・拡張の版を返す）
  - 応答には自己診断 `diagnostics: { cookiesApi: boolean }` も付く。
    `chrome.cookies` が使えない状態（拡張の再読み込み直後や Service
    Worker の異常時）では `false` になる。古い拡張は診断を返さない
    ので、アプリ側は無い場合を「不明」として扱う。
- ジョブ：`{id, method, accountId, accountHandle, payload}` →
  結果 `{id, ok, data?, error?, code?, at}`（`id` で相関を取る）
- 連携一覧：`list-sessions` → `{sessions: [{accountId, handle}]}`（旧形式
  `{accountIds}` も後方互換で受け付ける）
- メソッドは Executor と1対1：`executePost / deletePost / executeAction /
  checkAccount / checkSearchBan / fetchPostAnalytics / fetchNotifications`
- 失敗の分類 `code`：`not_implemented`（未実装）／`no_session`（未連携）／
  `rate_limited`／`x_error`／`extension_broken`（拡張の Cookie API が
  使えない＝再読み込みが必要）／`unknown`
- チェック前の疎通確認：アカウントチェック（単体・一括・詳細画面）と
  一括投稿は、拡張モードではジョブを送る前に接続＋Cookie API の可否を
  確認し、ダメなら理由付きの日本語トーストを出して止める。生の TypeError
  （`Cannot read properties of undefined (reading 'set')`）が画面に
  出ることはない。
- 一括投稿の失敗は無言にしない：ジョブの完了トーストには成功件数と
  最初の失敗理由を付け、履歴（JobCard）には1件ごとの結果と理由が残る。
  ランナー外の予期せぬ失敗（保存の不具合など）でもジョブは `partial`
  で締め、「実行中」のまま残さない。進捗の保存に失敗しても投稿自体は
  止めない（最終結果はジョブ完了時に保存し直す）。

タイムアウト：ハンドシェイク 3秒、ジョブ 30秒。拡張側の内訳は
query ID 走査の締切 15秒、ct0 取得 10秒、1ジョブの実行 28秒。
いずれもアプリ側の30秒より先に切れるので、拡張が無応答のまま
30秒を丸ごと消費することはない。1ジョブが時間切れになっても
直列キューは詰まらず、次のジョブは普通に動く（遅れて動き出した
処理は Cookie の書き換えや Xへの実行を行わない）。

## データの置き場所と連携の流れ

利用者が「拡張で連携したのにアプリの一覧に出ない」と戸惑ったため、
仕組みをここに明記する。**保存場所は2つあり、自動では同期しない。**

- **アプリの台帳**：Webアプリの IndexedDB（アカウント・グループ・設定など）。
  オリジンごとに別物になる。`npm run dev` の `http://localhost:5173` と、
  Electron アプリ版の `http://127.0.0.1:47831` は**別のデータ**を持つ。
  どちらか一方に決めて使うこと。
- **拡張の連携**：Chrome 拡張の `chrome.storage.local`
  （`{accountId: {authToken, handle, linkedAt}}`）。
  Chrome と Electron アプリ版でも別物。Chrome 側で登録した連携は
  Electron 版には引き継がれず、逆も同じ。連携画面もそれぞれ別に開く。

想定する流れ：

1. アプリでアカウントを追加する（または、まず拡張で連携だけ済ませる）
2. 拡張のポップアップで、そのアカウントのIDと auth_token を登録する
3. アプリのアカウント画面で「拡張の連携を取り込む」を押す
   → 拡張の連携のうち台帳に無いものを、セッションのIDそのままで台帳へ追加する
   （ハンドルが未入力のセッションは `linked-<IDの先頭8文字>` の仮ハンドルで作り、後で編集できる）
4. 一覧に「連携済み」バッジが付けば、実行方法「拡張」での操作が使える

## セキュリティモデル

- **トークンは拡張の中にだけある。** `auth_token` は利用者のPCの
  `chrome.storage.local` にだけ保存され、Webアプリ・ネットワークには出ない。
- **Webアプリはトークンを持たない。** アプリ側のジョブは「どのアカウントで、何を」
  という指示だけ。アプリが既に持っている `Account.authToken`（CSV仕様の名残で
  IndexedDB にあるもの）は、この連携では使わない。連携は拡張のポップアップで
  行い、アプリ側は「連携済みかどうか」の一覧を拡張に聞くだけ。
- **未接続時は失敗する。** 実行方法が「拡張」で拡張が見つからない場合、操作は
  明確な日本語エラーで失敗する。シミュレータに黙って戻ることはない。
- **利用者の判断が必要な点。** Xの画面操作の自動化はXの利用規約上グレーで、
  アカウントのロック・凍結リスクがある。本家も自己責任の注意書きつきで販売
  している領域であることは、利用者に伝えたうえで進める。

## Executor メソッドと実Xの対応表

「実装済み」はコードが書かれ、スタブを使った単体テスト（17件）が通った
状態。「未検証」は実アカウントでの疎通がまだで、初回試運転で確認する。

| メソッド | 実Xでの仕組み | 状態 |
|---|---|---|
| `executePost`（通常／リプライ／ツリー／予約） | CreateTweet。ツリーは返信で連ねる。メディア付き・コミュニティは未対応 | 実装済み・未検証（書き込みは取引ID要求のリスクあり） |
| `deletePost` | DeleteTweet | 実装済み・未検証 |
| `executeAction`（いいね／リポスト／ブックマーク／フォロー） | FavoriteTweet / CreateRetweet / CreateBookmark / friendships/create.json | 実装済み・未検証 |
| `checkAccount` | UserByScreenName＋badge_count（取れなければ -1＝不明） | 実装済み・未検証 |
| `checkSearchBan` | UserTweets＋SearchTimeline（Top / Latest） | 実装済み・未検証 |
| `fetchPostAnalytics` | UserTweets（最大50件）＋計測値 | 実装済み・未検証 |
| `fetchNotifications` | notifications/all.json＋DM inbox（形式が違えば not_implemented） | 実装済み・未検証 |

未対応のまま返しているもの：メディア付き投稿（upload.x.com の
INIT/APPEND/FINALIZE が要る）、コミュニティ投稿。`not_implemented` で
返すので、成功したように見えることはない。

## フェーズ計画

1. **土台（完了）**：プロトコル、拡張の骨格（ハンドシェイク・受付応答・
   セッション保管庫・ポップアップ）、Webアプリ側の `ExtensionExecutor`・接続確認・
   実行方法の切替（設定画面）、テスト。
2. **実行の実装（完了・2026-11-21）**：background に X 内部API呼び出しを実装。
   対象は投稿・削除・いいね／リポスト／ブックマーク／フォロー・アカウントチェック・
   サーチバンチェック・分析・通知/DM取得。セッション切替の直列化と、スタブを
   使った単体テスト17件（全体172件）が通っている。**実アカウントでの疎通確認は
   まだ**（開発環境に実アカウントが無いため）。
3. **実アカウントでの疎通確認**：利用者のPCで拡張を読み込み、サブアカウントで
   アカウントチェック→テスト投稿→削除→いいね・フォロー・サーチバンチェックの
   順に試す（手順は `extension/README.md`）。ここで初めて、書き込みが通るか
   （取引ID問題）、query ID・応答形式が生きているかが分かる。
4. **疎通確認後の追従**：取引IDが必要なら生成器か DOM フォールバックを実装。
   メディア付き投稿・コミュニティ投稿の実装。定期チェック・自動投稿・自動操作
   との結合確認。取得系の実クエリの精査はガッツ担当分（土台の上に実装）。

## 既知の制限・リスク

- 拡張は Chrome（PC）でのみ動く。スマホの Chrome には拡張を入れられないため、
  **実行は拡張を入れたPCの Chrome が起きている間だけ**。コンソール自体は
  スマホからも見られるし指示も出せるが、実行は PC 側で行われる。
- X の内部APIは予告なく変わる。壊れたら拡張の更新で追従する。
- 自動化は X の規約上グレーで、ロック・凍結のリスクがある。間隔・上限を守る。
- アカウント別プロキシは拡張だけでは実現できない（ローカルエージェント版の課題）。
- 拡張は今のところ `localhost` / `127.0.0.1` / `*.muse.ai` のページでのみ動く。
  公開先が変わったら `manifest.json` の `content_scripts[].matches` に追加する。
- **実行中は x.com のタブを操作しないこと。** 拡張がブラウザ共有の Cookie
  （auth_token・ct0）を切り替えるため、開いているタブのアカウントが入れ替わる
  ことがある。別プロファイルで拡張を動かすのがいちばん安全。
- **実アカウントでの疎通は未確認。** この段階の検証はスタブを使った単体テスト
  までで、X の実際の応答は見ていない。query ID・応答形式・取引ID要求の
  いずれかが変わっていると、初回試運転で失敗が出る。その場合はエラーメッセージ
  が原因を指し示す設計になっている。
