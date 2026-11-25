import { describe, expect, it } from 'vitest';
import { isDesktopMessage, isDesktopOpenLoginResult } from './desktopProtocol';

describe('isDesktopOpenLoginResult', () => {
  it('open-login-result の形を通す', () => {
    expect(
      isDesktopOpenLoginResult({
        source: 'x-manager-desktop-host',
        kind: 'open-login-result',
        accountId: 'acc-1',
        ok: true,
        xUserId: '12345',
        handle: 'alice',
      }),
    ).toBe(true);
    expect(
      isDesktopOpenLoginResult({
        source: 'x-manager-desktop-host',
        kind: 'open-login-result',
        accountId: 'acc-1',
        ok: false,
        error: 'ログインが完了しませんでした（時間切れ）。',
        code: 'unknown',
      }),
    ).toBe(true);
  });

  it('送信元・kind・ok が欠けていたら弾く', () => {
    expect(isDesktopOpenLoginResult({ kind: 'open-login-result', accountId: 'a', ok: true })).toBe(
      false,
    );
    expect(
      isDesktopOpenLoginResult({
        source: 'x-manager-desktop-host',
        kind: 'result',
        accountId: 'a',
        ok: true,
      }),
    ).toBe(false);
    expect(
      isDesktopOpenLoginResult({
        source: 'x-manager-desktop-host',
        kind: 'open-login-result',
        accountId: 'a',
      }),
    ).toBe(false);
    expect(
      isDesktopOpenLoginResult({
        source: 'x-manager-desktop-host',
        kind: 'open-login-result',
        accountId: 'a',
        ok: true,
        handle: 123,
      }),
    ).toBe(false);
  });
});

describe('isDesktopMessage', () => {
  it('open-login-result をデスクトップメッセージとして認める', () => {
    expect(
      isDesktopMessage({
        source: 'x-manager-desktop-host',
        kind: 'open-login-result',
        accountId: 'a',
        ok: true,
      }),
    ).toBe(true);
  });
});
