# Electron 最小ホスト（D-02・D-03）

デスクトップ方式の最小ホスト。partition 1つで x.com を開くだけの構成。
設計は `docs/DESKTOP_DESIGN.md` §2–3。

## 構成

- `main.cjs` — エントリ。`npm run desktop` で起動する。
- `src/partition.cjs` — partition 名 `persist:xmgr-<accountId>` の生成・検証。
- `src/host.cjs` — ウィンドウ生成・引数解析・スモーク実行。
- `src/session.cjs` — partition のプロキシ設定（setProxy）と Cookie 設定
  （auth_token / ct0）・検証。Cookie の値は返り値に含めない。

## 使い方

```sh
npm run desktop                  # x.com を開く（アカウントは既定の smoke）
npm run desktop -- --account korosukeada
npm run desktop -- --smoke        # 読み込み確認して終了。結果を JSON で出す
npm run desktop -- --smoke --url https://example.com/
npm run desktop -- --proxy http://proxy.example.com:8080   # プロキシ経由で開く
npm run desktop -- --verify-session --account korosukeada  # ウィンドウを開かず
          # partition のプロキシ解決と Cookie 有無だけ確認する（JSON を出す）
```

`--smoke` は終了コード 0（表示OK）/ 1（失敗）で終わり、スクリーンショットを
`electron/smoke.png` に保存する。`--url` は https のみ指定できる（表示確認用）。
`--proxy` は `http://` / `https://` / `socks5://` の host:port を指定する
（`user:pass@host:port` の形で認証情報も渡せる）。`--verify-session` は
終了コード 0（確認OK）/ 1（失敗）で終わる。

## テスト

```sh
npx vitest run electron/src/
```

electron モジュールは引数で受けるため、テストでは偽物に差し替えて検証する。
実機の表示確認は `--smoke` で行う。実機のプロキシ・Cookie 確認は
`--verify-session` で行う（xvfb-run が要る環境では `xvfb-run -a` を付ける）。

## 注意

- この VM（ボブの環境）からは x.com への通信が egress プロキシで遮断されるため、
  `--smoke` で x.com の表示確認はできない。x.com の表示確認は PC で行うこと。
- `--verify-session` のプロキシ解決と Cookie 有無の確認は、この VM でも
  xvfb-run 経由で実施できる。ただし設定したプロキシ経由の x.com への実通信と、
  設定した Cookie でのセッション確認は、この VM からはできないため PC 側で
  後日まとめて行う（D-03 の実通信確認は保留中）。
- root の Linux で起動する場合は `ELECTRON_DISABLE_SANDBOX=1` が必要
  （Chromium が root + sandbox ありでは起動しないため）。
