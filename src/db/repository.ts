import { db } from './db';
import type { Account, Group, NewAccount, ProxyGroup } from './types';

const uid = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

/* ------------------------------ accounts ------------------------------ */

export async function listAccounts(): Promise<Account[]> {
  const all = await db.accounts.toArray();
  return all.sort((a, b) => a.handle.localeCompare(b.handle));
}

export async function getAccount(id: string): Promise<Account | undefined> {
  return db.accounts.get(id);
}

export async function createAccount(input: NewAccount): Promise<Account> {
  const now = Date.now();
  const account: Account = { ...input, id: uid(), createdAt: now, updatedAt: now };
  await db.accounts.add(account);
  return account;
}

export async function updateAccount(
  id: string,
  patch: Partial<Omit<Account, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.accounts.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteAccount(id: string): Promise<void> {
  await db.accounts.delete(id);
}

/* ------------------------------- groups ------------------------------- */

export async function listGroups(): Promise<Group[]> {
  const all = await db.groups.toArray();
  return all.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export async function createGroup(name: string): Promise<Group> {
  const groups = await listGroups();
  const group: Group = {
    id: uid(),
    name,
    order: groups.length,
    createdAt: Date.now(),
  };
  await db.groups.add(group);
  return group;
}

export async function renameGroup(id: string, name: string): Promise<void> {
  await db.groups.update(id, { name });
}

/** Deleting a group un-assigns its accounts (they are not deleted). */
export async function deleteGroup(id: string): Promise<void> {
  await db.transaction('rw', db.groups, db.accounts, async () => {
    await db.accounts.where('groupId').equals(id).modify({ groupId: null });
    await db.groups.delete(id);
  });
}

/* ---------------------------- proxy groups ---------------------------- */

export async function listProxyGroups(): Promise<ProxyGroup[]> {
  const all = await db.proxyGroups.toArray();
  return all.sort((a, b) => a.name.localeCompare(b.name));
}

export async function createProxyGroup(
  input: Omit<ProxyGroup, 'id' | 'createdAt'>,
): Promise<ProxyGroup> {
  const group: ProxyGroup = { ...input, id: uid(), createdAt: Date.now() };
  await db.proxyGroups.add(group);
  return group;
}

export async function updateProxyGroup(
  id: string,
  patch: Partial<Omit<ProxyGroup, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.proxyGroups.update(id, patch);
}

/**
 * Deleting a proxy group un-assigns every account that used it.
 * Per XBoard's behaviour, accounts never fall back to a direct
 * connection silently in the data model — the assignment is cleared
 * and the operator re-assigns explicitly.
 */
export async function deleteProxyGroup(id: string): Promise<void> {
  await db.transaction('rw', db.proxyGroups, db.accounts, async () => {
    await db.accounts.where('proxyGroupId').equals(id).modify({ proxyGroupId: null });
    await db.proxyGroups.delete(id);
  });
}

export async function countAccountsByProxyGroup(proxyGroupId: string): Promise<number> {
  return db.accounts.where('proxyGroupId').equals(proxyGroupId).count();
}
