import Dexie, { type EntityTable } from 'dexie';
import type {
  Account,
  ActionJob,
  AutomationRule,
  CheckRun,
  FollowerSnapshot,
  Group,
  InboxItem,
  PostJob,
  PostMetric,
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
  checkRuns: EntityTable<CheckRun, 'id'>;
  followerSnapshots: EntityTable<FollowerSnapshot, 'id'>;
  postMetrics: EntityTable<PostMetric, 'id'>;
  automationRules: EntityTable<AutomationRule, 'id'>;
  inboxItems: EntityTable<InboxItem, 'id'>;
  actionJobs: EntityTable<ActionJob, 'id'>;
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

/* M3/M4: check history, follower trend, metrics, automation, inbox, action jobs. */
db.version(4).stores({
  checkRuns: 'id, kind, startedAt',
  followerSnapshots: 'id, accountId, date',
  postMetrics: 'id, postId, at',
  automationRules: 'id, kind, enabled',
  inboxItems: 'id, accountId, kind, at, read',
  actionJobs: 'id, kind, createdAt, ruleId',
});
