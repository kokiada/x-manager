import Dexie, { type EntityTable } from 'dexie';
import type { Account, Group, ProxyGroup } from './types';

/**
 * On-device database (IndexedDB). Following XBoard's principle,
 * account data — including auth tokens — is stored only on this
 * device and is never transmitted to a server.
 */
export const db = new Dexie('x-manager') as Dexie & {
  groups: EntityTable<Group, 'id'>;
  proxyGroups: EntityTable<ProxyGroup, 'id'>;
  accounts: EntityTable<Account, 'id'>;
};

db.version(1).stores({
  groups: 'id, order',
  proxyGroups: 'id, name',
  accounts: 'id, handle, groupId, proxyGroupId, status',
});
