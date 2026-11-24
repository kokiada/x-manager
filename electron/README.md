# Electron 最小ホスト（D-02・D-03・D-04・D-05）

デスクトップ方式の最小ホスト。partition 1つで x.com を開くだけの構成。
設計は `docs/DESKTOP_DESIGN.md` §2–3。

## 構成

- `main.cjs` — エントリ。`npm run desktop` で起動する。
- `src/partition.cjs` — partition 名 `persist:xmgr-<accountId>` の生成・検証。
- `src/host.cjs` — ウィンドウ生成・引数解析・スモーク実行。
- `src/session.cjs` — partition のプロキシ設定（setProxy）と Cookie 設定
  （auth_token / ct0）・検証。Cookie の値は返り値に含めない。
- `src/readCheck.cjs` — ページ文脈 fetch によるアカウントチェック相当の
  読み取り（`account/verify_credentials.json`）。`{ id, handle }` だけを
  返す。トークンの値は返り値に含めない。
- `src/postTweet.cjs` — ページ文脈 fetch による投稿（GraphQL
  `CreateTweet`）。`{ postId, postUrl }` だけを返す。トークンの値は
  返り値に含めない。`x-client-transaction-id` は生成器
  （`extension/src/transactionId.js`）を流用してページ文脈で作る
  （DOM 実装には戻さない。D-05 の確定事項）。生成に失敗したら
  ヘッダ無しで送る。

## 使い方

```sh
npm run desktop                  # x.com を開く（アカウントは既定の smoke）
npm run desktop -- --account korosukeada
npm run desktop -- --smoke        # 読み込み確認して終了。結果を JSON で出す
npm run desktop -- --smoke --url https://example.com/
npm run desktop -- --app          # ビルド済みアプリ（dist/index.html）を開く
npm run desktop -- --app-dev      # 開発サーバー（http://localhost:5173/）のアプリを開く
npm run desktop -- --app --hello-check   # アプリ画面で hello ハンドシェイクを確認する
          # （結果を JSON で出す。--app-dev とも併用可。スクリーンショットを
          # electron/hello-check.png に保存する）
npm run desktop -- --proxy http://proxy.example.com:8080   # プロキシ経由で開く
npm run desktop -- --verify-session --account korosukeada  # ウィンドウを開かず
          # partition のプロキシ解決と Cookie 有無だけ確認する（JSON を出す）
npm run desktop -- --read-check --account korosukeada      # ページ文脈 fetch で
          # verify_credentials を呼び、{ id, handle } だけ確認する（JSON を出す）
          # --proxy も併用できる
npm run desktop -- --post-check --text "hello" --account korosukeada
          # ページ文脈 fetch で実際に投稿する（JSON を出す）。--text は必須
```

`--smoke` は終了コード 0（表示OK）/ 1（失敗）で終わり、スクリーンショットを
`electron/smoke.png` に保存する。`--url` は https のみ指定できる（表示確認用）。
`--app` はビルド済みアプリ（`dist/index.html` を file:// で開く。無ければ
`npm run build` を促すエラーになる）、`--app-dev` は開発サーバー
（`http://localhost:5173/`。`npm run dev` を先に起動しておくこと）を開く。
どちらも preload ブリッジ付きで開く。`--app` / `--app-dev` と `--url` の
併用はできない。`--hello-check` は `--app` / `--app-dev` と組み合わせて使い、
アプリ画面で hello ハンドシェイク（preload → ipcMain → ブリッジハンドラの
往復）が通ることを確認する。成功時は
`{"ok":true,"hostVersion":"0.1.0","title":"...","url":"..."}` を JSON で出し、
スクリーンショットを `electron/hello-check.png` に保存する。終了コードは
0（確認OK）/ 1（失敗）のつもりだが、実機では `process.exitCode` が
`app.quit()` に伝わらず常に 0 で終わる既知の問題がある（D-02 の `--smoke`
も同じ。JSON の `ok` で判定すること）。
`--proxy` は `http://` / `https://` / `socks5://` の host:port を指定する
（`user:pass@host:port` の形で認証情報も渡せる）。`--verify-session` は
終了コード 0（確認OK）/ 1（失敗）で終わる。`--read-check` はページ文脈で
verify_credentials を fetch し、成功時は `{"ok":true,"id":"...","handle":"..."}`
を、失敗時は `{"ok":false,"error":"..."}` を JSON で出す。終了コードは
`--verify-session` と同じ 0/1 のつもりだが、実機では `process.exitCode` が
`app.quit()` に伝わらず常に 0 で終わる既知の問題がある（D-02 の `--smoke`
も同じ。JSON の `ok` で判定すること）。

## テスト

```sh
npx vitest run electron/src/
```

electron モジュールは引数で受けるため、テストでは偽物に差し替えて検証する。
実機の表示確認は `--smoke` で行う。実機のアプリ画面＋ハンドシェイク確認は
`--app --hello-check`（ビルド済みアプリ）または `--app-dev --hello-check`
（開発サーバー。`npm run dev` を先に起動）で行う（同じく `xvfb-run -a` を付ける）。
この VM でも両方とも実施できる（file:// の dist と localhost:5173 は到達可能）。
実機のプロキシ・Cookie 確認は
`--verify-session` で行う（xvfb-run が要る環境では `xvfb-run -a` を付ける）。
実機の読み取り確認は `--read-check` で行う（同じく `xvfb-run -a` を付ける）。
この VM では x.com に到達できないため `--read-check` は通信失敗になる。
成功パスの実機確認は、ページの fetch をスタブしたスクラッチ実行で行う
（`electron/src/readCheck.test.ts` のスタブ fetch テストと同じ応答形）。
実機の投稿確認は `--post-check --text "..."` で行う（同じく `xvfb-run -a`
を付ける）。実際に投稿するため、テスト用の文言で1回だけ行うこと。
この VM では x.com に到達できないため `--post-check` は通信失敗になる。
成功パスの確認は `electron/src/postTweet.test.ts` のスタブ fetch テスト
と同じ応答形で行う。実投稿の確認は PC 側で後日まとめて行う
（D-05 の実投稿確認は保留中）。

## 注意

- この VM（ボブの環境）からは x.com への通信が egress プロキシで遮断されるため、
  `--smoke` で x.com の表示確認はできない。x.com の表示確認は PC で行うこと。
- `--verify-session` のプロキシ解決と Cookie 有無の確認は、この VM でも
  xvfb-run 経由で実施できる。ただし設定したプロキシ経由の x.com への実通信と、
  設定した Cookie でのセッション確認は、この VM からはできないため PC 側で
  後日まとめて行う（D-03 の実通信確認は保留中）。
- root の Linux で起動する場合は `ELECTRON_DISABLE_SANDBOX=1` が必要
  （Chromium が root + sandbox ありでは起動しないため）。
