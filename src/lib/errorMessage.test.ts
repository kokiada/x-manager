import { describe, expect, it } from 'vitest';
import { errorMessageOf, SESSION_EXPIRED_MESSAGE } from './errorMessage';

describe('errorMessageOf', () => {
  it('Error のメッセージをそのまま返す', () => {
    expect(errorMessageOf(new Error('Xのセッションが切れています'), '失敗しました')).toBe(
      'Xのセッションが切れています',
    );
  });

  it('文字列のエラーもそのまま返す', () => {
    expect(errorMessageOf('拡張に接続できません', '失敗しました')).toBe('拡張に接続できません');
  });

  it('空のメッセージ・Error でない値・undefined はフォールバックを使う', () => {
    expect(errorMessageOf(new Error('  '), '失敗しました')).toBe('失敗しました');
    expect(errorMessageOf(undefined, '失敗しました')).toBe('失敗しました');
    expect(errorMessageOf(null, '失敗しました')).toBe('失敗しました');
    expect(errorMessageOf(42, '失敗しました')).toBe('失敗しました');
    expect(errorMessageOf('', '失敗しました')).toBe('失敗しました');
  });

  it('セッション切れの文言は再登録を促す', () => {
    expect(SESSION_EXPIRED_MESSAGE).toContain('auth_token');
    expect(SESSION_EXPIRED_MESSAGE).toContain('登録し直してください');
  });
});
