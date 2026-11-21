import { describe, expect, it } from 'vitest';
import type { Account, EmailAddress } from '../db/types';
import {
  accountsWithoutEmail,
  checkEmailLinks,
  sharedEmailUsages,
  unusedEmails,
} from './emailLinkCheck';

function account(id: string, handle: string, emailId?: string | null): Account {
  return {
    id,
    handle,
    displayName: handle,
    groupId: null,
    proxyGroupId: null,
    emailId: emailId ?? null,
    status: 'logged_in',
    followers: 0,
    following: 0,
    notifications: 0,
    dmCount: 0,
    searchBan: 'unknown',
    createdAt: 1,
    updatedAt: 1,
  };
}

function email(id: string, address: string): EmailAddress {
  return { id, address, provider: 'gmail', createdAt: 1, updatedAt: 1 };
}

const EMAILS = [
  email('mail-1', 'a@gmail.com'),
  email('mail-2', 'b@outlook.com'),
  email('mail-3', 'c@yahoo.co.jp'),
];

const ACCOUNTS = [
  account('acc-1', 'user_one', 'mail-1'),
  account('acc-2', 'user_two', 'mail-1'),
  account('acc-3', 'user_three', 'mail-2'),
  account('acc-4', 'user_four'),
];

describe('accountsWithoutEmail', () => {
  it('lists accounts with no link (including dangling ids)', () => {
    const dangling = account('acc-9', 'user_nine', 'mail-gone');
    expect(accountsWithoutEmail([...ACCOUNTS, dangling], EMAILS).map((a) => a.id)).toEqual([
      'acc-4',
      'acc-9',
    ]);
  });
});

describe('sharedEmailUsages', () => {
  it('finds mail addresses used by two or more accounts', () => {
    const shared = sharedEmailUsages(ACCOUNTS, EMAILS);
    expect(shared).toHaveLength(1);
    expect(shared[0].email.id).toBe('mail-1');
    expect(shared[0].accounts.map((a) => a.id)).toEqual(['acc-1', 'acc-2']);
  });

  it('returns nothing when every address is used at most once', () => {
    expect(sharedEmailUsages(ACCOUNTS.slice(0, 1), EMAILS)).toEqual([]);
  });
});

describe('unusedEmails', () => {
  it('lists mail addresses no account references', () => {
    expect(unusedEmails(ACCOUNTS, EMAILS).map((e) => e.id)).toEqual(['mail-3']);
  });
});

describe('checkEmailLinks', () => {
  it('combines all three checks', () => {
    const result = checkEmailLinks(ACCOUNTS, EMAILS);
    expect(result.withoutEmail.map((a) => a.id)).toEqual(['acc-4']);
    expect(result.shared.map((s) => s.email.id)).toEqual(['mail-1']);
    expect(result.unused.map((e) => e.id)).toEqual(['mail-3']);
  });

  it('is empty on a fully linked ledger', () => {
    // acc-1 -> mail-1, acc-3 -> mail-2: each used once, all linked.
    const result = checkEmailLinks([ACCOUNTS[0], ACCOUNTS[2]], EMAILS.slice(0, 2));
    expect(result.withoutEmail).toEqual([]);
    expect(result.shared).toEqual([]);
    expect(result.unused).toEqual([]);
  });
});
