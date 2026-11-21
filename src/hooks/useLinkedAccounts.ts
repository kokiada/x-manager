import { useCallback, useEffect, useRef, useState } from 'react';
import { getSettings } from '../db/repository';
import { checkExtensionConnection } from '../executor';
import type { ExtensionSession } from '../executor/protocol';
import type { ExecutorMode } from '../db/types';

/**
 * Extension link state for the account screens.
 * Reads the saved executor mode once; when it is 'extension', asks
 * the extension (one handshake) which accounts have a session.
 * `linkedIds` / `linkedSessions` are null while unchecked or when the
 * extension is not connected — in both cases the UI shows no badges.
 * `refresh()` lets the user re-check after linking an account in the
 * extension popup, and re-reads the sessions for the import button.
 */
export interface LinkedAccountsState {
  mode: ExecutorMode | null;
  linkedIds: string[] | null;
  linkedSessions: ExtensionSession[] | null;
  refresh: () => Promise<void>;
}

export function useLinkedAccounts(): LinkedAccountsState {
  const [mode, setMode] = useState<ExecutorMode | null>(null);
  const [linkedIds, setLinkedIds] = useState<string[] | null>(null);
  const [linkedSessions, setLinkedSessions] = useState<ExtensionSession[] | null>(null);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    const settings = await getSettings().catch(() => null);
    const nextMode: ExecutorMode = settings?.executorMode ?? 'simulator';
    setMode(nextMode);
    if (nextMode !== 'extension') {
      setLinkedIds(null);
      setLinkedSessions(null);
      return;
    }
    const conn = await checkExtensionConnection();
    setLinkedIds(conn.connected ? (conn.linkedAccountIds ?? []) : null);
    setLinkedSessions(conn.connected ? (conn.linkedSessions ?? []) : null);
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void refresh();
  }, [refresh]);

  return { mode, linkedIds, linkedSessions, refresh };
}
