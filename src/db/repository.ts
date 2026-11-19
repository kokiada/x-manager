import { db } from './db';
import type {
  Account,
  Group,
  NewAccount,
  NewTemplate,
  PostJob,
  ProxyGroup,
  RandomWordSet,
  Reservation,
  Template,
  TemplateGroup,
} from './types';
import { TEMPLATE_GROUP_MAX, TEMPLATE_MAX } from './types';
import type { RandomWordSets } from '../lib/randomText';

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

/* ============================ M2: templates ============================ */

export async function listTemplates(): Promise<Template[]> {
  const all = await db.templates.toArray();
  return all.sort((a, b) => a.no - b.no);
}

export async function getTemplate(id: string): Promise<Template | undefined> {
  return db.templates.get(id);
}

export async function countTemplates(): Promise<number> {
  return db.templates.count();
}

/** Smallest unused template number in 1..TEMPLATE_MAX, or null when full. */
export async function nextFreeTemplateNo(): Promise<number | null> {
  const used = new Set((await db.templates.toArray()).map((t) => t.no));
  for (let n = 1; n <= TEMPLATE_MAX; n++) {
    if (!used.has(n)) return n;
  }
  return null;
}

/**
 * Create a template. Without an explicit `no`, the smallest free
 * number is assigned (deleted numbers are not renumbered, §6-3).
 * Throws when the 2,000-template cap is reached or the number is taken.
 */
export async function createTemplate(
  input: NewTemplate,
  no?: number,
): Promise<Template> {
  const count = await db.templates.count();
  if (count >= TEMPLATE_MAX) {
    throw new Error(`テンプレートは最大${TEMPLATE_MAX}件までです`);
  }
  const assigned = no ?? (await nextFreeTemplateNo());
  if (assigned === null || assigned < 1 || assigned > TEMPLATE_MAX) {
    throw new Error(`テンプレート番号は1〜${TEMPLATE_MAX}で指定してください`);
  }
  if (await db.templates.where('no').equals(assigned).first()) {
    throw new Error(`テンプレート番号 ${assigned} は既に使われています`);
  }
  const now = Date.now();
  const template: Template = {
    ...input,
    id: uid(),
    no: assigned,
    createdAt: now,
    updatedAt: now,
  };
  await db.templates.add(template);
  return template;
}

export async function updateTemplate(
  id: string,
  patch: Partial<Omit<Template, 'id' | 'no' | 'createdAt'>>,
): Promise<void> {
  await db.templates.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteTemplate(id: string): Promise<void> {
  await db.templates.delete(id);
}

/* --------------------------- template groups --------------------------- */

export async function listTemplateGroups(): Promise<TemplateGroup[]> {
  const all = await db.templateGroups.toArray();
  return all.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export async function createTemplateGroup(name: string): Promise<TemplateGroup> {
  const count = await db.templateGroups.count();
  if (count >= TEMPLATE_GROUP_MAX) {
    throw new Error(`テンプレートグループは最大${TEMPLATE_GROUP_MAX}個までです`);
  }
  const groups = await listTemplateGroups();
  const group: TemplateGroup = {
    id: uid(),
    name,
    order: groups.length,
    createdAt: Date.now(),
  };
  await db.templateGroups.add(group);
  return group;
}

export async function renameTemplateGroup(id: string, name: string): Promise<void> {
  await db.templateGroups.update(id, { name });
}

/** Deleting a group returns its templates to 未分類； they are not deleted (§6-3). */
export async function deleteTemplateGroup(id: string): Promise<void> {
  await db.transaction('rw', db.templateGroups, db.templates, async () => {
    await db.templates.where('groupId').equals(id).modify({ groupId: null });
    await db.templateGroups.delete(id);
  });
}

/* ---------------------------- random words ----------------------------- */

export async function listRandomWordSets(): Promise<RandomWordSet[]> {
  const all = await db.randomWordSets.toArray();
  return all.sort((a, b) => a.no - b.no);
}

/** Word sets in the shape lib/randomText consumes. */
export async function getRandomWordSets(): Promise<RandomWordSets> {
  const sets: Record<number, readonly string[]> = {};
  for (const s of await db.randomWordSets.toArray()) sets[s.no] = s.words;
  return sets;
}

export async function setRandomWords(no: number, words: string[]): Promise<void> {
  await db.randomWordSets.put({ no, words });
}

export async function deleteRandomWordSet(no: number): Promise<void> {
  await db.randomWordSets.delete(no);
}

/* ============================ M2: post jobs ============================ */

export async function createPostJob(
  job: Omit<PostJob, 'id' | 'createdAt'>,
): Promise<PostJob> {
  const full: PostJob = { ...job, id: uid(), createdAt: Date.now() };
  await db.postJobs.add(full);
  return full;
}

export async function getPostJob(id: string): Promise<PostJob | undefined> {
  return db.postJobs.get(id);
}

export async function updatePostJob(
  id: string,
  patch: Partial<Omit<PostJob, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.postJobs.update(id, patch);
}

export async function listPostJobs(limit = 30): Promise<PostJob[]> {
  const all = await db.postJobs.toArray();
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/* =========================== M2: reservations ========================== */

export async function createReservation(
  input: Omit<Reservation, 'id' | 'createdAt' | 'status'>,
): Promise<Reservation> {
  const reservation: Reservation = {
    ...input,
    id: uid(),
    status: 'pending',
    createdAt: Date.now(),
  };
  await db.reservations.add(reservation);
  return reservation;
}

export async function listReservations(): Promise<Reservation[]> {
  const all = await db.reservations.toArray();
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function updateReservation(
  id: string,
  patch: Partial<Omit<Reservation, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.reservations.update(id, patch);
}

/** Pending reservations whose time has come (used by the scheduler). */
export async function listDueReservations(now: number): Promise<Reservation[]> {
  const all = await db.reservations.where('status').equals('pending').toArray();
  return all
    .filter((r) => r.scheduledAt <= now)
    .sort((a, b) => a.scheduledAt - b.scheduledAt);
}
