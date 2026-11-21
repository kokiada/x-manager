import type { EntityTable } from 'dexie';
import { db } from './db';
import type {
  Account,
  AppSettings,
  AutoActionEvent,
  AutoActionRule,
  AutoPostRule,
  AutoPostRun,
  BanCheckResult,
  BulkAction,
  EmailAddress,
  FollowerHistory,
  Group,
  NewAccount,
  NewEmailAddress,
  NewTemplate,
  NotificationItem,
  PostAnalytics,
  PostJob,
  PostTracking,
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

/* --------------------------- mail ledger ------------------------------ */

export async function listEmailAddresses(): Promise<EmailAddress[]> {
  const all = await db.emailAddresses.toArray();
  return all.sort((a, b) => a.address.localeCompare(b.address));
}

export async function getEmailAddress(id: string): Promise<EmailAddress | undefined> {
  return db.emailAddresses.get(id);
}

export async function createEmailAddress(
  input: NewEmailAddress,
): Promise<EmailAddress> {
  const now = Date.now();
  const row: EmailAddress = { ...input, id: uid(), createdAt: now, updatedAt: now };
  await db.emailAddresses.add(row);
  return row;
}

export async function updateEmailAddress(
  id: string,
  patch: Partial<Omit<EmailAddress, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.emailAddresses.update(id, { ...patch, updatedAt: Date.now() });
}

/**
 * Delete a mail address. Accounts linked to it are unlinked
 * (emailId -> null) — the accounts themselves are never deleted.
 */
export async function deleteEmailAddress(id: string): Promise<void> {
  await db.transaction('rw', db.accounts, db.emailAddresses, async () => {
    await db.accounts.where('emailId').equals(id).modify({ emailId: null });
    await db.emailAddresses.delete(id);
  });
}

/** Accounts linked to one mail address (mail ledger screen). */
export async function listAccountsByEmail(emailId: string): Promise<Account[]> {
  const all = await db.accounts.where('emailId').equals(emailId).toArray();
  return all.sort((a, b) => a.handle.localeCompare(b.handle));
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
  db.banCheckResults,
  db.bulkActions,
  db.autoActionRules,
  db.autoActionEvents,
  db.postAnalytics,
  db.postTracking,
  db.followerHistory,
  db.notifications,
  db.autoPostRules,
  db.autoPostRuns,
  db.meta,
  db.emailAddresses,
] as const;

/** Snapshot every table (plus settings) for a full backup. */
export async function exportAllTables(): Promise<BackupTables> {
  const [
    groups,
    proxyGroups,
    accounts,
    templateGroups,
    templates,
    randomWordSets,
    postJobs,
    reservations,
    banCheckResults,
    bulkActions,
    autoActionRules,
    autoActionEvents,
    postAnalytics,
    postTracking,
    followerHistory,
    notifications,
    autoPostRules,
    autoPostRuns,
    meta,
    emailAddresses,
  ] = await Promise.all([
    db.groups.toArray(),
    db.proxyGroups.toArray(),
    db.accounts.toArray(),
    db.templateGroups.toArray(),
    db.templates.toArray(),
    db.randomWordSets.toArray(),
    db.postJobs.toArray(),
    db.reservations.toArray(),
    db.banCheckResults.toArray(),
    db.bulkActions.toArray(),
    db.autoActionRules.toArray(),
    db.autoActionEvents.toArray(),
    db.postAnalytics.toArray(),
    db.postTracking.toArray(),
    db.followerHistory.toArray(),
    db.notifications.toArray(),
    db.autoPostRules.toArray(),
    db.autoPostRuns.toArray(),
    db.meta.toArray(),
    db.emailAddresses.toArray(),
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
    banCheckResults,
    bulkActions,
    autoActionRules,
    autoActionEvents,
    postAnalytics,
    postTracking,
    followerHistory,
    notifications,
    autoPostRules,
    autoPostRuns,
    meta,
    emailAddresses,
  };
}

/**
 * 置き換え (replace) restore for full backups (research §15-1):
 * every table is cleared and replaced with the backup's contents.
 */
export async function replaceAllTables(tables: BackupTables): Promise<void> {
  await db.transaction('rw', ALL_TABLES, async () => {
    for (const table of ALL_TABLES) await table.clear();
    // `?? []` covers backups written before the M3/M4 tables existed.
    if (tables.groups.length) await db.groups.bulkAdd(tables.groups);
    if (tables.proxyGroups.length) await db.proxyGroups.bulkAdd(tables.proxyGroups);
    if (tables.accounts.length) await db.accounts.bulkAdd(tables.accounts);
    if (tables.templateGroups.length) await db.templateGroups.bulkAdd(tables.templateGroups);
    if (tables.templates.length) await db.templates.bulkAdd(tables.templates);
    if (tables.randomWordSets.length) await db.randomWordSets.bulkAdd(tables.randomWordSets);
    if (tables.postJobs.length) await db.postJobs.bulkAdd(tables.postJobs);
    if (tables.reservations.length) await db.reservations.bulkAdd(tables.reservations);
    if (tables.settings) await db.settings.put({ key: 'app', settings: tables.settings });
    if ((tables.banCheckResults ?? []).length) await db.banCheckResults.bulkAdd(tables.banCheckResults!);
    if ((tables.bulkActions ?? []).length) await db.bulkActions.bulkAdd(tables.bulkActions!);
    if ((tables.autoActionRules ?? []).length) await db.autoActionRules.bulkAdd(tables.autoActionRules!);
    if ((tables.autoActionEvents ?? []).length) await db.autoActionEvents.bulkAdd(tables.autoActionEvents!);
    if ((tables.postAnalytics ?? []).length) await db.postAnalytics.bulkAdd(tables.postAnalytics!);
    if ((tables.postTracking ?? []).length) await db.postTracking.bulkAdd(tables.postTracking!);
    if ((tables.followerHistory ?? []).length) await db.followerHistory.bulkAdd(tables.followerHistory!);
    if ((tables.notifications ?? []).length) await db.notifications.bulkAdd(tables.notifications!);
    if ((tables.autoPostRules ?? []).length) await db.autoPostRules.bulkAdd(tables.autoPostRules!);
    if ((tables.autoPostRuns ?? []).length) await db.autoPostRuns.bulkAdd(tables.autoPostRuns!);
    if ((tables.meta ?? []).length) await db.meta.bulkAdd(tables.meta!);
    if ((tables.emailAddresses ?? []).length) await db.emailAddresses.bulkAdd(tables.emailAddresses!);
  });
}

export interface MergeResult {
  addedGroups: number;
  addedProxyGroups: number;
  addedAccounts: number;
  skippedAccounts: number;
  /** Account-scoped rows merged alongside the group's accounts. */
  addedBanCheckResults: number;
  addedFollowerHistory: number;
  addedNotifications: number;
  addedPostAnalytics: number;
  addedPostTracking: number;
  /** Mail addresses linked to the merged accounts. */
  addedEmailAddresses: number;
}

/**
 * 統合 (merge) restore for group backups (research §15-2): rows whose
 * ID already exists are skipped — accounts explicitly so — and
 * nothing is ever deleted.
 */
export async function mergeGroupTables(subset: BackupTables): Promise<MergeResult> {
  const result: MergeResult = {
    addedGroups: 0,
    addedProxyGroups: 0,
    addedAccounts: 0,
    skippedAccounts: 0,
    addedBanCheckResults: 0,
    addedFollowerHistory: 0,
    addedNotifications: 0,
    addedPostAnalytics: 0,
    addedPostTracking: 0,
    addedEmailAddresses: 0,
  };
  // Dexie's typed transaction() caps its table arguments, so the
  // merge runs as two transactions: core rows first, then the
  // account-scoped rows that travel with them.
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
  const mergeRows = async <T extends { id: string }>(
    table: EntityTable<T, 'id'>,
    rows: T[] | undefined,
    counter: keyof MergeResult,
  ) => {
    // Dexie's typed get()/add() do not resolve against a generic
    // row type, so both calls go through a minimal structural type
    // (the rows themselves stay typed T).
    const ops = table as unknown as {
      get: (id: string) => Promise<T | undefined>;
      add: (row: T) => Promise<unknown>;
    };
    for (const row of rows ?? []) {
      if (await ops.get(row.id)) continue;
      await ops.add(row);
      (result[counter] as number)++;
    }
  };
  await db.transaction(
    'rw',
    db.banCheckResults,
    db.followerHistory,
    db.notifications,
    db.postAnalytics,
    db.postTracking,
    async () => {
      await mergeRows(db.banCheckResults, subset.banCheckResults, 'addedBanCheckResults');
      await mergeRows(db.followerHistory, subset.followerHistory, 'addedFollowerHistory');
      await mergeRows(db.notifications, subset.notifications, 'addedNotifications');
      await mergeRows(db.postAnalytics, subset.postAnalytics, 'addedPostAnalytics');
      await mergeRows(db.postTracking, subset.postTracking, 'addedPostTracking');
    },
  );
  await db.transaction('rw', db.emailAddresses, async () => {
    await mergeRows(db.emailAddresses, subset.emailAddresses, 'addedEmailAddresses');
  });
  return result;
}

/* ================= M3/M4: ban checks, bulk actions, analytics, inbox ================ */

/** Local 'YYYY-MM-DD' for a timestamp (device timezone). */
export function localDateString(ts: number): string {
  const d = new Date(ts);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* ------------------------------- meta -------------------------------- */

export async function getMeta<T>(key: string, fallback: T): Promise<T> {
  const row = await db.meta.get(key);
  if (!row) return fallback;
  try {
    return JSON.parse(row.value) as T;
  } catch {
    return fallback;
  }
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value: JSON.stringify(value) });
}

/* ---------------------------- ban checks ----------------------------- */

export async function recordBanCheckResult(
  input: Omit<BanCheckResult, 'id'>,
): Promise<BanCheckResult> {
  const row: BanCheckResult = { ...input, id: uid() };
  await db.banCheckResults.add(row);
  return row;
}

export async function listBanCheckResults(limit = 50): Promise<BanCheckResult[]> {
  const all = await db.banCheckResults.toArray();
  return all.sort((a, b) => b.checkedAt - a.checkedAt).slice(0, limit);
}

/** Latest ban-check verdict for an account, or undefined when never checked. */
export async function latestBanCheckFor(accountId: string): Promise<BanCheckResult | undefined> {
  const rows = await db.banCheckResults.where('accountId').equals(accountId).toArray();
  return rows.sort((a, b) => b.checkedAt - a.checkedAt)[0];
}

/* ---------------------------- bulk actions --------------------------- */

export async function createBulkAction(
  input: Omit<BulkAction, 'id' | 'createdAt' | 'status' | 'entries'>,
): Promise<BulkAction> {
  const job: BulkAction = {
    ...input,
    id: uid(),
    status: 'running',
    entries: [],
    createdAt: Date.now(),
  };
  await db.bulkActions.add(job);
  return job;
}

export async function updateBulkAction(
  id: string,
  patch: Partial<Omit<BulkAction, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.bulkActions.update(id, patch);
}

export async function listBulkActions(limit = 20): Promise<BulkAction[]> {
  const all = await db.bulkActions.toArray();
  return all.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit);
}

