# x-manager アプリ版（Electron）のビルドと起動

Webアプリ（`npm run dev`）の代わりに、Windows の exe として起動する
ための手順です。アプリ版も中身は同じ Web アプリで、Electron が
`dist/` をローカルサーバーで配信してウィンドウで開きます。

## 仕組み（なぜ exe にしたのか）

- `electron/main.cjs` が `dist/` を `http://127.0.0.1:47831/`（空いていなければ
  次の空きポート）で配信し、1280×800 のウィンドウで開きます。
- `file://` ではなく HTTP で配信するのは、実行役の Chrome 拡張の
  content script が `http://localhost/*` / `http://127.0.0.1/*` にしか
  動かないためです。こうすることで拡張連携がブラウザ版とまったく
  同じように動きます。
- 拡張（`extension/`）はアプリ起動時に自動で読み込まれます
  （`session.loadExtension`）。Chrome への手動インストールは不要です。
  auth_token は Electron の拡張ストレージ（ユーザーのPC内）にだけ
  保存されます。
- サーバーは 127.0.0.1 のみにバインドされ、LAN には公開されません。

## 前提

- Windows PC（ビルドも起動も Windows 前提。`dist:win` は Windows
  ターゲットを出力します）
- Node.js 20 以上、npm
- リポジトリを clone 済みであること

## ビルド手順

```powershell
npm install
npm run dist:win
```

`npm run dist:win` は Web ビルド（`npm run build`）→ Electron
パッケージングまで一括で実行します。成果物は `release/` に出ます。

| ファイル | 内容 |
| --- | --- |
| `release/x-manager Setup 0.1.0.exe` | インストーラ（NSIS。インストール先を選べます） |
| `release/x-manager-0.1.0-portable.exe` | 単体 exe（インストール不要。そのまま起動できます） |

アイコンは `build/icons/icon.ico`（チャコール地にアンバー色の X）。
作り直す場合は `python3 scripts/make-icons.py` を実行してください
（Pillow が必要です）。

## 起動方法

1. 上のどちらかの exe をダブルクリックします。
2. 初回は Windows SmartScreen の警告が出る場合があります（コード署名を
   していないため）。「詳細情報」→「実行」を選んでください。
3. アプリが開いたら、メニューの「拡張」→「連携画面を開く」で
   auth_token を登録します（設定画面の「拡張の連携画面を開く」
   ボタンからも開けます）。
4. 設定 → 実行方法（X連携）で「Chrome 拡張」を選び、「接続を確認」で
   「接続済み」になれば準備完了です。あとはブラウザ版と同じ操作です。

## 開発中の起動（Windows）

```powershell
npm run app
```

Web ビルドして Electron を起動します。開発中の画面確認は
`npm run dev`（ブラウザ版）のままでも構いません。

## トラブルシューティング

- **ポートが使用中**：47831 が空いていない場合、アプリは自動で次の
  空きポートを使います。手動設定は不要です。
- **拡張が読み込まれない**：アプリ起動時のログに `extension loaded`
  が出るか確認してください。出ない場合は `resources/extension/`
  がパッケージに含まれているか（`extraResources` の設定）を確認します。
- **実X操作の仕組み**：投稿・チェックなどの実行方法は
  `docs/REAL_X_DESIGN.md` を参照してください。アプリ版でも実行は
  拡張経由で、トークンは PC の中にだけ保存されます。
