import { describe, expect, it } from 'vitest';
import type { Account, Group, ProxyGroup } from '../db/types';
import {
  ACCOUNT_CSV_HEADER,
  accountsToCsv,
  decodeCsvBytes,
  parseAccountCsv,
  planAccountCsvImport,
  type AccountCsvSnapshot,
} from './accountCsv';

const groups: Group[] = [
  { id: 'grp-1', name: 'メイン', order: 0, createdAt: 1 },
  { id: 'grp-2', name: '検証', order: 1, createdAt: 1 },
];
const proxyGroups: ProxyGroup[] = [
  { id: 'px-1', name: '東京プロキシ A', host: 'proxy.example.jp', port: 8080, createdAt: 1 },
];

const baseAccount: Account = {
  id: 'acc-1',
  handle: 'existing_one',
  displayName: '既存アカウント',
  groupId: 'grp-1',
  proxyGroupId: 'px-1',
  status: 'logged_in',
  authToken: 'token-acc-1',
  loginId: 'existing_one',
  loginPassword: 'pw-1',
  twoFactorSecret: '2fa-1',
  memo: '主力',
  followers: 100,
  following: 10,
  notifications: 1,
  dmCount: 0,
  searchBan: 'visible',
  createdAt: 1,
  updatedAt: 1,
};

const snapshot: AccountCsvSnapshot = {
  accounts: [baseAccount],
  groups,
  proxyGroups,
};

const headerLine = ACCOUNT_CSV_HEADER.join(',');

describe('accountsToCsv', () => {
  it('exports UTF-8 with BOM and the exact XBoard header', () => {
    const csv = accountsToCsv([baseAccount], groups, proxyGroups);
    expect(csv.startsWith('\uFEFF')).toBe(true);
    const lines = csv.replace(/^\uFEFF/, '').split('\r\n');
    expect(lines[0]).toBe(headerLine);
    expect(lines[1]).toBe(
      ['メイン', 'grp-1', '既存アカウント', 'acc-1', 'existing_one', 'pw-1', '2fa-1', 'token-acc-1', '東京プロキシ A', '主力'].join(','),
    );
  });
});

