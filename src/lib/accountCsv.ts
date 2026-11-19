import type { Account, Group, NewAccount, ProxyGroup } from '../db/types';
import { parseCsv, toCsv } from './csv';

/**
 * Group / account organizing CSV (research §5-1,
 * 「アプリケーション設定 → データ・契約 → アカウントをCSVで編集」).
 *
 * Format — one row per account, row order = display order in group:
 *   グループ名, グループID, アカウント名, アカウントID, XログインID,
 *   Xログインパスワード, 2FA認証トークン, AuthToken, プロキシ表示名, メモ1
 *
 * Rules implemented (from the research):
 * - Export is UTF-8 with BOM; import accepts UTF-8 and Shift_JIS.
 * - The header row must match exactly — a changed header fails the
 *   whole import.
 * - グループID empty = new group (created under グループ名; an existing
 *   group with the same name is reused). アカウントID empty = new
 *   account.
 * - The credential columns (XログインID / Xログインパスワード /
 *   2FA認証トークン / AuthToken / プロキシ表示名 / メモ1) apply ONLY
 *   when an account is created. Putting any of them on a row for an
 *   existing account is an error and the row is skipped.
 * - Existing accounts can only change display name, group and order.
 *   Accounts are never deleted by CSV.
 * - グループID also renames the group when グループ名 differs.
 */

export const ACCOUNT_CSV_HEADER = [
  'グループ名',
  'グループID',
  'アカウント名',
  'アカウントID',
  'XログインID',
  'Xログインパスワード',
  '2FA認証トークン',
  'AuthToken',
  'プロキシ表示名',
  'メモ1',
] as const;

/* ------------------------------ decoding ------------------------------ */

/**
 * Decode CSV file bytes. UTF-8 (with or without BOM) is tried first;
 * bytes that are not valid UTF-8 fall back to Shift_JIS, matching the
 * encodings XBoard accepts on import.
 */
export function decodeCsvBytes(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('shift_jis').decode(bytes);
  }
}

/* ------------------------------- export ------------------------------- */

export function accountsToCsv(
  accounts: readonly Account[],
  groups: readonly Group[],
  proxyGroups: readonly ProxyGroup[],
): string {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const proxyNameById = new Map(proxyGroups.map((p) => [p.id, p.name]));

  const inGroupOrder = (list: Account[]) =>
    [...list].sort(
      (a, b) => (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) || a.handle.localeCompare(b.handle),
    );

  const ordered: Account[] = [];
  for (const g of [...groups].sort((a, b) => a.order - b.order)) {
    ordered.push(...inGroupOrder(accounts.filter((a) => a.groupId === g.id)));
  }
  ordered.push(...inGroupOrder(accounts.filter((a) => !a.groupId || !groupById.has(a.groupId))));

  const rows: string[][] = [[...ACCOUNT_CSV_HEADER]];
  for (const a of ordered) {
    const group = a.groupId ? groupById.get(a.groupId) : undefined;
    rows.push([
      group?.name ?? '',
      group?.id ?? '',
      a.displayName,
      a.id,
      a.loginId ?? '',
      a.loginPassword ?? '',
      a.twoFactorSecret ?? '',
      a.authToken ?? '',
      a.proxyGroupId ? (proxyNameById.get(a.proxyGroupId) ?? '') : '',
      a.memo ?? '',
    ]);
  }
  // XBoard exports UTF-8 with BOM so Excel opens it correctly.
  return '\uFEFF' + toCsv(rows);
}

/* ------------------------------- parsing ------------------------------ */

export interface AccountCsvRow {
  /** 1-based line number in the file (header is line 1). */
  line: number;
  groupName: string;
  groupId: string;
  displayName: string;
  accountId: string;
  loginId: string;
  loginPassword: string;
  twoFactorSecret: string;
  authToken: string;
  proxyName: string;
  memo: string;
}

