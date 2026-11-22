# x-manager のビルドと起動（ブラウザ版）

x-manager はブラウザで動く Web アプリです。Windows の exe 版
（Electron）は 2026-11-21 に廃止し、ブラウザ一本化しました。
この文書はブラウザ版のビルドと起動の手順です。

## 仕組み

- `npm run dev` で Vite の開発サーバーが `http://localhost:5173/` で
  アプリを配信します。`npm run build` で `dist/` に本番ビルドを作り、
  `npm run preview`（または任意の静的サーバー）で HTTP 配信します。
- `file://` ではなく HTTP で配信するのは、実行役の Chrome 拡張の
  content script が `http://localhost/*` / `http://127.0.0.1/*` にしか
  動かないためです。`dist/` を直接ファイルで開いても拡張連携は動きません。
- 拡張（`extension/`）は Chrome に手動で読み込みます。手順は
  `extension/README.md` を参照してください。auth_token は拡張の
  `chrome.storage.local`（ユーザーのPC内）にだけ保存されます。
- 開発サーバー・プレビューともにローカル配信のみで、LAN には公開されません。

## 前提

- Node.js 20 以上、npm
- リポジトリを clone 済みであること
- Chrome（拡張の読み込み用）

## 起動方法

```bash
npm install
npm run dev      # 開発サーバー（http://localhost:5173/）
```

本番ビルドを確認するときは：

```bash
npm run build    # 型チェック + 本番ビルド（dist/）
npm run preview  # dist/ を HTTP 配信
```

## 拡張の連携

1. Chrome で `extension/` を読み込む（`extension/README.md` 参照）。
2. アプリを開き、設定 → 実行方法（X連携）で「Chrome 拡張」を選び、
   「接続を確認」で「接続済み」になれば準備完了です。あとは同じ操作です。

## トラブルシューティング

- **拡張が見つからない**：拡張が読み込まれている Chrome でアプリを
  開いているか確認してください。アプリと拡張は同じ Chrome プロファイルで
  使う必要があります。
- **実X操作の仕組み**：投稿・チェックなどの実行方法は
  `docs/REAL_X_DESIGN.md` を参照してください。実行は拡張経由で、
  トークンは PC の中にだけ保存されます。
