import Dexie, { type EntityTable } from 'dexie';
import type {
  Account,
  AutoActionEvent,
  AutoActionRule,
  AutoPostRule,
  AutoPostRun,
  BanCheckResult,
  BulkAction,
  FollowerHistory,
  Group,
  MetaRow,
  NotificationItem,
  PostAnalytics,
  PostJob,
  PostTracking,
  ProxyGroup,
  RandomWordSet,
  Reservation,
  SettingsRow,
  Template,
  TemplateGroup,
} from './types';

/**
 * On-device database (IndexedDB). Following XBoard's principle,
 * account data — including auth tokens — is stored only on this
 * device and is never transmitted to a server.
 */
export const db = new Dexie('x-manager') as Dexie & {
  groups: EntityTable<Group, 'id'>;
  proxyGroups: EntityTable<ProxyGroup, 'id'>;
  accounts: EntityTable<Account, 'id'>;
  templateGroups: EntityTable<TemplateGroup, 'id'>;
  templates: EntityTable<Template, 'id'>;
  randomWordSets: EntityTable<RandomWordSet, 'no'>;
  postJobs: EntityTable<PostJob, 'id'>;
  reservations: EntityTable<Reservation, 'id'>;
  settings: EntityTable<SettingsRow, 'key'>;
  banCheckResults: EntityTable<BanCheckResult, 'id'>;
  bulkActions: EntityTable<BulkAction, 'id'>;
  autoActionRules: EntityTable<AutoActionRule, 'id'>;
  autoActionEvents: EntityTable<AutoActionEvent, 'id'>;
  postAnalytics: EntityTable<PostAnalytics, 'id'>;
  postTracking: EntityTable<PostTracking, 'id'>;
  followerHistory: EntityTable<FollowerHistory, 'id'>;
  notifications: EntityTable<NotificationItem, 'id'>;
  autoPostRules: EntityTable<AutoPostRule, 'id'>;
  autoPostRuns: EntityTable<AutoPostRun, 'id'>;
  meta: EntityTable<MetaRow, 'key'>;
};

db.version(1).stores({
  groups: 'id, order',
  proxyGroups: 'id, name',
  accounts: 'id, handle, groupId, proxyGroupId, status',
});

/* M2: bulk-post tables (templates, word lists, job log, reservations). */
db.version(2).stores({
  templateGroups: 'id, order',
  templates: 'id, no, groupId',
  randomWordSets: 'no',
  postJobs: 'id, createdAt, status',
  reservations: 'id, scheduledAt, status',
});

/* M5: app settings (plan, browser keep-alive, check schedules). */
db.version(3).stores({
  settings: 'key',
});

/* M3/M4: ban-check history, bulk/auto actions, analytics, inbox, auto-post, meta. */
db.version(4).stores({
  banCheckResults: 'id, accountId, checkedAt',
  bulkActions: 'id, createdAt, status',
  autoActionRules: 'id, createdAt',
  autoActionEvents: 'id, ruleId, at',
  postAnalytics: 'id, accountId, fetchedAt',
  postTracking: 'id, accountId, groupId, createdAt',
  followerHistory: 'id, accountId, date',
  notifications: 'id, accountId, at, read',
  autoPostRules: 'id, createdAt',
  autoPostRuns: 'id, ruleId, at',
  meta: 'key',
});
