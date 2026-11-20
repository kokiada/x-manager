import type {
  Account,
  ActionJob,
  AppSettings,
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
  Template,
  TemplateGroup,
} from '../db/types';

/**
 * Encrypted backup / restore — the on-device stand-in for XBoard's
 * device sync (research §15-1 full backup, §15-2 group sync).
 *
 * - The whole dataset is serialized to one JSON payload and encrypted
 *   with a user password (半角英数字8文字以上） via WebCrypto:
 *   PBKDF2-SHA256 key derivation + AES-256-GCM. The password never
 *   leaves the device and is not stored anywhere; without it the data
 *   cannot be recovered — same property XBoard documents.
 * - Full backups restore with the 置き換え (replace) method: current
 *   data is wiped and replaced by the backup's contents.
 * - Group backups carry only the selected group's accounts and the
 *   proxy groups they use, and restore with the 統合 (merge) method:
 *   accounts that already exist are skipped, nothing is deleted.
 */

export const BACKUP_FILE_FORMAT = 'x-manager-backup';
export const BACKUP_DATA_FORMAT = 'x-manager-data';
export const BACKUP_VERSION = 1;

const PBKDF2_ITERATIONS = 210_000;

export interface BackupTables {
  groups: Group[];
  proxyGroups: ProxyGroup[];
  accounts: Account[];
  templateGroups: TemplateGroup[];
  templates: Template[];
  randomWordSets: RandomWordSet[];
  postJobs: PostJob[];
  reservations: Reservation[];
  /** App settings (full backups only). */
  settings: AppSettings | null;
  /** M3/M4 tables; absent (empty) in backups made before M3/M4. */
  checkRuns: CheckRun[];
  followerSnapshots: FollowerSnapshot[];
  postMetrics: PostMetric[];
  automationRules: AutomationRule[];
  inboxItems: InboxItem[];
  actionJobs: ActionJob[];
}

export interface BackupPayload {
  format: typeof BACKUP_DATA_FORMAT;
  version: number;
  kind: 'full' | 'group';
  /** The exported group, for kind: 'group'. */
  groupId?: string;
  groupName?: string;
  exportedAt: number;
  tables: BackupTables;
}

interface BackupEnvelope {
  format: typeof BACKUP_FILE_FORMAT;
  version: number;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  data: string;
}

/* --------------------------- password rule ---------------------------- */

/**
 * XBoard's sync password rule: 8+ half-width alphanumeric characters.
 * Returns an error message, or null when the password is acceptable.
 */
export function validateBackupPassword(password: string): string | null {
  if (!/^[A-Za-z0-9]{8,}$/.test(password)) {
    return 'パスワードは半角英数字8文字以上で入力してください';
  }
  return null;
}

/* ----------------------------- base64 -------------------------------- */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/* ------------------------------ crypto -------------------------------- */

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password) as BufferSource,
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptBackup(payload: BackupPayload, password: string): Promise<string> {
  const invalid = validateBackupPassword(password);
  if (invalid) throw new Error(invalid);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, plain as BufferSource);
  const envelope: BackupEnvelope = {
    format: BACKUP_FILE_FORMAT,
    version: BACKUP_VERSION,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: bytesToBase64(salt) },
    cipher: { name: 'AES-GCM', iv: bytesToBase64(iv) },
    data: bytesToBase64(new Uint8Array(cipher)),
  };
  return JSON.stringify(envelope, null, 2);
}

export async function decryptBackup(envelopeText: string, password: string): Promise<BackupPayload> {
  let envelope: BackupEnvelope;
  try {
    envelope = JSON.parse(envelopeText) as BackupEnvelope;
  } catch {
    throw new Error('バックアップファイルの形式が正しくありません');
  }
  if (envelope?.format !== BACKUP_FILE_FORMAT || !envelope.kdf || !envelope.cipher || !envelope.data) {
    throw new Error('x-managerのバックアップファイルではありません');
  }
  const key = await deriveKey(password, base64ToBytes(envelope.kdf.salt), envelope.kdf.iterations);
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: base64ToBytes(envelope.cipher.iv) as BufferSource },
      key,
      base64ToBytes(envelope.data) as BufferSource,
    );
  } catch {
    throw new Error('復号できませんでした。パスワードが違うか、ファイルが壊れています');
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error('バックアップの中身を読み取れませんでした');
  }
  return validateBackupPayload(payload);
}

/* ----------------------------- payload -------------------------------- */

const TABLE_KEYS = [
  'groups',
  'proxyGroups',
  'accounts',
  'templateGroups',
  'templates',
  'randomWordSets',
  'postJobs',
  'reservations',
] as const;

/** Structural check of a decrypted payload before it touches the DB. */
export function validateBackupPayload(value: unknown): BackupPayload {
  const p = value as BackupPayload;
  if (!p || p.format !== BACKUP_DATA_FORMAT || typeof p.exportedAt !== 'number' || !p.tables) {
    throw new Error('バックアップの中身が想定と違います');
  }
  if (p.kind !== 'full' && p.kind !== 'group') {
    throw new Error('バックアップの種類が不明です');
  }
  for (const key of TABLE_KEYS) {
    if (!Array.isArray(p.tables[key])) {
      throw new Error(`バックアップのテーブル「${key}」が壊れています`);
    }
  }
  // M3/M4 tables did not exist in older backups; treat them as empty.
  for (const key of ['checkRuns', 'followerSnapshots', 'postMetrics', 'automationRules', 'inboxItems', 'actionJobs'] as const) {
    if (!Array.isArray(p.tables[key])) p.tables[key] = [];
  }
  return p;
}

export function emptyTables(): BackupTables {
  return {
    groups: [],
    proxyGroups: [],
    accounts: [],
    templateGroups: [],
    templates: [],
    randomWordSets: [],
    postJobs: [],
    reservations: [],
    settings: null,
    checkRuns: [],
    followerSnapshots: [],
    postMetrics: [],
    automationRules: [],
    inboxItems: [],
    actionJobs: [],
  };
}

/**
 * Build the group-selective subset (research §15-2): the selected
 * group, its accounts, and the proxy groups those accounts use.
 * Templates / rules / settings are not part of a group backup.
 */
export function buildGroupSubset(tables: BackupTables, groupId: string): BackupTables {
  const group = tables.groups.find((g) => g.id === groupId);
  const accounts = tables.accounts.filter((a) => a.groupId === groupId);
  const usedProxyIds = new Set(accounts.map((a) => a.proxyGroupId).filter(Boolean));
  return {
    ...emptyTables(),
    groups: group ? [group] : [],
    proxyGroups: tables.proxyGroups.filter((p) => usedProxyIds.has(p.id)),
    accounts,
  };
}

/** Row counts per table, for the restore confirmation UI. */
export function backupCounts(payload: BackupPayload): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const key of TABLE_KEYS) counts[key] = payload.tables[key].length;
  return counts;
}
