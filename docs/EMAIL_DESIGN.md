# メールアドレス台帳と受信チェックの設計

## いま実装済み（このフェーズ）

- **メールアドレス台帳**（`EmailAddress`）：アドレス、ラベル/メモ、プロバイダ
  （gmail / outlook / yahoo / other）、作成・更新日時。DB v5 の
  `emailAddresses` テーブル（`id, address, provider`）に保存され、暗号化
  バックアップの対象にも含まれる。
- **アカウントとの紐づけ**：`Account.emailId`（nullable）。アカウント追加・
  編集フォームで台帳から選べる。一覧・詳細画面で紐づいたメアドを表示する。
- **紐づけチェック**（`src/lib/emailLinkCheck.ts`、純粋関数）：
  1. メアド未設定のアカウント
  2. 同じメアドを複数アカウントで使い回しているケース
  3. どのアカウントにも使われていないメアド
- **削除時の扱い**：メアドを削除すると、それに紐づくアカウントの
  `emailId` が外れる（null になる）。アカウント自体は消えない。

## 受信メールチェックの設計（未実装・この先のフェーズ）

目的：Xアカウントの登録に使っているメールアドレスの受信トレイを確認し、
Xからの通知（ロック警告・凍結通知・認証コード等）の見落としを防ぐ。

### 優先対応：Gmail / Outlook

ユーザーの要望により、**Gmail と Outlook を優先対応**とする。
プロバイダの選択肢も gmail / outlook を先頭に並べている。
Yahoo!メールとその他プロバイダは、IMAP 設定を手入力できる形で後から対応する。

| プロバイダ | IMAP サーバー（プリセット） | 認証 |
| --- | --- | --- |
| Gmail | `imap.gmail.com:993`（SSL） | アプリパスワード |
| Outlook | `outlook.office365.com:993`（SSL） | アプリパスワード。不可のアカウントは OAuth2 |
| Yahoo!メール | `imap.mail.yahoo.com:993`（SSL） | アプリパスワード |
| その他 | 手入力（ホスト・ポート） | IMAP の認証情報 |

プリセットは `EMAIL_IMAP_PRESETS`（`src/db/types.ts`）にあり、台帳の
provider 種別と連動する。`other` の場合はプリセットなし（手入力）。

Gmail / Outlook は方針A（OAuth2）のため、この表のアプリパスワード認証は
使わない。IMAP プリセットは Yahoo!メールとその他の将来対応用に残す。

### 認証の注意点（2026-11-22 タスク3-1・3-4の決定で置き換え）

- **Gmail / Outlook ともに OAuth2 のみ**。アプリパスワードは預からない。
  スコープは読み取り専用の最小権限だけ（Gmail: `gmail.readonly`、
  Outlook: `Mail.ReadBasic`）。送信・既読化の権限は取らない。
- OAuth2 のトークン（アクセストークン＋リフレッシュトークン）は、タスク8
  と同じく拡張の **`chrome.storage.local` にだけ置く**
  （キー `xmanager.mailTokens.v1`、契約は `src/lib/mailTokenStore.ts`）。
  アプリ側の IndexedDB（Dexie）やファイルには置かない。ブラウザでは
  OS の資格情報ストアを使えないため採用しない。
- トークン値はログやエラーメッセージに出さない。診断には期限とスコープ
  だけの要約（`describeMailToken`）を使う。

### MVP の範囲

1. 受信トレイの**新着ヘッダ一覧**（差出人・件名・日時）を取得する。
2. **未読数**を取得する。
3. 取得結果を台帳画面（または通知/DM集約画面）に表示する。

送信・既読化・フォルダ移動は MVP の外。X からの通知メールを見落とさない
ことだけを最初のゴールとする。

### 実装の進め方（次フェーズ以降）

Gmail / Outlook の API 呼び出し層（`src/lib/gmailApi.ts`・`src/lib/outlookApi.ts`）
とトークン保存の契約（`src/lib/mailTokenStore.ts`）は実装済み。
残りは次の2点。

1. OAuth2 の認可フロー（利用者が Gmail / Outlook の認可をして
   トークンを `xmanager.mailTokens.v1` に入れる画面・手順）を実装する。
2. Gmail / Outlook の接続を、サブアカウントで試運転する（タスク3-5）。
