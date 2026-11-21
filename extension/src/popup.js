/**
 * x-manager 実行役 — ポップアップ（連携アカウントの管理）。
 * auth_token の入力・保存・削除だけを行う。トークンはこの画面から
 * 外に出ることはない。
 */
'use strict';

/* global document, XManagerSessions */

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

document.getElementById('add').addEventListener('click', async () => {
  const accountId = accountIdEl.value.trim();
  const authToken = tokenEl.value.trim();
  if (!accountId) {
    setStatus('アカウントIDを入力してください。');
    return;
  }
  try {
    await XManagerSessions.set(accountId, {
      authToken,
      handle: handleEl.value.trim(),
    });
    setStatus('連携しました。', true);
    tokenEl.value = '';
    await refresh();
  } catch (err) {
    setStatus(err instanceof Error ? err.message : String(err));
  }
});

refresh().catch((err) => setStatus(err instanceof Error ? err.message : String(err)));