describe('parseAccountCsv', () => {
  it('rejects a changed header row', () => {
    expect(() => parseAccountCsv('グループ,ID,名前\n')).toThrow(/見出し行が正しくありません/);
  });

  it('parses rows with 1-based line numbers', () => {
    const rows = parseAccountCsv(`${headerLine}\nメイン,grp-1,名前,acc-1,,,,,,\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0].line).toBe(2);
    expect(rows[0].accountId).toBe('acc-1');
  });
});

describe('round trip', () => {
  it('export → parse → plan against the same state yields only updates', () => {
    const csv = accountsToCsv([baseAccount], groups, proxyGroups);
    // The exported row carries credentials for the existing account, so
    // per the XBoard rule the planner must refuse it — strip the
    // credential columns (as an operator editing for a rename would)
    // and the row becomes a plain update.
    const rows = parseAccountCsv(csv).map((r) => ({
      ...r,
      loginId: '',
      loginPassword: '',
      twoFactorSecret: '',
      authToken: '',
      proxyName: '',
      memo: '',
    }));
    const plan = planAccountCsvImport(rows, snapshot);
    expect(plan.results).toEqual([{ line: 2, status: 'updated', message: expect.stringContaining('@existing_one') }]);
    expect(plan.ops).toHaveLength(1);
    expect(plan.ops[0].type).toBe('update');
  });
});

describe('planAccountCsvImport', () => {
  it('skips rows that put credentials on an existing account', () => {
    const rows = parseAccountCsv(`${headerLine}\nメイン,grp-1,名前,acc-1,login,,,,,,\n`);
    const plan = planAccountCsvImport(rows, snapshot);
    expect(plan.ops).toHaveLength(0);
    expect(plan.results[0].status).toBe('skipped');
    expect(plan.results[0].message).toContain('新規アカウントのみ');
  });

  it('skips rows whose account ID does not exist', () => {
    const rows = parseAccountCsv(`${headerLine}\nメイン,grp-1,名前,acc-unknown,,,,,,,\n`);
    const plan = planAccountCsvImport(rows, snapshot);
    expect(plan.results[0].status).toBe('skipped');
    expect(plan.results[0].message).toContain('見つかりません');
  });

  it('creates new accounts with credentials, group and proxy resolution', () => {
    const csv = [
      headerLine,
      '新しいグループ,,新規アカウント,,new_handle_1,secret-pw,2fa-secret,auth-token-xyz,東京プロキシ A,メモ欄',
      'メイン,grp-1,二つ目,,second_handle,,,,,,',
    ].join('\n');
    const plan = planAccountCsvImport(parseAccountCsv(csv), snapshot);
    expect(plan.newGroupNames).toEqual(['新しいグループ']);
    expect(plan.results.map((r) => r.status)).toEqual(['created', 'created']);

    const first = plan.ops[0];
    expect(first.type).toBe('create');
    if (first.type === 'create') {
      expect(first.groupRef).toEqual({ kind: 'new', name: '新しいグループ' });
      expect(first.account.handle).toBe('new_handle_1');
      expect(first.account.loginPassword).toBe('secret-pw');
      expect(first.account.twoFactorSecret).toBe('2fa-secret');
      expect(first.account.authToken).toBe('auth-token-xyz');
      expect(first.account.status).toBe('logged_in');
      expect(first.account.proxyGroupId).toBe('px-1');
      expect(first.account.memo).toBe('メモ欄');
      expect(first.order).toBe(0);
    }
    const second = plan.ops[1];
    if (second.type === 'create') {
      expect(second.groupRef).toEqual({ kind: 'existing', id: 'grp-1' });
      expect(second.account.status).toBe('logged_out');
      expect(second.account.proxyGroupId).toBeNull();
    }
  });

  it('skips a new account whose proxy name is unknown', () => {
    const rows = parseAccountCsv(`${headerLine}\nメイン,grp-1,名前,,some_handle,,,,存在しないプロキシ,\n`);
    const plan = planAccountCsvImport(rows, snapshot);
    expect(plan.results[0].status).toBe('skipped');
    expect(plan.results[0].message).toContain('プロキシ');
  });

  it('skips a duplicate handle within the same file', () => {
    const csv = [headerLine, 'メイン,grp-1,A,,dup_handle,,,,,,', 'メイン,grp-1,B,,dup_handle,,,,,,'].join('\n');
    const plan = planAccountCsvImport(parseAccountCsv(csv), snapshot);
    expect(plan.results.map((r) => r.status)).toEqual(['created', 'skipped']);
  });

  it('records a group rename when the name differs for a known group ID', () => {
    const rows = parseAccountCsv(`${headerLine}\n改名後,grp-1,名前,acc-1,,,,,,\n`);
    const plan = planAccountCsvImport(rows, snapshot);
    expect(plan.groupRenames).toEqual([{ groupId: 'grp-1', name: '改名後' }]);
    expect(plan.groupOrder).toEqual([{ groupId: 'grp-1', order: 0 }]);
  });

  it('skips rows whose group ID does not exist', () => {
    const rows = parseAccountCsv(`${headerLine}\n不明,grp-unknown,名前,,some_handle,,,,,,\n`);
    const plan = planAccountCsvImport(rows, snapshot);
    expect(plan.results[0].status).toBe('skipped');
    expect(plan.results[0].message).toContain('グループID');
  });
});

describe('decodeCsvBytes', () => {
  it('decodes UTF-8 with BOM', () => {
    const bytes = new TextEncoder().encode('\uFEFF' + headerLine);
    expect(decodeCsvBytes(bytes)).toContain('グループ名');
  });

  it('decodes plain UTF-8', () => {
    const bytes = new TextEncoder().encode(headerLine);
    expect(decodeCsvBytes(bytes)).toBe(headerLine);
  });

  it('falls back to Shift_JIS for non-UTF-8 bytes', () => {
    // Fixture: the header + one row, encoded as Shift_JIS and base64'd.
    const b64 =
      'g0+Di4Fbg3aWvCyDT4OLgVuDdklELINBg0qDRYOTg2eWvCyDQYNKg0WDk4NnSUQsWIONg0+DQ4OTSUQsWIONg0+DQ4OTg3CDWIOPgVuDaCwyRkGURo/Yg2eBW4NOg5MsQXV0aFRva2VuLIN2g42DTINWlVyOppa8LIOBg4IxDQqMn4/Yg0+Di4Fbg3YsLIyfj9iDQYNKg0WDk4NnLCxsYWJfc2FuZGJveF85OSwsLCwsg4GDgoLFgrcNCg==';
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const text = decodeCsvBytes(bytes);
    const rows = parseAccountCsv(text);
    expect(rows).toHaveLength(1);
    expect(rows[0].groupName).toBe('検証グループ');
    expect(rows[0].displayName).toBe('検証アカウント');
    expect(rows[0].loginId).toBe('lab_sandbox_99');
    expect(rows[0].memo).toBe('メモです');
  });
});
