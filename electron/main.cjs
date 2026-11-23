/**
 * D-02: Electron 最小ホスト — エントリ。
 *
 * partition 1つで x.com を開くだけの最小構成。使い方：
 *   npm run desktop                 # x.com を開く
 *   npm run desktop -- --smoke       # 読み込み確認して終了（結果を JSON で出す）
 *   npm run desktop -- --smoke --url https://example.com/
 *   npm run desktop -- --read-check  # ページ文脈 fetch でアカウントチェック
 *                                     # 相当の読み取りを実行（結果を JSON で出す）
 *   npm run desktop -- --post-check --text "hello"  # ページ文脈 fetch で投稿を実行
 *                                     # （結果を JSON で出す。実際に投稿するので注意）
 *
 * --smoke は終了コード 0（表示OK）/ 1（失敗）で終わる。
 * --read-check は終了コード 0（読み取りOK）/ 1（失敗）で終わるつもり
 * だが、実機では process.exitCode が app.quit() に伝わらず常に 0 で
 * 終わる既知の問題がある（--smoke / --verify-session も同じ）。
 * 成否は JSON の ok で判定すること。
 * スクリーンショットは electron/smoke.png に保存する。
 */
'use strict';

const path = require('node:path');
const { app, BrowserWindow, session } = require('electron');
const { partitionName } = require('./src/partition.cjs');
const { createHostWindow, parseArgs, runSmoke } = require('./src/host.cjs');
const { verifySession } = require('./src/session.cjs');
const { runReadCheckForAccount } = require('./src/readCheck.cjs');
const { runPostTweetForAccount } = require('./src/postTweet.cjs');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await app.whenReady();
  const electron = { BrowserWindow, session };
  if (args.postCheck) {
    // ウィンドウを開いてページ文脈で CreateTweet を fetch し、
    // { postId, postUrl } だけ確認する。実際に投稿するため、
    // --text を付けたときだけ実行する。トークンの値は出さない。
    // --proxy / --account で partition とプロキシを指定できる。
    const result = await runPostTweetForAccount(electron, {
      accountId: args.accountId,
      url: args.url,
      proxy: args.proxy ?? undefined,
      text: args.postText,
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
    return;
  }
  if (args.readCheck) {
    // ウィンドウを開いてページ文脈で verify_credentials を fetch し、
    // { id, handle } だけ確認する。トークンの値は出さない。
    // --proxy / --account で partition とプロキシを指定できる。
    const result = await runReadCheckForAccount(electron, {
      accountId: args.accountId,
      url: args.url,
      proxy: args.proxy ?? undefined,
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
    return;
  }
  if (args.verifySession) {
    // ウィンドウを開かず、partition のプロキシ解決と Cookie 有無だけ確認する。
    // Cookie の値は出さない。--proxy を渡すとそのプロキシを適用して確認する。
    const sess = session.fromPartition(partitionName(args.accountId));
    const result = await verifySession(sess, args.proxy);
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
    return;
  }
  if (args.smoke) {
    const result = await runSmoke(electron, {
      accountId: args.accountId,
      url: args.url,
      proxy: args.proxy ?? undefined,
      screenshotPath: path.join(__dirname, 'smoke.png'),
    });
    console.log(JSON.stringify(result));
    process.exitCode = result.ok ? 0 : 1;
    app.quit();
    return;
  }
  await createHostWindow(electron, {
    accountId: args.accountId,
    url: args.url,
    proxy: args.proxy ?? undefined,
  });
}

app.on('window-all-closed', () => {
  // Windows 向けのため、最後のウィンドウが閉じたら終了する。
  app.quit();
});

main().catch((err) => {
  console.error('[x-manager] host failed:', err);
  app.quit();
});
