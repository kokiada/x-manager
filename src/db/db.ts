import Dexie, { type EntityTable } from 'dexie';
import type {
  Account,
  Group,
  PostJob,
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
