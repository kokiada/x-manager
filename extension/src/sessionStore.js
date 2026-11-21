/**
 * アカウントごとの X セッション保管庫。
 *
 * auth_token は chrome.storage.local にだけ置く（このブラウザの
 * この PC の中だけ）。Web アプリには送らないし、ネットワークにも
 * 出さない。キーは x-manager のアカウント ID。
 * 形式: { [accountId]: { authToken, handle, linkedAt } }
 */
'use strict';

/* global chrome, self */

const STORAGE_KEY = 'xmanager.sessions.v1';

const XManagerSessions = {
  async list() {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const sessions = stored[STORAGE_KEY] || {};
    return Object.entries(sessions).map(([accountId, session]) => ({
      accountId,
      handle: session.handle || '',
      linkedAt: session.linkedAt || 0,
    }));
  },

  async get(accountId) {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const sessions = stored[STORAGE_KEY] || {};
    return sessions[accountId] || null;
  },

  async set(accountId, { authToken, handle }) {
    if (typeof authToken !== 'string' || authToken.trim().length < 20) {
      throw new Error('auth_token が短すぎます（40文字の Cookie 値のはずです）');
    }
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const sessions = stored[STORAGE_KEY] || {};
    sessions[accountId] = {
      authToken: authToken.trim(),
      handle: (handle || '').replace(/^@/, ''),
      linkedAt: Date.now(),
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  },

  async remove(accountId) {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const sessions = stored[STORAGE_KEY] || {};
    delete sessions[accountId];
    await chrome.storage.local.set({ [STORAGE_KEY]: sessions });
  },
};

if (typeof self !== 'undefined') {
  self.XManagerSessions = XManagerSessions;
}
