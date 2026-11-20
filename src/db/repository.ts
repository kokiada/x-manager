import { db } from './db';
import type {
  Account,
  ActionJob,
  AppSettings,
  AutomationRule,
  CheckRun,
  FollowerSnapshot,
  Group,
  InboxItem,
  NewAccount,
  NewTemplate,
  PostJob,
  PostMetric,
  ProxyGroup,
  RandomWordSet,
  Reservation,
  Template,
  TemplateGroup,
} from './types';
import { DEFAULT_SETTINGS, TEMPLATE_GROUP_MAX, TEMPLATE_MAX } from './types';
import type { RandomWordSets } from '../lib/randomText';
import type { AccountCsvPlan, GroupRef } from '../lib/accountCsv';
import type { BackupTables } from '../lib/backup';

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

/* ==================== M3: check runs & follower trend ==================== */

export async function createCheckRun(
  run: Omit<CheckRun, 'id' | 'startedAt'>,
): Promise<CheckRun> {
  const full: CheckRun = { ...run, id: uid(), startedAt: Date.now() };
  await db.checkRuns.add(full);
  return full;
}

export async function updateCheckRun(
  id: string,
  patch: Partial<Omit<CheckRun, 'id' | 'startedAt'>>,
): Promise<void> {
  await db.checkRuns.update(id, patch);
}

