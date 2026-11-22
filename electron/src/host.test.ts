import { describe, expect, it, vi } from 'vitest';
import { X_URL, createHostWindow, parseArgs, runSmoke } from './host.cjs';

/** electron モジュールの最小の偽物。 */
function fakeElectron() {
  const loadURL = vi.fn().mockResolvedValue(undefined);
  const getTitle = vi.fn().mockReturnValue('X');
  const getURL = vi.fn().mockReturnValue('https://x.com/');
  const capturePage = vi.fn().mockResolvedValue({ toPNG: () => Buffer.from('png') });
  const window = { loadURL, webContents: { getTitle, getURL, capturePage } };
  // new で呼ぶため function 式にする（アロー関数はコンストラクタになれない）。
  const BrowserWindow = vi.fn().mockImplementation(function BrowserWindowMock() {
    return window;
  });
  const fromPartition = vi.fn().mockReturnValue({ id: 'sess' });
  return {
    electron: { BrowserWindow, session: { fromPartition } },
    BrowserWindow,
    fromPartition,
    window,
    loadURL,
    getTitle,
    getURL,
    capturePage,
  };
}

describe('parseArgs', () => {
  it('既定は smoke アカウント・x.com・通常起動', () => {
    expect(parseArgs([])).toEqual({ accountId: 'smoke', url: X_URL, smoke: false });
  });

  it('--account / --url / --smoke を読む', () => {
    expect(parseArgs(['--account', 'korosukeada', '--url', 'https://x.com/home', '--smoke'])).toEqual({
      accountId: 'korosukeada',
      url: 'https://x.com/home',
      smoke: true,
    });
  });

  it('https なら x.com 以外も --url で指定できる（表示確認用）', () => {
    expect(parseArgs(['--url', 'https://example.com/'])).toEqual({
      accountId: 'smoke',
      url: 'https://example.com/',
      smoke: false,
    });
  });

  it('https 以外・不正な URL は受け付けない', () => {
    expect(() => parseArgs(['--url', 'http://x.com/'])).toThrow(/https/);
    expect(() => parseArgs(['--url', 'not-a-url'])).toThrow(/URL/);
  });

  it('値の無いフラグ・未知のフラグは受け付けない', () => {
    expect(() => parseArgs(['--account'])).toThrow(/--account/);
    expect(() => parseArgs(['--nope'])).toThrow(/--nope/);
  });
});

describe('createHostWindow', () => {
  it('partition 付きのウィンドウを作り x.com を開く', async () => {
    const f = fakeElectron();
    const { window, session } = await createHostWindow(f.electron, {
      accountId: 'korosukeada',
      url: 'https://x.com/',
    });
    expect(f.fromPartition).toHaveBeenCalledWith('persist:xmgr-korosukeada');
    expect(f.BrowserWindow).toHaveBeenCalledWith(
      expect.objectContaining({
        webPreferences: expect.objectContaining({
          partition: 'persist:xmgr-korosukeada',
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        }),
      }),
    );
    expect(f.loadURL).toHaveBeenCalledWith('https://x.com/');
    expect(window).toBe(f.window);
    expect(session).toEqual({ id: 'sess' });
  });

  it('不正なアカウントIDではウィンドウを作らない', async () => {
    const f = fakeElectron();
    await expect(
      createHostWindow(f.electron, { accountId: 'a/b', url: 'https://x.com/' }),
    ).rejects.toThrow(/アカウントID/);
    expect(f.BrowserWindow).not.toHaveBeenCalled();
  });
});

describe('runSmoke', () => {
  it('読み込み成功時はタイトルとURLを返す', async () => {
    const f = fakeElectron();
    const result = await runSmoke(f.electron, { accountId: 'smoke', url: 'https://x.com/' });
    expect(result.ok).toBe(true);
    expect(result.title).toBe('X');
    expect(result.url).toBe('https://x.com/');
  });

  it('スクリーンショット指定時は capturePage して保存する', async () => {
    const f = fakeElectron();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const shot = path.join(os.tmpdir(), `xmgr-smoke-${Date.now()}.png`);
    try {
      const result = await runSmoke(f.electron, {
        accountId: 'smoke',
        url: 'https://x.com/',
        screenshotPath: shot,
      });
      expect(result.ok).toBe(true);
      expect(f.capturePage).toHaveBeenCalled();
      expect(fs.existsSync(shot)).toBe(true);
      expect(result.screenshot).toBe(shot);
    } finally {
      if (fs.existsSync(shot)) fs.unlinkSync(shot);
    }
  });

  it('読み込み失敗時は ok:false と理由を返す（例外を投げない）', async () => {
    const f = fakeElectron();
    f.loadURL.mockRejectedValueOnce(new Error('ERR_NAME_NOT_RESOLVED'));
    const result = await runSmoke(f.electron, { accountId: 'smoke', url: 'https://x.com/' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ERR_NAME_NOT_RESOLVED');
  });
});
