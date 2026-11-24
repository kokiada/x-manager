import { describe, expect, it, vi } from 'vitest';
import {
  APP_DEV_URL,
  X_URL,
  appFileUrl,
  createHostWindow,
  parseArgs,
  parseProxyArg,
  runHelloCheck,
  runSmoke,
} from './host.cjs';

/** electron モジュールの最小の偽物。 */
function fakeElectron() {
  const loadURL = vi.fn().mockResolvedValue(undefined);
  const getTitle = vi.fn().mockReturnValue('X');
  const getURL = vi.fn().mockReturnValue('https://x.com/');
  const capturePage = vi.fn().mockResolvedValue({ toPNG: () => Buffer.from('png') });
  const executeJavaScript = vi.fn().mockResolvedValue({
    source: 'x-manager-desktop-host',
    kind: 'hello-ack',
    version: 1,
    hostVersion: '0.1.0',
  });
  const window = { loadURL, webContents: { getTitle, getURL, capturePage, executeJavaScript } };
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
    executeJavaScript,
  };
}

describe('parseArgs', () => {
  it('既定は smoke アカウント・x.com・通常起動', () => {
    expect(parseArgs([])).toEqual({
      accountId: 'smoke',
      url: X_URL,
      smoke: false,
      proxy: null,
      verifySession: false,
      readCheck: false,
      postCheck: false,
      postText: null,
      appMode: null,
      helloCheck: false,
    });
  });

  it('--account / --url / --smoke を読む', () => {
    expect(parseArgs(['--account', 'korosukeada', '--url', 'https://x.com/home', '--smoke'])).toEqual({
      accountId: 'korosukeada',
      url: 'https://x.com/home',
      smoke: true,
      proxy: null,
      verifySession: false,
      readCheck: false,
      postCheck: false,
      postText: null,
      appMode: null,
      helloCheck: false,
    });
  });

  it('--proxy / --verify-session を読む', () => {
    expect(parseArgs(['--proxy', 'http://proxy.example.com:8080', '--verify-session'])).toEqual({
      accountId: 'smoke',
      url: X_URL,
      smoke: false,
      proxy: { scheme: 'http', host: 'proxy.example.com', port: 8080 },
      verifySession: true,
      readCheck: false,
      postCheck: false,
      postText: null,
      appMode: null,
      helloCheck: false,
    });
  });

  it('--read-check を読む', () => {
    expect(parseArgs(['--read-check'])).toEqual({
      accountId: 'smoke',
      url: X_URL,
      smoke: false,
      proxy: null,
      verifySession: false,
      readCheck: true,
      postCheck: false,
      postText: null,
      appMode: null,
      helloCheck: false,
    });
  });

  it('--post-check と --text を読む', () => {
    expect(parseArgs(['--post-check', '--text', 'hello'])).toEqual({
      accountId: 'smoke',
      url: X_URL,
      smoke: false,
      proxy: null,
      verifySession: false,
      readCheck: false,
      postCheck: true,
      postText: 'hello',
      appMode: null,
      helloCheck: false,
    });
  });

  it('--post-check に --text が無ければ受け付けない', () => {
    expect(() => parseArgs(['--post-check'])).toThrow(/--text/);
    expect(() => parseArgs(['--text'])).toThrow(/--text/);
  });

  it('https なら x.com 以外も --url で指定できる（表示確認用）', () => {
    expect(parseArgs(['--url', 'https://example.com/'])).toEqual({
      accountId: 'smoke',
      url: 'https://example.com/',
      smoke: false,
      proxy: null,
      verifySession: false,
      readCheck: false,
      postCheck: false,
      postText: null,
      appMode: null,
      helloCheck: false,
    });
  });

  it('https 以外・不正な URL は受け付けない', () => {
    expect(() => parseArgs(['--url', 'http://x.com/'])).toThrow(/https/);
    expect(() => parseArgs(['--url', 'not-a-url'])).toThrow(/URL/);
  });

  it('値の無いフラグ・未知のフラグは受け付けない', () => {
    expect(() => parseArgs(['--account'])).toThrow(/--account/);
    expect(() => parseArgs(['--proxy'])).toThrow(/--proxy/);
    expect(() => parseArgs(['--nope'])).toThrow(/--nope/);
  });

  it('--app はビルド済みアプリ（dist/index.html）を開く', () => {
    expect(parseArgs(['--app'])).toEqual({
      accountId: 'smoke',
      url: appFileUrl(),
      smoke: false,
      proxy: null,
      verifySession: false,
      readCheck: false,
      postCheck: false,
      postText: null,
      appMode: 'built',
      helloCheck: false,
    });
  });

  it('--app-dev は開発サーバー（localhost:5173）を開く', () => {
    expect(parseArgs(['--app-dev'])).toEqual({
      accountId: 'smoke',
      url: APP_DEV_URL,
      smoke: false,
      proxy: null,
      verifySession: false,
      readCheck: false,
      postCheck: false,
      postText: null,
      appMode: 'dev',
      helloCheck: false,
    });
  });

  it('--app と --app-dev の併用・--url との併用は受け付けない', () => {
    expect(() => parseArgs(['--app', '--app-dev'])).toThrow(/--app/);
    expect(() => parseArgs(['--app', '--url', 'https://x.com/'])).toThrow(/--url/);
    expect(() => parseArgs(['--app-dev', '--url', 'https://x.com/'])).toThrow(/--url/);
  });

  it('--hello-check は --app / --app-dev と組み合わせて使う', () => {
    const built = parseArgs(['--app', '--hello-check']);
    expect(built.appMode).toBe('built');
    expect(built.helloCheck).toBe(true);
    const dev = parseArgs(['--app-dev', '--hello-check']);
    expect(dev.appMode).toBe('dev');
    expect(dev.helloCheck).toBe(true);
  });

  it('--hello-check だけではアプリが決まらないので受け付けない', () => {
    expect(() => parseArgs(['--hello-check'])).toThrow(/--hello-check/);
    expect(() => parseArgs(['--hello-check', '--url', 'https://x.com/'])).toThrow(/--hello-check/);
  });
});

