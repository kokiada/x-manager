import { describe, expect, it } from 'vitest';
import type { Account, Group } from '../db/types';
import {
  buildGroupSubset,
  decryptBackup,
  emptyTables,
  encryptBackup,
  validateBackupPassword,
  validateBackupPayload,
  type BackupPayload,
  type BackupTables,
} from './backup';

const PASSWORD = 'pass1234';

function samplePayload(): BackupPayload {
  const tables: BackupTables = {
    ...emptyTables(),
    groups: [{ id: 'grp-1', name: 'メイン', order: 0, createdAt: 1 }],
    accounts: [
      {
        id: 'acc-1',
        handle: 'sample_handle',
        displayName: 'サンプル',
        groupId: 'grp-1',
        proxyGroupId: null,
        status: 'logged_in',
        authToken: 'secret-token-value',
        followers: 10,
        following: 1,
        notifications: 0,
        dmCount: 0,
        searchBan: 'unknown',
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  };
  return {
    format: 'x-manager-data',
    version: 1,
    kind: 'full',
    exportedAt: 1700000000000,
    tables,
  };
}

describe('validateBackupPassword', () => {
  it('accepts 8+ half-width alphanumeric characters', () => {
    expect(validateBackupPassword('abcd1234')).toBeNull();
    expect(validateBackupPassword('ABCDEFGH')).toBeNull();
  });
  it('rejects short, non-alphanumeric and full-width passwords', () => {
    expect(validateBackupPassword('abc123')).not.toBeNull();
    expect(validateBackupPassword('abcd-1234')).not.toBeNull();
    expect(validateBackupPassword('パスワード1234')).not.toBeNull();
    expect(validateBackupPassword('')).not.toBeNull();
  });
});

describe('encryptBackup / decryptBackup', () => {
  it('round-trips a payload', async () => {
    const payload = samplePayload();
    const text = await encryptBackup(payload, PASSWORD);
    expect(text).not.toContain('secret-token-value');
    const restored = await decryptBackup(text, PASSWORD);
    expect(restored).toEqual(payload);
  });

  it('fails with a wrong password', async () => {
    const text = await encryptBackup(samplePayload(), PASSWORD);
    await expect(decryptBackup(text, 'wrong999')).rejects.toThrow(/復号できませんでした/);
  });

  it('fails when the ciphertext is tampered with', async () => {
    const text = await encryptBackup(samplePayload(), PASSWORD);
    const envelope = JSON.parse(text) as { data: string };
    envelope.data = (envelope.data[0] === 'A' ? 'B' : 'A') + envelope.data.slice(1);
    await expect(decryptBackup(JSON.stringify(envelope), PASSWORD)).rejects.toThrow();
  });

  it('rejects files that are not x-manager backups', async () => {
    await expect(decryptBackup('{"hello":"world"}', PASSWORD)).rejects.toThrow(/バックアップファイルではありません/);
    await expect(decryptBackup('not json', PASSWORD)).rejects.toThrow(/形式が正しくありません/);
  });

  it('rejects weak passwords at encryption time', async () => {
    await expect(encryptBackup(samplePayload(), 'short')).rejects.toThrow(/半角英数字8文字以上/);
  });
});

describe('validateBackupPayload', () => {
  it('accepts a well-formed payload and rejects broken ones', () => {
    expect(validateBackupPayload(samplePayload()).kind).toBe('full');
    expect(() => validateBackupPayload({ format: 'x-manager-data' })).toThrow();
    expect(() => validateBackupPayload(null)).toThrow();
    const broken = samplePayload();
    (broken.tables as unknown as Record<string, unknown>).accounts = 'nope';
    expect(() => validateBackupPayload(broken)).toThrow(/壊れています/);
  });

  it('normalizes pre-M3/M4 payloads that lack the new tables', () => {
    const old = samplePayload();
    const tables = old.tables as unknown as Record<string, unknown>;
    for (const key of [
      'banCheckResults', 'bulkActions', 'autoActionRules', 'autoActionEvents',
      'postAnalytics', 'postTracking', 'followerHistory', 'notifications',
      'autoPostRules', 'autoPostRuns', 'meta',
    ]) {
      delete tables[key];
    }
    const restored = validateBackupPayload(old);
    expect(restored.tables.banCheckResults).toEqual([]);
    expect(restored.tables.followerHistory).toEqual([]);
    expect(restored.tables.meta).toEqual([]);
  });

  it('rejects a broken new table', () => {
    const broken = samplePayload();
    (broken.tables as unknown as Record<string, unknown>).followerHistory = 'nope';
    expect(() => validateBackupPayload(broken)).toThrow(/壊れています/);
  });

  it('round-trips a payload carrying the new tables', async () => {
    const payload = samplePayload();
    payload.tables.banCheckResults = [
      { id: 'bc-1', accountId: 'acc-1', handle: 'sample_handle', checkedByAccountId: 'acc-1', topicVisible: true, latestVisible: true, checkedAt: 2 },
    ];
    payload.tables.followerHistory = [{ id: 'fh-1', accountId: 'acc-1', date: '2026-11-20', followers: 10 }];
    payload.tables.autoPostRules = [
      { id: 'apr-1', name: '朝ポスト', enabled: true, accountIds: ['acc-1'], templateId: 'tpl-1', mode: 'fixed_times', times: ['09:00'], createdAt: 1, updatedAt: 1 },
    ];
    const text = await encryptBackup(payload, PASSWORD);
    const restored = await decryptBackup(text, PASSWORD);
    expect(restored).toEqual(payload);
  });
});

describe('buildGroupSubset', () => {
  it('keeps only the group, its accounts and their proxy groups', () => {
    const tables: BackupTables = {
      ...emptyTables(),
      groups: [
        { id: 'grp-1', name: 'メイン', order: 0, createdAt: 1 },
        { id: 'grp-2', name: '検証', order: 1, createdAt: 1 },
      ] as Group[],
      proxyGroups: [
        { id: 'px-1', name: 'P1', host: 'h1', port: 1, createdAt: 1 },
        { id: 'px-2', name: 'P2', host: 'h2', port: 2, createdAt: 1 },
      ],
      accounts: [
        { id: 'a1', groupId: 'grp-1', proxyGroupId: 'px-1' },
        { id: 'a2', groupId: 'grp-2', proxyGroupId: 'px-2' },
        { id: 'a3', groupId: 'grp-1', proxyGroupId: null },
      ] as unknown as Account[],
      templates: [{ id: 't1' }] as unknown as BackupTables['templates'],
    };
    const subset = buildGroupSubset(tables, 'grp-1');
    expect(subset.groups.map((g) => g.id)).toEqual(['grp-1']);
    expect(subset.accounts.map((a) => a.id)).toEqual(['a1', 'a3']);
    expect(subset.proxyGroups.map((p) => p.id)).toEqual(['px-1']);
    expect(subset.templates).toEqual([]);
    expect(subset.settings).toBeNull();
  });

  it('carries account-scoped rows of the group accounts only', () => {
    const tables: BackupTables = {
      ...emptyTables(),
      groups: [{ id: 'grp-1', name: 'メイン', order: 0, createdAt: 1 }] as Group[],
      accounts: [
        { id: 'a1', groupId: 'grp-1' },
        { id: 'a2', groupId: 'grp-2' },
      ] as unknown as Account[],
      followerHistory: [
        { id: 'fh-1', accountId: 'a1', date: '2026-11-20', followers: 5 },
        { id: 'fh-2', accountId: 'a2', date: '2026-11-20', followers: 7 },
      ],
      notifications: [
        { id: 'n-1', accountId: 'a1', handle: 'sample_handle', kind: 'dm', title: 'DM', body: 'x', at: 1, read: false },
        { id: 'n-2', accountId: 'a2', handle: 'other_handle', kind: 'dm', title: 'DM', body: 'y', at: 1, read: false },
      ],
      autoPostRules: [{ id: 'r-1' }] as unknown as BackupTables['autoPostRules'],
    };
    const subset = buildGroupSubset(tables, 'grp-1');
    expect(subset.followerHistory?.map((r) => r.id)).toEqual(['fh-1']);
    expect(subset.notifications?.map((r) => r.id)).toEqual(['n-1']);
    // Rules are not group-scoped and never travel in a group backup.
    expect(subset.autoPostRules).toEqual([]);
  });
});
