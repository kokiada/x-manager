import { db } from '../db/db';
import type { Account } from '../db/types';
import {
  SEED_ACCOUNTS,
  SEED_GROUPS,
  SEED_PROXY_GROUPS,
  SEED_RANDOM_WORD_SETS,
  SEED_TEMPLATE_GROUPS,
  SEED_TEMPLATES,
} from '../db/seed';

/**
 * Demo seed data — identification & cleanup.
 *
 * `seedIfEmpty()` inserts 12 fictional accounts (plus groups, proxy
 * groups, templates and word sets) so every screen works before real
 * accounts are registered. Once a real account is linked, the demo
 * rows are in the way, so Settings offers 「デモデータを消去」.
 *
 * Identification must work for installs seeded before this file
 * existed, so it relies on the seed's own fingerprints, not on a
 * marker written at seed time:
 * - accounts: seed id (acc-01..acc-12), seed handle, or a
 *   `demo-…` placeholder auth token
 * - groups / proxy groups / template groups / templates: seed ids
 * - random word sets: seed number AND the exact seed word list
 *   (a user's own set with the same number is never deleted)
 *
 * Nothing user-created is ever matched: real accounts get
 * `uid()` ids and never carry a `demo-` token.
 */

export const DEMO_DATA_CLEARED_KEY = 'demoDataCleared';

const SEED_ACCOUNT_IDS = new Set(SEED_ACCOUNTS.map((a) => a.id));
const SEED_ACCOUNT_HANDLES = new Set(SEED_ACCOUNTS.map((a) => a.handle));
const SEED_GROUP_IDS = new Set(SEED_GROUPS.map((g) => g.id));
const SEED_PROXY_GROUP_IDS = new Set(SEED_PROXY_GROUPS.map((p) => p.id));
const SEED_TEMPLATE_GROUP_IDS = new Set(SEED_TEMPLATE_GROUPS.map((g) => g.id));
const SEED_TEMPLATE_IDS = new Set(SEED_TEMPLATES.map((t) => t.id));
const SEED_WORD_SETS = new Map(
  SEED_RANDOM_WORD_SETS.map((s) => [s.no, s.words] as const),
);

export function isDemoAccount(account: Pick<Account, 'id' | 'handle' | 'authToken'>): boolean {
  return (
    SEED_ACCOUNT_IDS.has(account.id) ||
    SEED_ACCOUNT_HANDLES.has(account.handle) ||
    (account.authToken?.startsWith('demo-') ?? false)
  );
}

export function isDemoGroupId(id: string | null): boolean {
  return id !== null && SEED_GROUP_IDS.has(id);
}

export function isDemoProxyGroupId(id: string | null): boolean {
  return id !== null && SEED_PROXY_GROUP_IDS.has(id);
}

export function isDemoTemplateGroupId(id: string | null): boolean {
  return id !== null && SEED_TEMPLATE_GROUP_IDS.has(id);
}

export function isDemoTemplateId(id: string): boolean {
  return SEED_TEMPLATE_IDS.has(id);
}

/** A word set is demo data only when number AND words match the seed exactly. */
export function isDemoRandomWordSet(no: number, words: readonly string[]): boolean {
  const seed = SEED_WORD_SETS.get(no);
  return (
    seed !== undefined &&
    seed.length === words.length &&
    seed.every((w, i) => w === words[i])
  );
}

/** What `clearDemoData` removed, for the confirmation toast. */
export interface DemoCleanupResult {
  accountsRemoved: number;
  groupsRemoved: number;
  proxyGroupsRemoved: number;
  templatesRemoved: number;
  templateGroupsRemoved: number;
  randomWordSetsRemoved: number;
  followerHistoryRemoved: number;
  notificationsRemoved: number;
  postAnalyticsRemoved: number;
  banCheckResultsRemoved: number;
  postTrackingRemoved: number;
  postJobsRemoved: number;
  reservationsRemoved: number;
  bulkActionsRemoved: number;
  autoActionRulesRemoved: number;
  autoActionEventsRemoved: number;
  autoPostRulesRemoved: number;
  autoPostRunsRemoved: number;
}

/**
 * Delete every demo-seeded row and its dependents. Real (user-added)
 * rows are untouched. Afterwards `seedIfEmpty()` will not re-add the
 * demo data (see the `demoDataCleared` meta flag).
 */
