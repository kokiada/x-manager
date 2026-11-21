/**
 * Which accounts the Chrome extension has a session for.
 * Pure helpers so the badge logic is unit-testable without a browser.
 */

/** The extension's linked account IDs as a lookup set. */
export function linkedAccountSet(linkedIds: readonly string[] | undefined): Set<string> {
  return new Set(linkedIds ?? []);
}

/** True when the account's auth_token is registered in the extension. */
export function isLinkedAccount(
  linkedIds: readonly string[] | undefined,
  accountId: string,
): boolean {
  return linkedAccountSet(linkedIds).has(accountId);
}
