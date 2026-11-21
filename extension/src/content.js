/**
 * x-manager 実行役 — content script（中継）。
 *
 * Web アプリのページと background の間を window.postMessage と
 * chrome.runtime.sendMessage でつなぐ。ページ側のメッセージは
 * source が `x-manager` のものだけ受け取る。トークンはここを
 * 通らない（ジョブの指示と結果だけ）。
 */
'use strict';

/* global chrome, XManagerProtocol, XManagerProtocolHelpers */

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!XManagerProtocolHelpers.isPageMessage(data)) return;

  chrome.runtime.sendMessage(data, (response) => {
    // 拡張が無効化された場合など、応答がないこともある。
    if (chrome.runtime.lastError || response === undefined) return;
    window.postMessage(response, '*');
  });
});