export async function clearDemoData(): Promise<DemoCleanupResult> {
  const result: DemoCleanupResult = {
    accountsRemoved: 0,
    groupsRemoved: 0,
    proxyGroupsRemoved: 0,
    templatesRemoved: 0,
    templateGroupsRemoved: 0,
    randomWordSetsRemoved: 0,
    followerHistoryRemoved: 0,
    notificationsRemoved: 0,
    postAnalyticsRemoved: 0,
    banCheckResultsRemoved: 0,
    postTrackingRemoved: 0,
    postJobsRemoved: 0,
    reservationsRemoved: 0,
    bulkActionsRemoved: 0,
    autoActionRulesRemoved: 0,
    autoActionEventsRemoved: 0,
    autoPostRulesRemoved: 0,
    autoPostRunsRemoved: 0,
  };

  const demoAccountIds = new Set(
    (await db.accounts.toArray()).filter(isDemoAccount).map((a) => a.id),
  );
  const isDemo = (accountId: string) => demoAccountIds.has(accountId);

  // 1) Accounts + seed-only groups/proxy groups.
  // (Dexie's typed transaction() caps its table arguments, so the
  // cleanup runs as several small transactions.)
  await db.transaction(
    'rw',
    db.accounts,
    db.groups,
    db.proxyGroups,
    db.meta,
    async () => {
      result.accountsRemoved = await db.accounts
        .where('id')
        .anyOf([...demoAccountIds])
        .delete();

      // A demo group / proxy group survives only if a real account
      // still references it (e.g. the user moved their own account
      // into a seeded group).
      const remaining = await db.accounts.toArray();
      const usedGroupIds = new Set(remaining.map((a) => a.groupId));
      const usedProxyIds = new Set(remaining.map((a) => a.proxyGroupId));
      const demoGroups = await db.groups.where('id').anyOf([...SEED_GROUP_IDS]).toArray();
      const groupsToDelete = demoGroups
        .filter((g) => !usedGroupIds.has(g.id))
        .map((g) => g.id);
      await db.groups.bulkDelete(groupsToDelete);
      result.groupsRemoved = groupsToDelete.length;
      const demoProxies = await db.proxyGroups
        .where('id')
        .anyOf([...SEED_PROXY_GROUP_IDS])
        .toArray();
      const proxiesToDelete = demoProxies
        .filter((p) => !usedProxyIds.has(p.id))
        .map((p) => p.id);
      await db.proxyGroups.bulkDelete(proxiesToDelete);
      result.proxyGroupsRemoved = proxiesToDelete.length;

      // Remember the choice so an emptied database is not re-seeded.
      await db.meta.put({ key: DEMO_DATA_CLEARED_KEY, value: 'true' });
    },
  );

  // 1b) Seed-only templates / template groups / word sets.
  await db.transaction(
    'rw',
    db.templates,
    db.templateGroups,
    db.randomWordSets,
    async () => {
      result.templatesRemoved = await db.templates
        .where('id')
        .anyOf([...SEED_TEMPLATE_IDS])
        .delete();
      // Read the survivors AFTER deleting the seed templates: a demo
      // template group referenced only by a deleted template is free.
      const remainingTemplates = await db.templates.toArray();
      const usedTemplateGroupIds = new Set(
        remainingTemplates.map((t) => t.groupId),
      );
      const demoTemplateGroups = await db.templateGroups
        .where('id')
        .anyOf([...SEED_TEMPLATE_GROUP_IDS])
        .toArray();
      const templateGroupsToDelete = demoTemplateGroups
        .filter((g) => !usedTemplateGroupIds.has(g.id))
        .map((g) => g.id);
      await db.templateGroups.bulkDelete(templateGroupsToDelete);
      result.templateGroupsRemoved = templateGroupsToDelete.length;

      const wordSets = await db.randomWordSets.toArray();
      const wordSetsToDelete = wordSets
        .filter((s) => isDemoRandomWordSet(s.no, s.words))
        .map((s) => s.no);
      await db.randomWordSets.bulkDelete(wordSetsToDelete);
      result.randomWordSetsRemoved = wordSetsToDelete.length;
    },
  );

  // 2) Account-scoped rows: delete anything that belongs to a demo account.
  await db.transaction(
    'rw',
    db.banCheckResults,
    db.followerHistory,
    db.notifications,
    db.postAnalytics,
    db.postTracking,
    async () => {
      result.banCheckResultsRemoved = await db.banCheckResults
        .where('accountId')
        .anyOf([...demoAccountIds])
        .delete();
      result.followerHistoryRemoved = await db.followerHistory
        .where('accountId')
        .anyOf([...demoAccountIds])
        .delete();
      result.notificationsRemoved = await db.notifications
        .where('accountId')
        .anyOf([...demoAccountIds])
        .delete();
      result.postAnalyticsRemoved = await db.postAnalytics
        .where('accountId')
        .anyOf([...demoAccountIds])
        .delete();
      result.postTrackingRemoved = await db.postTracking
        .where('accountId')
        .anyOf([...demoAccountIds])
        .delete();
    },
  );

  // 3) Jobs / rules that reference accounts: drop demo entries, and
  // drop the whole row when nothing real is left in it.
  await db.transaction(
    'rw',
    db.postJobs,
    db.reservations,
    db.bulkActions,
    async () => {
      for (const job of await db.postJobs.toArray()) {
        const kept = job.entries.filter((e) => !isDemo(e.accountId));
        if (kept.length === 0) {
          await db.postJobs.delete(job.id);
          result.postJobsRemoved++;
        } else if (kept.length !== job.entries.length) {
          await db.postJobs.update(job.id, { entries: kept });
        }
      }
      for (const r of await db.reservations.toArray()) {
        const kept = r.accountIds.filter((id) => !isDemo(id));
        if (kept.length === 0) {
          await db.reservations.delete(r.id);
          result.reservationsRemoved++;
        } else if (kept.length !== r.accountIds.length) {
          await db.reservations.update(r.id, { accountIds: kept });
        }
      }
      for (const action of await db.bulkActions.toArray()) {
        const keptIds = action.accountIds.filter((id) => !isDemo(id));
        const keptEntries = action.entries.filter((e) => !isDemo(e.accountId));
        if (keptIds.length === 0) {
          await db.bulkActions.delete(action.id);
          result.bulkActionsRemoved++;
        } else if (
          keptIds.length !== action.accountIds.length ||
          keptEntries.length !== action.entries.length
        ) {
          await db.bulkActions.update(action.id, {
            accountIds: keptIds,
            entries: keptEntries,
          });
        }
      }
    },
  );

  // 3b) Auto-action / auto-post rules and runs.
  await db.transaction(
    'rw',
    db.autoActionRules,
    db.autoActionEvents,
    db.autoPostRules,
    db.autoPostRuns,
    async () => {
      for (const rule of await db.autoActionRules.toArray()) {
        const trigger = rule.triggerAccountIds.filter((id) => !isDemo(id));
        const acting = rule.actingAccountIds.filter((id) => !isDemo(id));
        if (trigger.length === 0 && acting.length === 0) {
          await db.autoActionRules.delete(rule.id);
          result.autoActionRulesRemoved++;
        } else if (
          trigger.length !== rule.triggerAccountIds.length ||
          acting.length !== rule.actingAccountIds.length
        ) {
          await db.autoActionRules.update(rule.id, {
            triggerAccountIds: trigger,
            actingAccountIds: acting,
          });
        }
      }
      // autoActionEvents has no actingAccountId index — filter in memory.
      const demoEvents = (await db.autoActionEvents.toArray()).filter((e) =>
        isDemo(e.actingAccountId),
      );
      await db.autoActionEvents.bulkDelete(demoEvents.map((e) => e.id));
      result.autoActionEventsRemoved = demoEvents.length;
      for (const rule of await db.autoPostRules.toArray()) {
        const kept = rule.accountIds.filter((id) => !isDemo(id));
        if (kept.length === 0) {
          await db.autoPostRules.delete(rule.id);
          result.autoPostRulesRemoved++;
        } else if (kept.length !== rule.accountIds.length) {
          await db.autoPostRules.update(rule.id, { accountIds: kept });
        }
      }
      // autoPostRuns has no accountId index — filter in memory.
      const demoRuns = (await db.autoPostRuns.toArray()).filter((r) =>
        isDemo(r.accountId),
      );
      await db.autoPostRuns.bulkDelete(demoRuns.map((r) => r.id));
      result.autoPostRunsRemoved = demoRuns.length;
    },
  );

  return result;
}

/** True when the user has cleared the demo data (never re-seed). */
export async function isDemoDataCleared(): Promise<boolean> {
  const row = await db.meta.get(DEMO_DATA_CLEARED_KEY);
  return row?.value === 'true';
}