export function parseAccountCsv(text: string): AccountCsvRow[] {
  const raw = parseCsv(text).filter((r) => r.some((c) => c.trim() !== ''));
  if (raw.length === 0) throw new Error('CSVにデータがありません');
  const header = raw[0].map((c) => c.trim());
  const expected = [...ACCOUNT_CSV_HEADER];
  if (header.length !== expected.length || header.some((c, i) => c !== expected[i])) {
    throw new Error(
      `見出し行が正しくありません（期待値: ${expected.join(',')}）。見出しを変更したCSVは取り込めません`,
    );
  }
  return raw.slice(1).map((cells, i) => {
    const get = (ix: number) => (cells[ix] ?? '').trim();
    return {
      line: i + 2,
      groupName: get(0),
      groupId: get(1),
      displayName: get(2),
      accountId: get(3),
      loginId: get(4),
      loginPassword: get(5),
      twoFactorSecret: get(6),
      authToken: get(7),
      proxyName: get(8),
      memo: get(9),
    };
  });
}

/* ------------------------------ planning ------------------------------ */

/** Where an imported account lands: an existing group, a group the
 *  import creates (referenced by name), or ungrouped. */
export type GroupRef =
  | { kind: 'existing'; id: string }
  | { kind: 'new'; name: string }
  | { kind: 'none' };

export type AccountCsvOp =
  | {
      type: 'create';
      line: number;
      groupRef: GroupRef;
      /** Order within the target group (CSV row order). */
      order: number;
      account: NewAccount;
    }
  | {
      type: 'update';
      line: number;
      accountId: string;
      groupRef: GroupRef;
      order: number;
      displayName: string;
    };

export interface AccountCsvRowResult {
  line: number;
  status: 'created' | 'updated' | 'skipped';
  message: string;
}

export interface AccountCsvPlan {
  ops: AccountCsvOp[];
  /** Existing groups to rename (グループID + different グループ名). */
  groupRenames: { groupId: string; name: string }[];
  /** Display order for existing groups, by first appearance in the file. */
  groupOrder: { groupId: string; order: number }[];
  /** Names of groups the import will create. */
  newGroupNames: string[];
  results: AccountCsvRowResult[];
}

export interface AccountCsvSnapshot {
  accounts: readonly Account[];
  groups: readonly Group[];
  proxyGroups: readonly ProxyGroup[];
}

const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

/** Derive an X handle for a newly created account from its login ID. */
function deriveHandle(row: AccountCsvRow): string | null {
  const fromLogin = row.loginId.replace(/^@/, '');
  if (HANDLE_PATTERN.test(fromLogin)) return fromLogin;
  // An e-mail / phone login ID cannot be a handle; sanitize what we can.
  const sanitized = fromLogin.replace(/[^A-Za-z0-9_]/g, '').slice(0, 15);
  return sanitized ? sanitized : null;
}

