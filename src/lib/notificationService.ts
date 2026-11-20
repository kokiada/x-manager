import { executor } from '../executor';
import type { Account } from '../db/types';
import { addNotifications } from '../db/repository';

/**
 * Notification / DM refresh (research §11).
 *
 * The manual only documents counts (fetched by the account check);
 * bodies are fetched on demand here through the executor and merged
 * into the notifications table (deduped by account + kind + title +
 * time). The simulator generates plausible demo items from the
 * account's current counts — see SimulatorExecutor.fetchNotifications.
 */

/** Fetch fresh items for one account and merge them. Returns new items added. */
export async function refreshNotifications(account: Account): Promise<number> {
  const items = await executor.fetchNotifications(account);
  return addNotifications(
    items.map((item) => ({
      accountId: account.id,
      handle: account.handle,
      kind: item.kind,
      title: item.title,
      body: item.body,
      fromHandle: item.fromHandle,
      at: item.at,
    })),
  );
}
