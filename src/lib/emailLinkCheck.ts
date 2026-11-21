import type { Account, EmailAddress } from '../db/types';

/**
 * Mail-ledger link checks (pure functions, no DB access).
 *
 * 1. accounts without a linked mail address
 * 2. one mail address shared by several accounts
 * 3. mail addresses no account uses
 *
 * The mail screen shows all three so the operator can spot a missing
 * link, an over-shared address, or a dead address at a glance.
 */

export interface SharedEmailUsage {
  email: EmailAddress;
  accounts: Account[];
}

export interface EmailLinkCheckResult {
  /** Accounts with no emailId (or an emailId that no longer exists). */
  withoutEmail: Account[];
  /** Mail addresses linked from two or more accounts. */
  shared: SharedEmailUsage[];
  /** Mail addresses no account references. */
  unused: EmailAddress[];
}

export function accountsWithoutEmail(
  accounts: readonly Account[],
  emails: readonly EmailAddress[],
): Account[] {
  const known = new Set(emails.map((e) => e.id));
  return accounts.filter((a) => !a.emailId || !known.has(a.emailId));
}

export function sharedEmailUsages(
  accounts: readonly Account[],
  emails: readonly EmailAddress[],
): SharedEmailUsage[] {
  const byId = new Map(emails.map((e) => [e.id, e] as const));
  const grouped = new Map<string, Account[]>();
  for (const account of accounts) {
    if (!account.emailId || !byId.has(account.emailId)) continue;
    const list = grouped.get(account.emailId) ?? [];
    list.push(account);
    grouped.set(account.emailId, list);
  }
  return [...grouped.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([emailId, list]) => ({
      email: byId.get(emailId)!,
      accounts: [...list].sort((a, b) => a.handle.localeCompare(b.handle)),
    }))
    .sort((a, b) => a.email.address.localeCompare(b.email.address));
}

export function unusedEmails(
  accounts: readonly Account[],
  emails: readonly EmailAddress[],
): EmailAddress[] {
  const used = new Set(
    accounts.map((a) => a.emailId).filter((id): id is string => !!id),
  );
  return emails
    .filter((e) => !used.has(e.id))
    .sort((a, b) => a.address.localeCompare(b.address));
}

export function checkEmailLinks(
  accounts: readonly Account[],
  emails: readonly EmailAddress[],
): EmailLinkCheckResult {
  return {
    withoutEmail: accountsWithoutEmail(accounts, emails),
    shared: sharedEmailUsages(accounts, emails),
    unused: unusedEmails(accounts, emails),
  };
}
