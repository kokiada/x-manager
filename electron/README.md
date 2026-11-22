# Electron 最小ホスト（D-02）

デスクトップ方式の最小ホスト。partition 1つで x.com を開くだけの構成。
設計は `docs/DESKTOP_DESIGN.md` §2–3。

## 構成

- `main.cjs` — エントリ。`npm run desktop` で起動する。
- `src/partition.cjs` — partition 名 `persist:xmgr-<accountId>` の生成・検証。
- `src/host.cjs` — ウィンドウ生成・引数解析・スモーク実行。

## 使い方

```sh
npm run desktop                  # x.com を開く（アカウントは既定の smoke）
npm run desktop -- --account korosukeada
npm run desktop -- --smoke        # 読み込み確認して終了。結果を JSON で出す
npm run desktop -- --smoke --url https://example.com/
```

`--smoke` は終了コード 0（表示OK）/ 1（失敗）で終わり、スクリーンショットを
`electron/smoke.png` に保存する。`--url` は https のみ指定できる（表示確認用）。

## テスト

```sh
npx vitest run electron/src/
```

electron モジュールは引数で受けるため、テストでは偽物に差し替えて検証する。
実機の表示確認は `--smoke` で行う。

## 注意

- この VM（ボブの環境）からは x.com への通信が egress プロキシで遮断されるため、
  `--smoke` で x.com の表示確認はできない。x.com の表示確認は PC で行うこと。
- root の Linux で起動する場合は `ELECTRON_DISABLE_SANDBOX=1` が必要
  （Chromium が root + sandbox ありでは起動しないため）。
