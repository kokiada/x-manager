import { describe, expect, it, vi } from 'vitest';
import {
  LOGIN_IMPORT_TIMEOUT_MS,
  LOGIN_TIMEOUT_ERROR,
  LOGIN_URL,
  LOGIN_WINDOW_CLOSED_ERROR,
  createLoginWindow,
  runLoginImport,
  waitForAuthToken,
} from './loginImport.cjs';

/** 制御可能な時計と sleep（ポーリング回数を数えられる）。 */
function fakeClock() {
  let nowMs = 0;
  let sleeps = 0;
  return {
    now: () => nowMs,
    sleep: async (ms: number) => {
      sleeps += 1;
      nowMs += ms;
    },
    sleeps: () => sleeps,
  };
}

describe('waitForAuthToken', () => {
  it('最初から auth_token があれば即 true（sleep なし）', async () => {
    const clock = fakeClock();
    const result = await waitForAuthToken(
      async () => ({ hasAuthToken: true }),
      {
        timeoutMs: 1000,
        intervalMs: 100,
        now: clock.now,
        sleep: clock.sleep,
      },
    );
    expect(result).toBe(true);
    expect(clock.sleeps()).toBe(0);
  });

  it('3回目のポーリングで現れたら true（ポーリング回数を数える）', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await waitForAuthToken(
      async () => {
        calls += 1;
        return { hasAuthToken: calls >= 3 };
      },
      { timeoutMs: 10000, intervalMs: 100, now: clock.now, sleep: clock.sleep },
    );
    expect(result).toBe(true);
    expect(calls).toBe(3);
    expect(clock.sleeps()).toBe(2);
  });

  it('期限までに現れなければ false', async () => {
    const clock = fakeClock();
    let calls = 0;
    const result = await waitForAuthToken(
      async () => {
        calls += 1;
        return { hasAuthToken: false };
      },
      { timeoutMs: 500, intervalMs: 200, now: clock.now, sleep: clock.sleep },
    );
    expect(result).toBe(false);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('既定の制限時間は 5 分', () => {
    expect(LOGIN_IMPORT_TIMEOUT_MS).toBe(300000);
  });
});

/** runLoginImport のスタブ環境。 */
function fakeElectron() {
  const fromPartition = vi.fn((partition: string) => ({ partition }));
  const close = vi.fn();
  const win = {
    webContents: { fake: true },
    isDestroyed: () => false,
    close,
    loadURL: vi.fn(),
  };
  const electron = {
    session: { fromPartition },
    BrowserWindow: vi.fn(() => win),
  };
  return { electron, fromPartition, win, close };
}

describe('createLoginWindow', () => {
  it('読み込み失敗でもウィンドウを返す（再読み込みの機会を残す）', async () => {
    const win = {
      loadURL: async () => {
        throw new Error("ERR_CERT_AUTHORITY_INVALID (-202) loading 'https://x.com/i/flow/login'");
      },
      isDestroyed: () => false,
      close: () => {},
    };
    const BrowserWindow = vi.fn(function () {
      return win;
    });
    const electron = {
      BrowserWindow,
      session: { fromPartition: vi.fn(() => ({})) },
    };
    const got = await createLoginWindow(electron, { accountId: 'acc-1', session: {} });
    expect(got).toBe(win);
    expect(BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'x-manager — X にログイン',
        webPreferences: expect.objectContaining({
          partition: 'persist:xmgr-acc-1',
          nodeIntegration: false,
          sandbox: true,
        }),
      }),
    );
    // ログイン用ウィンドウにブリッジの preload は付けない
    // （x.com のページ文脈から invoke に届いてはならない）。
    expect(
      (BrowserWindow.mock.calls[0][0] as { webPreferences: Record<string, unknown> }).webPreferences
        .preload,
    ).toBeUndefined();
  });
});

describe('runLoginImport', () => {
  it('ログイン完了→本人確認で { xUserId, handle } を返す（token 値は含まない）', async () => {
    const f = fakeElectron();
    const result = await runLoginImport(f.electron as never, {
      accountId: 'acc-1',
      deps: {
        createLoginWindow: async () => f.win,
        getSessionStatus: async () => ({ hasAuthToken: true, hasCt0: true, cookieNames: [] }),
        readIdentity: async () => ({ ok: true, id: '12345', handle: 'alice' }),
        now: () => 0,
        sleep: async () => {},
      },
    });
    expect(result).toEqual({ ok: true, accountId: 'acc-1', xUserId: '12345', handle: 'alice' });
    // 結果に token の値が出ていないこと。
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(f.close).toHaveBeenCalled();
  });

  it('ログイン用ウィンドウは x.com のログインフローを開く', async () => {
    const f = fakeElectron();
    let openedUrl = '';
    await runLoginImport(f.electron as never, {
      accountId: 'acc-1',
      deps: {
        createLoginWindow: async (_electron: unknown, { accountId }: { accountId: string }) => {
          openedUrl = LOGIN_URL;
          expect(accountId).toBe('acc-1');
          return f.win;
        },
        getSessionStatus: async () => ({ hasAuthToken: true, hasCt0: true, cookieNames: [] }),
        readIdentity: async () => ({ ok: true, id: '1', handle: 'alice' }),
        now: () => 0,
        sleep: async () => {},
      },
    });
    expect(openedUrl).toBe('https://x.com/i/flow/login');
  });

  it('時間切れなら ok:false とタイムアウト文言を返し、本人確認は呼ばない', async () => {
    const f = fakeElectron();
    const clock = fakeClock();
    const readIdentity = vi.fn(async () => ({ ok: true, id: '1', handle: 'alice' }));
    const result = await runLoginImport(f.electron as never, {
      accountId: 'acc-1',
      timeoutMs: 400,
      deps: {
        createLoginWindow: async () => f.win,
        getSessionStatus: async () => ({ hasAuthToken: false, hasCt0: false, cookieNames: [] }),
        readIdentity,
        now: clock.now,
        sleep: clock.sleep,
      },
    });
    expect(result).toEqual({ ok: false, accountId: 'acc-1', error: LOGIN_TIMEOUT_ERROR });
    expect(readIdentity).not.toHaveBeenCalled();
    expect(f.close).toHaveBeenCalled();
  });

  it('本人確認が失敗したらその理由を返す', async () => {
    const f = fakeElectron();
    const result = await runLoginImport(f.electron as never, {
      accountId: 'acc-1',
      deps: {
        createLoginWindow: async () => f.win,
        getSessionStatus: async () => ({ hasAuthToken: true, hasCt0: true, cookieNames: [] }),
        readIdentity: async () => ({ ok: false, error: 'ログイン中のアカウントを確認できませんでした。' }),
        now: () => 0,
        sleep: async () => {},
      },
    });
    expect(result).toEqual({
      ok: false,
      accountId: 'acc-1',
      error: 'ログイン中のアカウントを確認できませんでした。',
    });
  });

  it('ウィンドウが閉じられたら専用の文言で失敗する', async () => {
    const f = fakeElectron();
    f.win.isDestroyed = () => true;
    const result = await runLoginImport(f.electron as never, {
      accountId: 'acc-1',
      deps: {
        createLoginWindow: async () => f.win,
        getSessionStatus: async () => ({ hasAuthToken: false, hasCt0: false, cookieNames: [] }),
        readIdentity: async () => ({ ok: true, id: '1', handle: 'alice' }),
        now: () => 0,
        sleep: async () => {},
      },
    });
    expect(result).toEqual({ ok: false, accountId: 'acc-1', error: LOGIN_WINDOW_CLOSED_ERROR });
  });
});
