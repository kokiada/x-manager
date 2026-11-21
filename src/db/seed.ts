import { db } from './db';
import type {
  Account,
  EmailAddress,
  Group,
  ProxyGroup,
  RandomWordSet,
  Template,
  TemplateGroup,
} from './types';

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

/**
 * Demo mail addresses (mail ledger). mail-01 is shared by two accounts
 * and mail-03 is unused, so the link checks on the mail screen have
 * something to show on a fresh install.
 */
export const SEED_EMAILS: EmailAddress[] = [
  {
    id: 'mail-01', address: 'kashima.main@gmail.com',
    label: 'メイン運用', provider: 'gmail', createdAt: now, updatedAt: now,
  },
  {
    id: 'mail-02', address: 'kashima.sub@outlook.com',
    label: 'サブ運用', provider: 'outlook', createdAt: now, updatedAt: now,
  },
  {
    id: 'mail-03', address: 'kashima.lab@yahoo.co.jp',
    label: '検証用（未使用）', provider: 'yahoo', createdAt: now, updatedAt: now,
  },
];

export const SEED_ACCOUNTS: Account[] = [
  {
    id: 'acc-01', handle: 'kashima_soccer_jp', displayName: '鹿島サッカー情報',
    groupId: 'grp-main', proxyGroupId: 'px-tokyo-1', emailId: 'mail-01', status: 'logged_in',
    authToken: demoToken('01'), followers: 12480, following: 312,
    notifications: 14, dmCount: 2, searchBan: 'visible',
    memo: '主力アカウント', lastCheckedAt: hoursAgo(1), createdAt: now, updatedAt: now,
  },
  {
    id: 'acc-02', handle: 'antlers_daily', displayName: 'アントラーズ速報',
    groupId: 'grp-main', proxyGroupId: 'px-tokyo-1', emailId: 'mail-01', status: 'logged_in',
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
    groupId: 'grp-main', proxyGroupId: 'px-tokyo-2', emailId: 'mail-02', status: 'logged_in',
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

export const SEED_TEMPLATE_GROUPS: TemplateGroup[] = [
  { id: 'tg-regular', name: '定期告知', order: 0, createdAt: now },
  { id: 'tg-match', name: '試合日', order: 1, createdAt: now },
];

export const SEED_TEMPLATES: Template[] = [
  {
    id: 'tpl-01', no: 1, title: '朝のあいさつ（ランダム文言）',
    body: '[Random1] 今日も一日よろしくお願いします。',
    groupId: 'tg-regular', media: [], poll: null, thread: [],
    createdAt: now, updatedAt: now,
  },
  {
    id: 'tpl-02', no: 2, title: '試合日ツリー告知',
    body: '本日は試合日です。キックオフは19:00、現地組もリモート組も一緒に盛り上がりましょう！',
    groupId: 'tg-match', media: [], poll: null,
    thread: ['チケット・アクセス情報は公式サイトをご確認ください。', '試合後の感想はこのスレッドでどうぞ。'],
    createdAt: now, updatedAt: now,
  },
  {
    id: 'tpl-03', no: 3, title: '注目選手アンケート',
    body: '今節の注目選手は誰ですか？',
    groupId: null, media: [], poll: { choices: ['FW', 'MF', 'DF', 'GK'] }, thread: [],
    createdAt: now, updatedAt: now,
  },
];

export const SEED_RANDOM_WORD_SETS: RandomWordSet[] = [
  { no: 1, words: ['おはようございます！', 'おはようございます、本日もよろしくお願いします。', 'おはようございます。良い一日にしましょう。'] },
  { no: 2, words: ['行ってきます', '行ってらっしゃい'] },
];

/**
 * Populate the database with demo data when it is completely empty.
 * Never re-seeds after the user cleared the demo data (Settings →
 * 「デモデータを消去」 writes the `demoDataCleared` meta flag).
 */
export async function seedIfEmpty(): Promise<void> {
  const cleared = await db.meta.get('demoDataCleared');
  if (cleared?.value === 'true') return;
  const count = await db.accounts.count();
  if (count > 0) return;
  await db.transaction('rw', db.groups, db.proxyGroups, db.accounts, db.emailAddresses, async () => {
    await db.groups.bulkAdd(SEED_GROUPS);
    await db.proxyGroups.bulkAdd(SEED_PROXY_GROUPS);
    await db.accounts.bulkAdd(SEED_ACCOUNTS);
    await db.emailAddresses.bulkAdd(SEED_EMAILS);
  });
  await db.transaction('rw', db.templateGroups, db.templates, db.randomWordSets, async () => {
    await db.templateGroups.bulkAdd(SEED_TEMPLATE_GROUPS);
    await db.templates.bulkAdd(SEED_TEMPLATES);
    await db.randomWordSets.bulkAdd(SEED_RANDOM_WORD_SETS);
  });
  await seedFollowerHistoryIfEmpty();
}

/* --------------------- follower history seed (M4, §12-3) --------------------- */

/** Deterministic PRNG so the seeded trend looks the same on every fresh install. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Seed ~60 days of plausible follower history per account (only when
 * the table is empty). A random walk backwards from today's count,
 * with a few gaps left out so the chart's dashed-gap rendering has
 * something to show.
 */
export async function seedFollowerHistoryIfEmpty(): Promise<void> {
  if ((await db.followerHistory.count()) > 0) return;
  const dayMs = 24 * 3600_000;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const pad = (v: number) => String(v).padStart(2, '0');
  const rows: { id: string; accountId: string; date: string; followers: number }[] = [];
  for (const account of SEED_ACCOUNTS) {
    const rng = mulberry32(hashSeed(account.id));
    let followers = account.followers;
    for (let back = 0; back < 60; back++) {
      const d = new Date(today.getTime() - back * dayMs);
      const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      // Occasionally skip a day (app was closed) — the chart renders
      // the gap as a dashed segment (§12-3).
      if (back > 0 && rng() < 0.06) continue;
      if (back > 0) {
        // Walk backwards: older counts are a little lower on average.
        followers = Math.max(0, Math.round(followers * (1 - (rng() - 0.42) * 0.02)));
      }
      rows.push({
        id: `fh-seed-${account.id}-${date}`,
        accountId: account.id,
        date,
        followers,
      });
    }
  }
  await db.followerHistory.bulkAdd(rows);
}