export function planAccountCsvImport(
  rows: readonly AccountCsvRow[],
  snapshot: AccountCsvSnapshot,
): AccountCsvPlan {
  const accountById = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const groupById = new Map(snapshot.groups.map((g) => [g.id, g]));
  const groupByName = new Map(snapshot.groups.map((g) => [g.name, g]));
  const proxyByName = new Map(snapshot.proxyGroups.map((p) => [p.name, p]));
  const usedHandles = new Set(snapshot.accounts.map((a) => a.handle.toLowerCase()));

  const ops: AccountCsvOp[] = [];
  const results: AccountCsvRowResult[] = [];
  const groupRenames = new Map<string, string>();
  const groupOrder = new Map<string, number>();
  const newGroupNames: string[] = [];
  const orderCounters = new Map<string, number>();

  const nextOrder = (ref: GroupRef): number => {
    const key = ref.kind === 'existing' ? `id:${ref.id}` : ref.kind === 'new' ? `new:${ref.name}` : 'none';
    const n = orderCounters.get(key) ?? 0;
    orderCounters.set(key, n + 1);
    return n;
  };

  const resolveGroup = (row: AccountCsvRow): GroupRef | { error: string } => {
    if (row.groupId) {
      const group = groupById.get(row.groupId);
      if (!group) return { error: `グループID「${row.groupId}」が見つかりません` };
      if (!groupOrder.has(group.id)) groupOrder.set(group.id, groupOrder.size);
      if (row.groupName && row.groupName !== group.name) {
        groupRenames.set(group.id, row.groupName);
      }
      return { kind: 'existing', id: group.id };
    }
    if (row.groupName) {
      const existing = groupByName.get(row.groupName);
      if (existing) {
        if (!groupOrder.has(existing.id)) groupOrder.set(existing.id, groupOrder.size);
        return { kind: 'existing', id: existing.id };
      }
      if (!newGroupNames.includes(row.groupName)) newGroupNames.push(row.groupName);
      return { kind: 'new', name: row.groupName };
    }
    return { kind: 'none' };
  };

  for (const row of rows) {
    const skip = (message: string) => results.push({ line: row.line, status: 'skipped', message });

    const groupRef = resolveGroup(row);
    if ('error' in groupRef) {
      skip(groupRef.error);
      continue;
    }

    if (row.accountId) {
      /* ------------------------- existing account ------------------------ */
      const account = accountById.get(row.accountId);
      if (!account) {
        skip(`アカウントID「${row.accountId}」が見つかりません`);
        continue;
      }
      const credentialCells = [
        row.loginId,
        row.loginPassword,
        row.twoFactorSecret,
        row.authToken,
        row.proxyName,
        row.memo,
      ];
      if (credentialCells.some((c) => c !== '')) {
        skip('既存アカウントにはログイン情報・AuthToken・プロキシ・メモを設定できません（新規アカウントのみ）');
        continue;
      }
      ops.push({
        type: 'update',
        line: row.line,
        accountId: account.id,
        groupRef,
        order: nextOrder(groupRef),
        displayName: row.displayName || account.displayName,
      });
      results.push({ line: row.line, status: 'updated', message: `@${account.handle} の表示名・グループ・並び順を更新` });
      continue;
    }

    /* --------------------------- new account --------------------------- */
    const handle = deriveHandle(row);
    if (!handle) {
      skip('XログインIDからアカウントID（@ID）を決められないため作成できません');
      continue;
    }
    if (usedHandles.has(handle.toLowerCase())) {
      skip(`@${handle} は既に登録されています`);
      continue;
    }
    let proxyGroupId: string | null = null;
    if (row.proxyName) {
      const proxy = proxyByName.get(row.proxyName);
      if (!proxy) {
        skip(`プロキシ「${row.proxyName}」が見つかりません`);
        continue;
      }
      proxyGroupId = proxy.id;
    }
    usedHandles.add(handle.toLowerCase());
    ops.push({
      type: 'create',
      line: row.line,
      groupRef,
      order: nextOrder(groupRef),
      account: {
        handle,
        displayName: row.displayName || handle,
        groupId: null, // resolved from groupRef when the plan is applied
        proxyGroupId,
        status: row.authToken ? 'logged_in' : 'logged_out',
        authToken: row.authToken || undefined,
        loginId: row.loginId || undefined,
        loginPassword: row.loginPassword || undefined,
        twoFactorSecret: row.twoFactorSecret || undefined,
        memo: row.memo || undefined,
        followers: 0,
        following: 0,
        notifications: 0,
        dmCount: 0,
        searchBan: 'unknown',
      },
    });
    results.push({ line: row.line, status: 'created', message: `@${handle} を新規作成` });
  }

  return {
    ops,
    groupRenames: [...groupRenames].map(([groupId, name]) => ({ groupId, name })),
    groupOrder: [...groupOrder].map(([groupId, order]) => ({ groupId, order })),
    newGroupNames,
    results,
  };
}