describe('appFileUrl', () => {
  it('dist/index.html の file:// URL を返す', () => {
    const url = appFileUrl();
    expect(url.startsWith('file://')).toBe(true);
    expect(url.endsWith('/dist/index.html')).toBe(true);
  });

  it('dist/index.html が無ければビルドを促すエラーにする', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'xmgr-no-dist-'));
    try {
      expect(() => appFileUrl(empty)).toThrow(/npm run build/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });

  it('dist/index.html があればその場所の file:// URL を返す', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xmgr-dist-'));
    try {
      fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(root, 'dist', 'index.html'), '<html></html>');
      expect(appFileUrl(root)).toBe(`file://${path.join(root, 'dist', 'index.html')}`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('parseProxyArg', () => {
  it('http / socks5 の host:port を読む', () => {
    expect(parseProxyArg('http://proxy.example.com:8080')).toEqual({
      scheme: 'http',
      host: 'proxy.example.com',
      port: 8080,
    });
    expect(parseProxyArg('socks5://user:pass@127.0.0.1:1080')).toEqual({
      scheme: 'socks5',
      host: '127.0.0.1',
      port: 1080,
      username: 'user',
      password: 'pass',
    });
  });

  it('不正な scheme・port 無し・不正な URL は受け付けない', () => {
    expect(() => parseProxyArg('ftp://proxy.example.com:21')).toThrow(/scheme/);
    expect(() => parseProxyArg('http://proxy.example.com')).toThrow(/port/);
    expect(() => parseProxyArg('not-a-url')).toThrow(/プロキシ/);
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
          preload: expect.stringContaining('preload.cjs'),
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

  it('proxy / cookies を渡すと読み込み前に session へ設定する', async () => {
    const f = fakeElectron();
    const setProxy = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockResolvedValue(undefined);
    f.electron.session.fromPartition.mockReturnValue({ setProxy, cookies: { set } });
    await createHostWindow(f.electron, {
      accountId: 'korosukeada',
      url: 'https://x.com/',
      proxy: { scheme: 'http', host: 'proxy.example.com', port: 8080 },
      cookies: [{ name: 'ct0', value: 'csrf-token' }],
    });
    expect(setProxy).toHaveBeenCalledWith({ proxyRules: 'http://proxy.example.com:8080' });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'ct0', value: 'csrf-token' }),
    );
    expect(f.loadURL).toHaveBeenCalledWith('https://x.com/');
  });

  it('proxy / cookies を渡さなければ session には触らない', async () => {
    const f = fakeElectron();
    const setProxy = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockResolvedValue(undefined);
    f.electron.session.fromPartition.mockReturnValue({ setProxy, cookies: { set } });
    await createHostWindow(f.electron, { accountId: 'korosukeada', url: 'https://x.com/' });
    expect(setProxy).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
    expect(f.loadURL).toHaveBeenCalledWith('https://x.com/');
  });
});

describe('runHelloCheck', () => {
  it('アプリ画面で hello を送り hello-ack が返れば ok と hostVersion を返す', async () => {
    const f = fakeElectron();
    const result = await runHelloCheck(f.electron, {
      accountId: 'smoke',
      url: 'http://localhost:5173/',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostVersion).toBe('0.1.0');
      expect(result.url).toBe('https://x.com/');
    }
    // ページ文脈でブリッジの invoke に hello を送っていること。
    expect(f.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('xManagerDesktop'));
    expect(f.executeJavaScript).toHaveBeenCalledWith(expect.stringContaining('hello'));
    expect(f.loadURL).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it('スクリーンショット指定時は capturePage して保存する', async () => {
    const f = fakeElectron();
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const shot = path.join(os.tmpdir(), `xmgr-hello-${Date.now()}.png`);
    try {
      const result = await runHelloCheck(f.electron, {
        accountId: 'smoke',
        url: 'http://localhost:5173/',
        screenshotPath: shot,
      });
      expect(result.ok).toBe(true);
      expect(f.capturePage).toHaveBeenCalled();
      expect(fs.existsSync(shot)).toBe(true);
      if (result.ok) expect(result.screenshot).toBe(shot);
    } finally {
      if (fs.existsSync(shot)) fs.unlinkSync(shot);
    }
  });

  it('ブリッジが無ければ ok:false と理由を返す（例外を投げない）', async () => {
    const f = fakeElectron();
    f.executeJavaScript.mockRejectedValueOnce(
      new Error('デスクトップブリッジが見つかりません'),
    );
    const result = await runHelloCheck(f.electron, {
      accountId: 'smoke',
      url: 'http://localhost:5173/',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ブリッジ');
  });

  it('hello-ack の形が壊れていれば ok:false にする', async () => {
    const f = fakeElectron();
    f.executeJavaScript.mockResolvedValueOnce({ kind: 'result', ok: true });
    const result = await runHelloCheck(f.electron, {
      accountId: 'smoke',
      url: 'http://localhost:5173/',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('hello-ack');
  });

  it('読み込み失敗時は ok:false と理由を返す（例外を投げない）', async () => {
    const f = fakeElectron();
    f.loadURL.mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'));
    const result = await runHelloCheck(f.electron, {
      accountId: 'smoke',
      url: 'http://localhost:5173/',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ERR_CONNECTION_REFUSED');
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
