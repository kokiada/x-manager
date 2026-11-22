import { describe, expect, it } from 'vitest';
import {
  MAIL_TOKENS_STORAGE_KEY,
  describeMailToken,
  expectedMailScope,
  isMailTokenExpired,
  isValidMailTokenRecord,
  mailTokenStorageKey,
} from './mailTokenStore';
import type { MailTokenRecord } from './mailTokenStore';

const NOW = 1_800_000_000_000;

function gmailToken(overrides: Partial<MailTokenRecord> = {}): MailTokenRecord {
  return {
    accessToken: 'ya29.access-token',
    refreshToken: '1//refresh-token',
    expiresAtMs: NOW + 3_600_000,
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    ...overrides,
  };
}

function outlookToken(
  overrides: Partial<MailTokenRecord> = {},
): MailTokenRecord {
  return {
    accessToken: 'EwC-access-token',
    expiresAtMs: NOW + 3_600_000,
    scope: 'https://graph.microsoft.com/Mail.ReadBasic',
    ...overrides,
  };
}

describe('3-4 トークン保存方法の決定', () => {
  it('保管場所はタスク8と同じく拡張の chrome.storage.local だけ', () => {
    expect(MAIL_TOKENS_STORAGE_KEY).toBe('xmanager.mailTokens.v1');
    expect(mailTokenStorageKey()).toBe('xmanager.mailTokens.v1');
  });

  it('スコープは読み取り専用の最小権限だけ', () => {
    expect(expectedMailScope('gmail')).toBe(
      'https://www.googleapis.com/auth/gmail.readonly',
    );
    expect(expectedMailScope('outlook')).toBe(
      'https://graph.microsoft.com/Mail.ReadBasic',
    );
  });

  it('正しいレコードは有効', () => {
    expect(isValidMailTokenRecord('gmail', gmailToken())).toBe(true);
    expect(isValidMailTokenRecord('outlook', outlookToken())).toBe(true);
    // リフレッシュトークン無しでも有効（認可フローによっては付かない）
    const { refreshToken: _removed, ...noRefresh } = gmailToken();
    expect(isValidMailTokenRecord('gmail', noRefresh)).toBe(true);
  });

  it('トークンが空・期限が無い・スコープ違いは無効', () => {
    expect(isValidMailTokenRecord('gmail', gmailToken({ accessToken: '' }))).toBe(
      false,
    );
    expect(isValidMailTokenRecord('gmail', gmailToken({ accessToken: '  ' }))).toBe(
      false,
    );
    expect(
      isValidMailTokenRecord('gmail', gmailToken({ expiresAtMs: 0 })),
    ).toBe(false);
    expect(
      isValidMailTokenRecord('gmail', gmailToken({ expiresAtMs: Number.NaN })),
    ).toBe(false);
    // Gmail のレコードに Outlook のスコープはダメ（取り違え防止）
    expect(
      isValidMailTokenRecord(
        'gmail',
        gmailToken({ scope: 'https://graph.microsoft.com/Mail.ReadBasic' }),
      ),
    ).toBe(false);
    // 書き込みスコープはダメ
    expect(
      isValidMailTokenRecord(
        'gmail',
        gmailToken({ scope: 'https://www.googleapis.com/auth/gmail.modify' }),
      ),
    ).toBe(false);
  });

  it('レコードでない値は無効', () => {
    expect(isValidMailTokenRecord('gmail', null)).toBe(false);
    expect(isValidMailTokenRecord('gmail', 'token')).toBe(false);
    expect(isValidMailTokenRecord('gmail', {})).toBe(false);
    expect(isValidMailTokenRecord('gmail', { accessToken: 'x' })).toBe(false);
  });

  it('期限切れは 60 秒の余裕を見て判定する', () => {
    const token = gmailToken({ expiresAtMs: NOW + 30_000 });
    expect(isMailTokenExpired(token, NOW)).toBe(true);
    expect(isMailTokenExpired(gmailToken(), NOW)).toBe(false);
    expect(isMailTokenExpired(gmailToken({ expiresAtMs: NOW - 1 }), NOW)).toBe(
      true,
    );
    // 余裕 0 なら期限ちょうどまでは有効
    expect(isMailTokenExpired(token, NOW, 0)).toBe(false);
  });

  it('診断用の要約にトークン値は出ない', () => {
    const summary = describeMailToken('gmail', gmailToken());
    expect(summary).toEqual({
      provider: 'gmail',
      scope: 'https://www.googleapis.com/auth/gmail.readonly',
      expiresAtMs: NOW + 3_600_000,
      hasRefreshToken: true,
    });
    expect(JSON.stringify(summary)).not.toContain('ya29');
    expect(JSON.stringify(summary)).not.toContain('refresh-token');
    expect(describeMailToken('outlook', outlookToken()).hasRefreshToken).toBe(
      false,
    );
  });
});
