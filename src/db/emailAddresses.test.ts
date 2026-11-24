import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { db } from './db';
import {
  createAccount,
  createEmailAddress,
  deleteEmailAddress,
  exportAllTables,
  getEmailAddress,
  listAccountsByEmail,
  listEmailAddresses,
  replaceAllTables,
  updateEmailAddress,
} from './repository';
import { buildGroupSubset, emptyTables } from '../lib/backup';
import type { Account, EmailAddress } from './types';

async function addAccount(handle: string, emailId?: string | null) {
  return createAccount({
    handle,
    displayName: handle,
    groupId: 'grp-1',
    proxyGroupId: null,
    emailId: emailId ?? null,
    status: 'logged_in',
    followers: 0,
    following: 0,
    notifications: 0,
    dmCount: 0,
    searchBan: 'unknown',
  });
}

describe('email ledger repository (real Dexie over fake-indexeddb)', () => {
  beforeEach(async () => {
    await db.delete();
    await db.open();
  });

  it('creates, lists (sorted), updates and deletes addresses', async () => {
    const b = await createEmailAddress({
      address: 'b@outlook.com',
      label: 'サブ',
      provider: 'outlook',
    });
    const a = await createEmailAddress({
      address: 'a@gmail.com',
      provider: 'gmail',
    });
    expect((await listEmailAddresses()).map((e) => e.address)).toEqual([
      'a@gmail.com',
      'b@outlook.com',
    ]);

    await updateEmailAddress(a.id, { label: 'メイン' });
    expect((await getEmailAddress(a.id))?.label).toBe('メイン');

    await deleteEmailAddress(b.id);
    expect((await listEmailAddresses()).map((e) => e.id)).toEqual([a.id]);
  });

  it('deleting an address unlinks accounts instead of deleting them', async () => {
    const mail = await createEmailAddress({
      address: 'shared@gmail.com',
      provider: 'gmail',
    });
    const acc = await addAccount('user_one', mail.id);
    expect(await listAccountsByEmail(mail.id)).toHaveLength(1);

    await deleteEmailAddress(mail.id);

    const kept = await db.accounts.get(acc.id);
    expect(kept).toBeDefined();
    expect(kept!.emailId).toBeNull();
    expect(await listAccountsByEmail(mail.id)).toEqual([]);
    expect(await listEmailAddresses()).toEqual([]);
  });

  it('survives a full backup round-trip with the link intact', async () => {
    const mail = await createEmailAddress({
      address: 'keep@gmail.com',
      provider: 'gmail',
    });
    const acc = await addAccount('user_one', mail.id);

    const exported = await exportAllTables();
    expect(exported.emailAddresses?.map((e) => e.address)).toEqual(['keep@gmail.com']);

    await db.delete();
    await db.open();
    await replaceAllTables(exported);

    const restored = await listEmailAddresses();
    expect(restored.map((e) => e.address)).toEqual(['keep@gmail.com']);
    const account = await db.accounts.get(acc.id);
    expect(account?.emailId).toBe(restored[0].id);
  });

  it('group backups carry the mail addresses their accounts use', () => {
    const tables = emptyTables();
    tables.groups = [{ id: 'grp-1', name: 'メイン', order: 0, createdAt: 1 }];
    const mailUsed: EmailAddress = {
      id: 'mail-used', address: 'used@gmail.com', provider: 'gmail', createdAt: 1, updatedAt: 1,
    };
    const mailOther: EmailAddress = {
      id: 'mail-other', address: 'other@gmail.com', provider: 'gmail', createdAt: 1, updatedAt: 1,
    };
    tables.emailAddresses = [mailUsed, mailOther];
    const base: Omit<Account, 'id' | 'createdAt' | 'updatedAt'> = {
      handle: 'x',
      displayName: 'x',
      groupId: 'grp-1',
      proxyGroupId: null,
      status: 'logged_in',
      followers: 0,
      following: 0,
      notifications: 0,
      dmCount: 0,
      searchBan: 'unknown',
    };
    tables.accounts = [
      { ...base, id: 'acc-1', handle: 'one', emailId: 'mail-used', createdAt: 1, updatedAt: 1 },
      { ...base, id: 'acc-2', handle: 'two', emailId: null, createdAt: 1, updatedAt: 1 },
    ];

    const subset = buildGroupSubset(tables, 'grp-1');
    expect((subset.emailAddresses ?? []).map((e) => e.id)).toEqual(['mail-used']);
  });
});