/* --------------------------- auto-action rules ------------------------ */

export async function listAutoActionRules(): Promise<AutoActionRule[]> {
  const all = await db.autoActionRules.toArray();
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function createAutoActionRule(
  input: Omit<AutoActionRule, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<AutoActionRule> {
  const now = Date.now();
  const rule: AutoActionRule = { ...input, id: uid(), createdAt: now, updatedAt: now };
  await db.autoActionRules.add(rule);
  return rule;
}

export async function updateAutoActionRule(
  id: string,
  patch: Partial<Omit<AutoActionRule, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.autoActionRules.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteAutoActionRule(id: string): Promise<void> {
  await db.autoActionRules.delete(id);
}

/* --------------------------- auto-action events ----------------------- */

/** Append an event; the feed is trimmed to the latest 200 rows. */
export async function addAutoActionEvent(
  input: Omit<AutoActionEvent, 'id'>,
): Promise<AutoActionEvent> {
  const event: AutoActionEvent = { ...input, id: uid() };
  await db.autoActionEvents.add(event);
  const count = await db.autoActionEvents.count();
  if (count > 200) {
    const oldest = await db.autoActionEvents.orderBy('at').limit(count - 200).toArray();
    await db.autoActionEvents.bulkDelete(oldest.map((e) => e.id));
  }
  return event;
}

export async function listAutoActionEvents(limit = 100): Promise<AutoActionEvent[]> {
  const all = await db.autoActionEvents.toArray();
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}

/** Actions executed today (status 'done'), across all rules — the shared daily cap (§7-2). */
export async function countAutoActionEventsToday(now = Date.now()): Promise<number> {
  const from = startOfDay(now);
  const all = await db.autoActionEvents.where('at').aboveOrEqual(from).toArray();
  return all.filter((e) => e.status === 'done').length;
}

/* ---------------------------- post analytics -------------------------- */

/** Replace the stored analytics snapshot for one account with a fresh fetch. */
export async function savePostAnalytics(
  accountId: string,
  rows: Omit<PostAnalytics, 'id'>[],
): Promise<void> {
  await db.transaction('rw', db.postAnalytics, async () => {
    await db.postAnalytics.where('accountId').equals(accountId).delete();
    if (rows.length > 0) {
      await db.postAnalytics.bulkAdd(rows.map((r) => ({ ...r, id: uid() })));
    }
  });
}

export async function listPostAnalytics(
  accountId: string,
  limit = 2000,
): Promise<PostAnalytics[]> {
  const rows = await db.postAnalytics.where('accountId').equals(accountId).toArray();
  return rows.sort((a, b) => b.postedAt - a.postedAt).slice(0, limit);
}

/* ----------------------------- post tracking -------------------------- */

export async function createPostTracking(
  input: Omit<PostTracking, 'id' | 'createdAt'>,
): Promise<PostTracking> {
  const row: PostTracking = { ...input, id: uid(), createdAt: Date.now() };
  await db.postTracking.add(row);
  // Research §12-2: keep at most 10,000 tracked posts, newest first.
  const count = await db.postTracking.count();
  if (count > 10_000) {
    const oldest = await db.postTracking.orderBy('createdAt').limit(count - 10_000).toArray();
    await db.postTracking.bulkDelete(oldest.map((t) => t.id));
  }
  return row;
}

export async function updatePostTracking(
  id: string,
  patch: Partial<Omit<PostTracking, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.postTracking.update(id, patch);
}

export async function listPostTracking(groupId?: string): Promise<PostTracking[]> {
  const all = groupId
    ? await db.postTracking.where('groupId').equals(groupId).toArray()
    : await db.postTracking.toArray();
  return all.sort((a, b) => b.postedAt - a.postedAt);
}

/* ---------------------------- follower history ------------------------ */

/** Upsert today's follower count for an account (one row per day, §12-3). */
export async function recordFollowerHistory(
  accountId: string,
  followers: number,
  date = localDateString(Date.now()),
): Promise<void> {
  const existing = await db.followerHistory
    .where('accountId')
    .equals(accountId)
    .filter((r) => r.date === date)
    .first();
  if (existing) {
    await db.followerHistory.update(existing.id, { followers });
  } else {
    const row: FollowerHistory = { id: uid(), accountId, date, followers };
    await db.followerHistory.add(row);
  }
  // Research §12-3: keep at most 400 days per account.
  const rows = await db.followerHistory.where('accountId').equals(accountId).toArray();
  if (rows.length > 400) {
    const sorted = rows.sort((a, b) => a.date.localeCompare(b.date));
    await db.followerHistory.bulkDelete(sorted.slice(0, rows.length - 400).map((r) => r.id));
  }
}

export async function listFollowerHistory(
  accountId: string,
  fromDate?: string,
): Promise<FollowerHistory[]> {
  const rows = await db.followerHistory.where('accountId').equals(accountId).toArray();
  return rows
    .filter((r) => !fromDate || r.date >= fromDate)
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ----------------------------- notifications -------------------------- */

/**
 * Merge freshly fetched items, deduping on (accountId, kind, title, at).
 * Returns the number of newly added items.
 */
export async function addNotifications(
  items: Omit<NotificationItem, 'id' | 'read'>[],
): Promise<number> {
  const existing = await db.notifications.toArray();
  const keys = new Set(existing.map((n) => `${n.accountId}|${n.kind}|${n.title}|${n.at}`));
  const fresh = items.filter((i) => !keys.has(`${i.accountId}|${i.kind}|${i.title}|${i.at}`));
  if (fresh.length > 0) {
    await db.notifications.bulkAdd(
      fresh.map((i) => ({ ...i, id: uid(), read: false })),
    );
  }
  return fresh.length;
}

export async function listNotifications(
  accountId?: string,
  limit = 200,
): Promise<NotificationItem[]> {
  const all = accountId
    ? await db.notifications.where('accountId').equals(accountId).toArray()
    : await db.notifications.toArray();
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}

export async function countUnreadNotifications(accountId?: string): Promise<number> {
  const all = accountId
    ? await db.notifications.where('accountId').equals(accountId).toArray()
    : await db.notifications.toArray();
  return all.filter((n) => !n.read).length;
}

export async function markNotificationRead(id: string): Promise<void> {
  await db.notifications.update(id, { read: true });
}

export async function markAllNotificationsRead(accountId?: string): Promise<void> {
  const all = accountId
    ? await db.notifications.where('accountId').equals(accountId).toArray()
    : await db.notifications.toArray();
  const unread = all.filter((n) => !n.read);
  if (unread.length > 0) {
    await db.notifications.bulkPut(unread.map((n) => ({ ...n, read: true })));
  }
}

/* ------------------------------ auto-post ----------------------------- */

export async function listAutoPostRules(): Promise<AutoPostRule[]> {
  const all = await db.autoPostRules.toArray();
  return all.sort((a, b) => a.createdAt - b.createdAt);
}

export async function createAutoPostRule(
  input: Omit<AutoPostRule, 'id' | 'createdAt' | 'updatedAt'>,
): Promise<AutoPostRule> {
  const now = Date.now();
  const rule: AutoPostRule = { ...input, id: uid(), createdAt: now, updatedAt: now };
  await db.autoPostRules.add(rule);
  return rule;
}

export async function updateAutoPostRule(
  id: string,
  patch: Partial<Omit<AutoPostRule, 'id' | 'createdAt'>>,
): Promise<void> {
  await db.autoPostRules.update(id, { ...patch, updatedAt: Date.now() });
}

export async function deleteAutoPostRule(id: string): Promise<void> {
  await db.autoPostRules.delete(id);
}

export async function addAutoPostRun(
  input: Omit<AutoPostRun, 'id'>,
): Promise<AutoPostRun> {
  const run: AutoPostRun = { ...input, id: uid() };
  await db.autoPostRuns.add(run);
  return run;
}

export async function listAutoPostRuns(limit = 100): Promise<AutoPostRun[]> {
  const all = await db.autoPostRuns.toArray();
  return all.sort((a, b) => b.at - a.at).slice(0, limit);
}
