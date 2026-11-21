import { describe, expect, it } from 'vitest';
import {
  errorMessageOf,
  EXTENSION_COOKIES_UNAVAILABLE_MESSAGE,
  SESSION_EXPIRED_MESSAGE,
} from './errorMessage';

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

  it('Cookie API が無いときの生の TypeError は日本語の説明に置き換える', () => {
    expect(
      errorMessageOf(
        new Error("Cannot read properties of undefined (reading 'set')"),
        '失敗しました',
      ),
    ).toBe(EXTENSION_COOKIES_UNAVAILABLE_MESSAGE);
    expect(
      errorMessageOf(
        new Error("Cannot read properties of undefined (reading 'get')"),
        '失敗しました',
      ),
    ).toBe(EXTENSION_COOKIES_UNAVAILABLE_MESSAGE);
    // 拡張の Cookie 機能の文言は再読み込みの対処を含む
    expect(EXTENSION_COOKIES_UNAVAILABLE_MESSAGE).toContain('再読み込み');
  });

  it('関係ないプロパティの TypeError はそのまま返す', () => {
    expect(
      errorMessageOf(
        new Error("Cannot read properties of undefined (reading 'foo')"),
        '失敗しました',
      ),
    ).toBe("Cannot read properties of undefined (reading 'foo')");
  });
});
