import { db } from './db';
import type { Account, Group, ProxyGroup } from './types';

/**
 * Demo seed data — clearly fictional accounts used so every screen
 * works end to end before real accounts are registered.
 * Auth tokens below are placeholders, not real credentials.
 */

const now = Date.now();
const hoursAgo = (h: number) => now - h * 3600_000;

export const SEED_GROUPS: Group[] = [
  { id: 'grp-main', name: 'メイン運用', order: 0, createdAt: now },
  { id: 'grp-reply', name: 'リプ運用', order: 1, createdAt: now },
  { id: 'grp-lab', name: '検証用', order: 2, createdAt: now },
];

export const SEED_PROXY_GROUPS: ProxyGroup[] = [
  {
    id: 'px-tokyo-1',
    name: '東京プロキシ A',
    host: 'proxy-a.example.jp',
    port: 8080,
    username: 'demo-user-a',
    note: '公式プロキシ想定（デモ）',
    createdAt: now,
  },
  {
    id: 'px-tokyo-2',
    name: '東京プロキシ B',
    host: 'proxy-b.example.jp',
    port: 3128,
    note: '予備回線（デモ）',
    createdAt: now,
  },
];

const demoToken = (seed: string) => `demo-${seed}-not-a-real-token-0000000000`;

export const SEED_ACCOUNTS: Account[] = [
  {
    id: 'acc-01', handle: 'kashima_soccer_jp', displayName: '鹿島サッカー情報',
    groupId: 'grp-main', proxyGroupId: 'px-tokyo-1', status: 'logged_in',
    authToken: demoToken('01'), followers: 12480, following: 312,
    notifications: 14, dmCount: 2, searchBan: 'visible',
    memo: '主力アカウント', lastCheckedAt: hoursAgo(1), createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-02', handle: 'antlers_daily', displayName: 'アントラーズ速報',
    groupId: 'grp-main', proxyGroupId: 'px-tokyo-1', status: 'logged_in',
    authToken: demoToken('02'), followers: 8930, following: 205,
    notifications: 31, dmCount: 5, searchBan: 'visible',
    lastCheckedAt: hoursAgo(1), createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-03', handle: 'jleague_watch', displayName: 'Jリーグウォッチ',
    groupId: 'grp-main', proxyGroupId: 'px-tokyo-1', status: 'logged_in',
    followers: 34210, following: 480, notifications: 0, dmCount: 0,
    searchBan: 'topic_hidden', memo: '話題タブ非表示を監視中',
    lastCheckedAt: hoursAgo(2), createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-04', handle: 'stadium_gourmet', displayName: 'スタグル部',
    groupId: 'grp-main', proxyGroupId: 'px-tokyo-2', status: 'logged_in',
    authToken: demoToken('04'), followers: 5210, following: 640,
    notifications: 7, dmCount: 1, searchBan: 'visible',
    lastCheckedAt: hoursAgo(3), createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-05', handle: 'reply_squad_01', displayName: 'リプ隊 01',
    groupId: 'grp-reply', proxyGroupId: 'px-tokyo-2', status: 'logged_in',
    authToken: demoToken('05'), followers: 890, following: 1500,
    notifications: 3, dmCount: 0, searchBan: 'visible',
    lastCheckedAt: hoursAgo(1), createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-06', handle: 'reply_squad_02', displayName: 'リプ隊 02',
    groupId: 'grp-reply', proxyGroupId: 'px-tokyo-2', status: 'locked',
    authToken: demoToken('06'), followers: 640, following: 1320,
    notifications: 0, dmCount: 0, searchBan: 'unknown',
    memo: 'ロック解除手続きが必要', lastCheckedAt: hoursAgo(5),
    createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-07', handle: 'reply_squad_03', displayName: 'リプ隊 03',
    groupId: 'grp-reply', proxyGroupId: null, status: 'logged_out',
    followers: 410, following: 980, notifications: 0, dmCount: 0,
    searchBan: 'unknown', lastCheckedAt: hoursAgo(26),
    createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-08', handle: 'promo_outreach_x', displayName: '告知用アカウント',
    groupId: 'grp-reply', proxyGroupId: 'px-tokyo-1', status: 'frozen',
    authToken: demoToken('08'), followers: 1980, following: 760,
    notifications: 0, dmCount: 0, searchBan: 'both_hidden',
    memo: '凍結中。異議申立て検討', lastCheckedAt: hoursAgo(8),
    createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-09', handle: 'lab_sandbox_01', displayName: '検証サンドボックス 01',
    groupId: 'grp-lab', proxyGroupId: null, status: 'logged_in',
    authToken: demoToken('09'), followers: 23, following: 45,
    notifications: 1, dmCount: 0, searchBan: 'visible',
    lastCheckedAt: hoursAgo(1), createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-10', handle: 'lab_sandbox_02', displayName: '検証サンドボックス 02',
    groupId: 'grp-lab', proxyGroupId: 'px-tokyo-2', status: 'connection_error',
    followers: 12, following: 30, notifications: 0, dmCount: 0,
    searchBan: 'unknown', memo: 'プロキシ応答なし。要確認',
    lastCheckedAt: hoursAgo(4), createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-11', handle: 'lab_sandbox_03', displayName: '検証サンドボックス 03',
    groupId: 'grp-lab', proxyGroupId: null, status: 'logged_out',
    followers: 5, following: 18, notifications: 0, dmCount: 0,
    searchBan: 'unknown', createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-12', handle: 'matchday_live_jp', displayName: 'マッチデーライブ',
    groupId: 'grp-main', proxyGroupId: 'px-tokyo-1', status: 'logged_in',
    authToken: demoToken('12'), followers: 21750, following: 154,
    notifications: 58, dmCount: 9, searchBan: 'visible',
    memo: '試合日に実況投稿', lastCheckedAt: hoursAgo(1),
    createdAt: now, updatedAt: now,
  },
];

/** Populate the database with demo data when it is completely empty. */
export async function seedIfEmpty(): Promise<void> {
  const count = await db.accounts.count();
  if (count > 0) return;
  await db.transaction('rw', db.groups, db.proxyGroups, db.accounts, async () => {
    await db.groups.bulkAdd(SEED_GROUPS);
    await db.proxyGroups.bulkAdd(SEED_PROXY_GROUPS);
    await db.accounts.bulkAdd(SEED_ACCOUNTS);
  });
}
