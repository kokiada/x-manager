/**
 * D-02: Electron 最小ホスト — エントリ。
 *
 * partition 1つで x.com を開くだけの最小構成。使い方：
 *   npm run desktop                 # x.com を開く
 *   npm run desktop -- --smoke       # 読み込み確認して終了（結果を JSON で出す）
 *   npm run desktop -- --smoke --url https://example.com/
 *
 * --smoke は終了コード 0（表示OK）/ 1（失敗）で終わる。
 * スクリーンショットは electron/smoke.png に保存する。
 */
'use strict';

const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { createHostWindow, parseArgs, runSmoke } = require('./src/host.cjs');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await app.whenReady();
  const electron = { BrowserWindow, session };
  if (args.smoke) {
    const result = await runSmoke(electron, {
      accountId: args.accountId,
      url: args.url,
      screenshotPath: path.join(__dirname, 'smoke.png'),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
    return;
  }
  await createHostWindow(electron, { accountId: args.accountId, url: args.url });
}

app.on('window-all-closed', () => {
  // Windows 向けのため、最後のウィンドウが閉じたら終了する。
  app.quit();
});

main().catch((err) => {
  console.error('[x-manager] host failed:', err);
  app.quit();
});
