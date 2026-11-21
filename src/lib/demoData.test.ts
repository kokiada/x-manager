import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from '../db/db';
import { seedIfEmpty } from '../db/seed';
import type { AutoPostRule, BanCheckResult, FollowerHistory, NotificationItem, PostJob, Reservation } from '../db/types';
import {
  clearDemoData,
  isDemoAccount,
  isDemoRandomWordSet,
  isDemoDataCleared,
} from './demoData';
import { isLinkedAccount, linkedAccountSet } from './extensionLink';

const REAL_ID = 'real-user-1';

async function addRealAccount() {
  await db.accounts.add({
    id: REAL_ID,
    handle: 'my_real_account',
    displayName: '自分のアカウント',
    groupId: null,
    proxyGroupId: null,
    status: 'logged_in',
    authToken: 'real-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    followers: 100,
    following: 50,
    notifications: 0,
    dmCount: 0,
    searchBan: 'visible',
    createdAt: 1,
    updatedAt: 1,
  });
}

const payload = {
  segments: ['こんにちは'],
  targetType: 'normal' as const,
  media: [],
  mediaMode: 'all' as const,
  poll: null,
  replyPermission: 'everyone' as const,
  paidPartnership: false,
};

describe('isDemoAccount', () => {
  it('matches seed ids, seed handles and demo- tokens', () => {
    expect(isDemoAccount({ id: 'acc-01', handle: 'whatever', authToken: undefined })).toBe(true);
    expect(isDemoAccount({ id: 'some-id', handle: 'kashima_soccer_jp', authToken: undefined })).toBe(true);
    expect(isDemoAccount({ id: 'some-id', handle: 'x', authToken: 'demo-99-not-a-real-token-0000000000' })).toBe(true);
  });

  it('does not match a real account', () => {
    expect(
      isDemoAccount({ id: REAL_ID, handle: 'my_real_account', authToken: 'real-token-aaaa' }),
    ).toBe(false);
  });
});

describe('isDemoRandomWordSet', () => {
  it('matches only the exact seed words', () => {
    expect(
      isDemoRandomWordSet(1, ['おはようございます！', 'おはようございます、本日もよろしくお願いします。', 'おはようございます。良い一日にしましょう。']),
    ).toBe(true);
    expect(isDemoRandomWordSet(1, ['おはようございます！'])).toBe(false);
    expect(isDemoRandomWordSet(3, ['おはようございます！'])).toBe(false);
  });
});

describe('linkedAccountSet / isLinkedAccount', () => {
  it('builds a lookup set and answers membership', () => {
    expect(linkedAccountSet(['a', 'b']).has('a')).toBe(true);
    expect(isLinkedAccount(['a'], 'a')).toBe(true);
    expect(isLinkedAccount(['a'], 'b')).toBe(false);
    expect(isLinkedAccount(undefined, 'a')).toBe(false);
  });
});

describe('clearDemoData (real Dexie over fake-indexeddb)', () => {
  beforeEach(async () => {
    await db.delete();
    // delete() closes the database; reopen it before seeding.
    await db.open();
    await seedIfEmpty();
    await addRealAccount();
    // Dependent rows: one demo-owned and one real-owned each.
    await db.followerHistory.bulkAdd([
      { id: 'fh-demo', accountId: 'acc-01', date: '2026-11-01', followers: 10 },
      { id: 'fh-real', accountId: REAL_ID, date: '2026-11-01', followers: 100 },
    ] satisfies FollowerHistory[]);
    await db.banCheckResults.bulkAdd([
      { id: 'bc-demo', accountId: 'acc-01', handle: 'kashima_soccer_jp', checkedByAccountId: 'acc-02', topicVisible: true, latestVisible: true, checkedAt: 1 },
      { id: 'bc-real', accountId: REAL_ID, handle: 'my_real_account', checkedByAccountId: REAL_ID, topicVisible: true, latestVisible: true, checkedAt: 1 },
    ] satisfies BanCheckResult[]);
    await db.notifications.bulkAdd([
      { id: 'nt-demo', accountId: 'acc-01', handle: 'kashima_soccer_jp', kind: 'notification', title: 'demo', body: '', at: 1, read: false },
      { id: 'nt-real', accountId: REAL_ID, handle: 'my_real_account', kind: 'notification', title: 'real', body: '', at: 1, read: false },
    ] satisfies NotificationItem[]);
    await db.postJobs.add({
      id: 'job-mixed',
      kind: 'immediate',
      status: 'done',
      payload,
      intervalSec: 5,
      entries: [
        { accountId: 'acc-01', handle: 'kashima_soccer_jp', status: 'done' },
        { accountId: REAL_ID, handle: 'my_real_account', status: 'done' },
      ],
      createdAt: 1,
      startedAt: 1,
    } satisfies PostJob);
    await db.reservations.add({
      id: 'res-demo',
      status: 'pending',
      scheduledAt: 2,
      accountIds: ['acc-01'],
      payload,
      intervalSec: 5,
      createdAt: 1,
    } satisfies Reservation);
    await db.autoPostRules.add({
      id: 'rule-mixed',
      name: 'mixed',
      enabled: true,
      accountIds: ['acc-01', REAL_ID],
      templateId: 'tpl-01',
      mode: 'random_window',
      createdAt: 1,
      updatedAt: 1,
    } satisfies AutoPostRule);
  });

  it('removes demo accounts and their dependents, keeps real data', async () => {
    const result = await clearDemoData();

    expect(result.accountsRemoved).toBe(12);
    expect((await db.accounts.toArray()).map((a) => a.id)).toEqual([REAL_ID]);
    // Seed-only groups/proxies/templates go too (no real account uses them).
    expect(await db.groups.count()).toBe(0);
    expect(await db.proxyGroups.count()).toBe(0);
    expect(await db.templates.count()).toBe(0);
    expect(await db.templateGroups.count()).toBe(0);
    expect(await db.randomWordSets.count()).toBe(0);
    // Account-scoped rows: demo rows gone, real rows kept.
    expect((await db.followerHistory.toArray()).map((r) => r.id)).toEqual(['fh-real']);
    expect((await db.banCheckResults.toArray()).map((r) => r.id)).toEqual(['bc-real']);
    expect((await db.notifications.toArray()).map((r) => r.id)).toEqual(['nt-real']);
    // Mixed job/rule: demo entries filtered out, the row itself kept.
    const job = await db.postJobs.get('job-mixed');
    expect(job?.entries.map((e) => e.accountId)).toEqual([REAL_ID]);
    const rule = await db.autoPostRules.get('rule-mixed');
    expect(rule?.accountIds).toEqual([REAL_ID]);
    // Demo-only reservation is gone entirely.
    expect(await db.reservations.count()).toBe(0);
    // The flag is set so the demo data is not re-seeded.
    expect(await isDemoDataCleared()).toBe(true);
  });

  it('does not re-seed after cleanup', async () => {
    await clearDemoData();
    await seedIfEmpty();
    expect((await db.accounts.toArray()).map((a) => a.id)).toEqual([REAL_ID]);
  });

  it('is a no-op (except the flag) when no demo data exists', async () => {
    await clearDemoData();
    const second = await clearDemoData();
    expect(second.accountsRemoved).toBe(0);
    expect((await db.accounts.toArray()).map((a) => a.id)).toEqual([REAL_ID]);
  });
});
