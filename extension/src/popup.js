/**
 * x-manager 実行役 — ポップアップ（連携アカウントの管理）。
 * ログイン中のアカウントの取り込み（Cookie を拡張が直接読む）と、
 * auth_token の手入力・保存・削除を行う。トークンはこの画面から
 * 外に出ることはない。
 */
'use strict';

/* global chrome, document, XManagerProtocol, XManagerSessions */

const listEl = document.getElementById('sessions');
const statusEl = document.getElementById('status');
const accountIdEl = document.getElementById('account-id');
const handleEl = document.getElementById('handle');
const tokenEl = document.getElementById('auth-token');

function setStatus(message, ok) {
  statusEl.textContent = message;
  statusEl.classList.toggle('ok', !!ok);
}

async function refresh() {
  const sessions = await XManagerSessions.list();
  listEl.innerHTML = '';
  if (sessions.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'まだ連携されていません。';
    listEl.appendChild(li);
    return;
  }
  for (const session of sessions) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.textContent = session.handle
      ? `@${session.handle}（${session.accountId}）`
      : session.accountId;
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.textContent = '解除';
    removeBtn.addEventListener('click', async () => {
      await XManagerSessions.remove(session.accountId);
      setStatus('連携を解除しました。', true);
      await refresh();
    });
    li.appendChild(label);
    li.appendChild(removeBtn);
    listEl.appendChild(li);
  }
}

document.getElementById('import-current').addEventListener('click', async () => {
  setStatus('取り込み中…');
  try {
    const res = await chrome.runtime.sendMessage({
      kind: 'import-current-account',
      source: XManagerProtocol.POPUP_SOURCE,
    });
    if (res && res.ok) {
      // 返ってくるのはアカウントIDとハンドルだけ（トークンの値は出ない）。
      setStatus(`@${res.handle} を取り込みました。`, true);
      await refresh();
    } else {
      setStatus(res && res.error ? res.error : '取り込みに失敗しました。');
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err));
  }
});

document.getElementById('probe-tid').addEventListener('click', async () => {
  setStatus('生成テスト中…');
  try {
    const res = await chrome.runtime.sendMessage({
      kind: 'probe-transaction-id',
      source: XManagerProtocol.POPUP_SOURCE,
    });
    if (res && res.ok) {
      setStatus('トランザクションIDを生成できました。投稿時にヘッダを付けて送れます。', true);
    } else {
      setStatus(
        `トランザクションIDを生成できませんでした：${res && res.error ? res.error : '不明なエラー'}。このまま送るとヘッダ無しになります。`,
      );
    }
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err));
  }
});

document.getElementById('add').addEventListener('click', async () => {
  const accountId = accountIdEl.value.trim();
  const authToken = tokenEl.value.trim();
  if (!accountId) {
    setStatus('アカウントIDを入力してください。');
    return;
  }
  const handle = handleEl.value.trim();
  if (!handle) {
    // ハンドル無しで連携すると、アプリ側で仮ハンドル（linked-…）が
    // 付いてチェックが必ず失敗する（2026-11-22 の 1-2）。ハンドルが
    // 分からない場合は上の「今ログイン中のアカウントを取り込む」を使う。
    setStatus('ハンドルを入力してください（@なし）。分からない場合は上の「今ログイン中のアカウントを取り込む」を使ってください。');
    return;
  }
  try {
    await XManagerSessions.set(accountId, {
      authToken,
      handle,
    });
    setStatus('連携しました。', true);
    tokenEl.value = '';
    await refresh();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err));
  }
});

refresh().catch((err) => setStatus(err instanceof Error ? err.message : String(err)));