export async function listCheckRuns(kind?: CheckRun['kind'], limit = 20): Promise<CheckRun[]> {
  const all = await db.checkRuns.toArray();
  return all
    .filter((r) => !kind || r.kind === kind)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

/** One follower snapshot per account per day; same-day re-checks overwrite (§12-3). */
export async function recordFollowerSnapshot(
  accountId: string,
  date: string,
  followers: number,
): Promise<void> {
  await db.followerSnapshots.put({
    id: `${accountId}:${date}`,
    accountId,
    date,
    followers,
    at: Date.now(),
  });
}

export async function listFollowerSnapshots(accountId: string): Promise<FollowerSnapshot[]> {
  const all = await db.followerSnapshots.where('accountId').equals(accountId).toArray();
  return all.sort((a, b) => a.date.localeCompare(b.date));
}

/** Latest snapshot per account (for the analytics trend table). */
export async function listLatestFollowerSnapshots(): Promise<FollowerSnapshot[]> {
  const all = await db.followerSnapshots.toArray();
  const byAccount = new Map<string, FollowerSnapshot>();
  for (const s of all) {
    const prev = byAccount.get(s.accountId);
    if (!prev || s.date > prev.date) byAccount.set(s.accountId, s);
  }
  return [...byAccount.values()];
}

/* ==================== M4: action jobs & post metrics ==================== */

export async function createActionJob(
  job: Omit<ActionJob, 'id' | 'createdAt'>,
): Promise<ActionJob> {
  const full: ActionJob = { ...job, id: uid(), createdAt: Date.now() };
  await db.actionJobs.add(full);
  return full;
}

export async function updateActionJob(
  id: string,
  patch: Partial<Omit<ActionJob, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.actionJobs.update(id, patch);
}

export async function listActionJobs(limit = 30): Promise<ActionJob[]> {
  const all = await db.actionJobs.toArray();
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/** Action entries created today by one rule (for the shared daily cap, §7-2). */
export async function countTodayActionEntries(ruleId: string, dayStart: number): Promise<number> {
  const jobs = await db.actionJobs.where('ruleId').equals(ruleId).toArray();
  return jobs
    .filter((j) => j.createdAt >= dayStart)
    .reduce((n, j) => n + j.entries.filter((e) => e.status === 'done').length, 0);
}

/** Has this rule already reacted to this post? (§7-2: never twice.) */
export async function ruleActedOnPost(ruleId: string, postId: string): Promise<boolean> {
  const jobs = await db.actionJobs.where('ruleId').equals(ruleId).toArray();
  return jobs.some((j) =>
    j.entries.some((e) => e.status === 'done' && e.target.includes(postId)),
  );
}

export async function recordPostMetric(metric: PostMetric): Promise<void> {
  await db.postMetrics.put(metric);
}

export async function listPostMetrics(postId: string): Promise<PostMetric[]> {
  const all = await db.postMetrics.where('postId').equals(postId).toArray();
  return all.sort((a, b) => a.at - b.at);
}

/** Latest metrics snapshot per tracked post. */
export async function listLatestPostMetrics(): Promise<PostMetric[]> {
  const all = await db.postMetrics.toArray();
  const byPost = new Map<string, PostMetric>();
  for (const m of all) {
    const prev = byPost.get(m.postId);
    if (!prev || m.at > prev.at) byPost.set(m.postId, m);
  }
  return [...byPost.values()].sort((a, b) => b.postedAt - a.postedAt);
}

/* ======================= M4: automation rules ======================= */

export async function listAutomationRules(kind?: AutomationRule['kind']): Promise<AutomationRule[]> {
  const all = await db.automationRules.toArray();
  return all
    .filter((r) => !kind || r.kind === kind)
    .sort((a, b) => a.createdAt - b.createdAt);
}

export async function getAutomationRule(id: string): Promise<AutomationRule | undefined> {
  return db.automationRules.get(id);
}

export async function createAutomationRule(
  input: Omit<AutomationRule, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<AutomationRule> {
  const now = Date.now();
  const rule: AutomationRule = { ...input, id: uid(), createdAt: now, updatedAt: now };
  await db.automationRules.add(rule);
  return rule;
}

export async function updateAutomationRule(
  id: string,
  patch: Partial<Omit<AutomationRule, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.automationRules.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteAutomationRule(id: string): Promise<void> {
  await db.automationRules.delete(id);
}

/* ========================== M4: inbox items ========================== */

export async function addInboxItems(
  items: Omit<InboxItem, 'id'>[],
): Promise<void> {
  if (items.length === 0) return;
  await db.inboxItems.bulkAdd(items.map((i) => ({ ...i, id: uid() })));
}

export async function listInboxItems(limit = 100): Promise<InboxItem[]> {
  const all = await db.inboxItems.toArray();
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}

export async function countUnreadInbox(): Promise<number> {
  return db.inboxItems.where('read').equals(0).count();
}

export async function markInboxRead(id: string): Promise<void> {
  await db.inboxItems.update(id, { read: true });
}

export async function markAllInboxRead(): Promise<void> {
  await db.inboxItems.where('read').equals(0).modify({ read: true });
}

/* ====================== M5: settings (single row) ====================== */

/** Current app settings, with defaults filling anything unset. */
export async function getSettings(): Promise<AppSettings> {
  const row = await db.settings.get('app');
  if (!row) return { ...DEFAULT_SETTINGS };
  return {
    ...DEFAULT_SETTINGS,
    ...row.settings,
    accountCheck: { ...DEFAULT_SETTINGS.accountCheck, ...row.settings.accountCheck },
    searchBanCheck: { ...DEFAULT_SETTINGS.searchBanCheck, ...row.settings.searchBanCheck },
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  await db.settings.put({ key: 'app', settings });
}

/* ==================== M5: account CSV import apply ==================== */

/**
 * Apply a plan built by lib/accountCsv's planner: create the new
 * groups, rename / reorder existing ones, then create and update the
 * accounts — all in one transaction.
 */
export async function applyAccountCsvPlan(plan: AccountCsvPlan): Promise<void> {
  const tables = [db.groups, db.accounts];
  await db.transaction('rw', tables, async () => {
    const newGroupIdByName = new Map<string, string>();
    const existingCount = await db.groups.count();
    for (const [i, name] of plan.newGroupNames.entries()) {
      const group: Group = { id: uid(), name, order: existingCount + i, createdAt: Date.now() };
      await db.groups.add(group);
      newGroupIdByName.set(name, group.id);
    }
    for (const rename of plan.groupRenames) {
      await db.groups.update(rename.groupId, { name: rename.name });
    }
    for (const entry of plan.groupOrder) {
      await db.groups.update(entry.groupId, { order: entry.order });
    }

    const resolve = (ref: GroupRef): string | null =>
      ref.kind === 'existing' ? ref.id : ref.kind === 'new' ? (newGroupIdByName.get(ref.name) ?? null) : null;

    const now = Date.now();
    for (const op of plan.ops) {
      if (op.type === 'create') {
        const account: Account = {
          ...op.account,
          groupId: resolve(op.groupRef),
          order: op.order,
          id: uid(),
          createdAt: now,
          updatedAt: now,
        };
        await db.accounts.add(account);
      } else {
        await db.accounts.update(op.accountId, {
          displayName: op.displayName,
          groupId: resolve(op.groupRef),
          order: op.order,
          updatedAt: now,
        });
      }
    }
  });
}

/* ==================== M5: backup data operations ====================== */

const ALL_TABLES = [
  db.groups,
  db.proxyGroups,
  db.accounts,
  db.templateGroups,
  db.templates,
  db.randomWordSets,
  db.postJobs,
  db.reservations,
  db.settings,
  db.checkRuns,
  db.followerSnapshots,
  db.postMetrics,
  db.automationRules,
  db.inboxItems,
  db.actionJobs,
] as const;

/** Snapshot every table (plus settings) for a full backup. */
export async function exportAllTables(): Promise<BackupTables> {
  const [groups, proxyGroups, accounts, templateGroups, templates, randomWordSets, postJobs, reservations, checkRuns, followerSnapshots, postMetrics, automationRules, inboxItems, actionJobs] =
    await Promise.all([
      db.groups.toArray(),
      db.proxyGroups.toArray(),
      db.accounts.toArray(),
      db.templateGroups.toArray(),
      db.templates.toArray(),
      db.randomWordSets.toArray(),
      db.postJobs.toArray(),
      db.reservations.toArray(),
      db.checkRuns.toArray(),
      db.followerSnapshots.toArray(),
      db.postMetrics.toArray(),
      db.automationRules.toArray(),
      db.inboxItems.toArray(),
      db.actionJobs.toArray(),
    ]);
  const settingsRow = await db.settings.get('app');
  return {
    groups,
    proxyGroups,
    accounts,
    templateGroups,
    templates,
    randomWordSets,
    postJobs,
    reservations,
    settings: settingsRow?.settings ?? null,
    checkRuns,
    followerSnapshots,
    postMetrics,
    automationRules,
    inboxItems,
    actionJobs,
  };
}

/**
 * 置き換え (replace) restore for full backups (research §15-1):
 * every table is cleared and replaced with the backup's contents.
 */
export async function replaceAllTables(tables: BackupTables): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    for (const table of ALL_TABLES) await table.clear();
    if (tables.groups.length) await db.groups.bulkAdd(tables.groups);
    if (tables.proxyGroups.length) await db.proxyGroups.bulkAdd(tables.proxyGroups);
    if (tables.accounts.length) await db.accounts.bulkAdd(tables.accounts);
    if (tables.templateGroups.length) await db.templateGroups.bulkAdd(tables.templateGroups);
    if (tables.templates.length) await db.templates.bulkAdd(tables.templates);
    if (tables.randomWordSets.length) await db.randomWordSets.bulkAdd(tables.randomWordSets);
    if (tables.postJobs.length) await db.postJobs.bulkAdd(tables.postJobs);
    if (tables.reservations.length) await db.reservations.bulkAdd(tables.reservations);
    if (tables.checkRuns?.length) await db.checkRuns.bulkAdd(tables.checkRuns);
    if (tables.followerSnapshots?.length) await db.followerSnapshots.bulkAdd(tables.followerSnapshots);
    if (tables.postMetrics?.length) await db.postMetrics.bulkAdd(tables.postMetrics);
    if (tables.automationRules?.length) await db.automationRules.bulkAdd(tables.automationRules);
    if (tables.inboxItems?.length) await db.inboxItems.bulkAdd(tables.inboxItems);
    if (tables.actionJobs?.length) await db.actionJobs.bulkAdd(tables.actionJobs);
    if (tables.settings) await db.settings.put({ key: 'app', settings: tables.settings });
  });
}

export interface MergeResult {
  addedGroups: number;
  addedProxyGroups: number;
  addedAccounts: number;
  skippedAccounts: number;
}

/**
 * 統合 (merge) restore for group backups (research §15-2): rows whose
 * ID already exists are skipped — accounts explicitly so — and
 * nothing is ever deleted.
 */
export async function mergeGroupTables(subset: BackupTables): Promise<MergeResult> {
  const result: MergeResult = { addedGroups: 0, addedProxyGroups: 0, addedAccounts: 0, skippedAccounts: 0 };
  await db.transaction('rw', db.groups, db.proxyGroups, db.accounts, async () => {
    for (const group of subset.groups) {
      if (await db.groups.get(group.id)) continue;
      await db.groups.add(group);
      result.addedGroups++;
    }
    for (const proxy of subset.proxyGroups) {
      if (await db.proxyGroups.get(proxy.id)) continue;
      await db.proxyGroups.add(proxy);
      result.addedProxyGroups++;
    }
    for (const account of subset.accounts) {
      if (await db.accounts.get(account.id)) {
        result.skippedAccounts++;
        continue;
      }
      await db.accounts.add(account);
      result.addedAccounts++;
    }
  });
  return result;
}
