import { describe, expect, it, vi } from 'vitest';
import {
  applyProxy,
  buildProxyRules,
  configureSession,
  getSessionStatus,
  setSessionCookies,
  verifySession,
} from './session.cjs';

/** session.cookies の最小の偽物。 */
function fakeSession(overrides = {}) {
  const setProxy = vi.fn().mockResolvedValue(undefined);
  const resolveProxy = vi.fn().mockResolvedValue('PROXY proxy.example.com:8080');
  const set = vi.fn().mockResolvedValue(undefined);
  const get = vi.fn().mockResolvedValue([]);
  return {
    session: {
      setProxy,
      resolveProxy,
      cookies: { set, get },
      ...overrides,
    },
    setProxy,
    resolveProxy,
    set,
    get,
  };
}

describe('buildProxyRules', () => {
  it('未指定なら直接接続', () => {
    expect(buildProxyRules(null)).toEqual({ proxyRules: 'direct://' });
    expect(buildProxyRules(undefined)).toEqual({ proxyRules: 'direct://' });
  });

  it('http / https / socks5 の host:port を rules にする', () => {
    expect(buildProxyRules({ scheme: 'http', host: 'proxy.example.com', port: 8080 })).toEqual({
      proxyRules: 'http://proxy.example.com:8080',
    });
    expect(buildProxyRules({ scheme: 'socks5', host: '127.0.0.1', port: 1080 })).toEqual({
      proxyRules: 'socks5://127.0.0.1:1080',
    });
  });

  it('認証情報は URL エンコードして rules に入れる', () => {
    expect(
      buildProxyRules({
        scheme: 'https',
        host: 'proxy.example.com',
        port: 3128,
        username: 'user',
        password: 'p@ss:word',
      }),
    ).toEqual({ proxyRules: 'https://user:p%40ss%3Aword@proxy.example.com:3128' });
  });

  it('bypass は ; 区切りで proxyBypassRules にする', () => {
    expect(
      buildProxyRules({
        scheme: 'http',
        host: 'proxy.example.com',
        port: 8080,
        bypass: ['localhost', '127.0.0.1'],
      }),
    ).toEqual({
      proxyRules: 'http://proxy.example.com:8080',
      proxyBypassRules: 'localhost;127.0.0.1',
    });
  });

  it('不正な scheme・host・port・認証・bypass は受け付けない', () => {
    expect(() => buildProxyRules({ scheme: 'ftp', host: 'h', port: 80 })).toThrow(/scheme/);
    expect(() => buildProxyRules({ scheme: 'http', host: '', port: 80 })).toThrow(/host/);
    expect(() => buildProxyRules({ scheme: 'http', host: 'a b', port: 80 })).toThrow(/host/);
    expect(() => buildProxyRules({ scheme: 'http', host: 'h', port: 0 })).toThrow(/port/);
    expect(() => buildProxyRules({ scheme: 'http', host: 'h', port: 65536 })).toThrow(/port/);
    expect(() => buildProxyRules({ scheme: 'http', host: 'h', port: 80.5 })).toThrow(/port/);
    expect(() => buildProxyRules({ scheme: 'http', host: 'h', port: 80, username: '' })).toThrow(/username/);
    expect(() => buildProxyRules({ scheme: 'http', host: 'h', port: 80, username: 'u' })).toThrow(/password/);
    expect(() =>
      buildProxyRules({ scheme: 'http', host: 'h', port: 80, bypass: 'localhost' }),
    ).toThrow(/bypass/);
    expect(() => buildProxyRules('http://proxy:8080')).toThrow(/プロキシ設定/);
  });
});

describe('applyProxy', () => {
  it('setProxy を rules で呼ぶ', async () => {
    const f = fakeSession();
    const rules = await applyProxy(f.session, {
      scheme: 'http',
      host: 'proxy.example.com',
      port: 8080,
    });
    expect(f.setProxy).toHaveBeenCalledWith({ proxyRules: 'http://proxy.example.com:8080' });
    expect(rules).toEqual({ proxyRules: 'http://proxy.example.com:8080' });
  });

  it('未指定なら direct:// を設定する', async () => {
    const f = fakeSession();
    await applyProxy(f.session, null);
    expect(f.setProxy).toHaveBeenCalledWith({ proxyRules: 'direct://' });
  });

  it('setProxy が無い session は受け付けない', async () => {
    await expect(applyProxy({}, null)).rejects.toThrow(/setProxy/);
  });
});

describe('setSessionCookies', () => {
  it('auth_token と ct0 を x.com に設定する（値は返さない）', async () => {
    const f = fakeSession();
    const names = await setSessionCookies(f.session, [
      { name: 'auth_token', value: 'secret-token' },
      { name: 'ct0', value: 'csrf-token' },
    ]);
    expect(names).toEqual(['auth_token', 'ct0']);
    expect(f.set).toHaveBeenCalledTimes(2);
    expect(f.set).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        url: 'https://x.com/',
        name: 'auth_token',
        value: 'secret-token',
        domain: '.x.com',
        path: '/',
        secure: true,
        httpOnly: true,
      }),
    );
    expect(f.set).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ name: 'ct0', value: 'csrf-token', httpOnly: false }),
    );
  });

  it('auth_token / ct0 以外・空の値・不正な domain は受け付けない', async () => {
    const f = fakeSession();
    await expect(setSessionCookies(f.session, [{ name: 'other', value: 'x' }])).rejects.toThrow(
      /auth_token \/ ct0/,
    );
    await expect(setSessionCookies(f.session, [{ name: 'ct0', value: '' }])).rejects.toThrow(/値/);
    await expect(
      setSessionCookies(f.session, [{ name: 'ct0', value: 'x', domain: 'evil.example.com' }]),
    ).rejects.toThrow(/domain/);
    expect(f.set).not.toHaveBeenCalled();
  });

  it('cookies.set が無い session は受け付けない', async () => {
    await expect(setSessionCookies({}, [{ name: 'ct0', value: 'x' }])).rejects.toThrow(/cookies/);
  });
});

describe('getSessionStatus', () => {
  it('Cookie の有無だけを返し、値は含めない', async () => {
    const f = fakeSession();
    f.get.mockResolvedValue([
      { name: 'auth_token', value: 'secret-token' },
      { name: 'ct0', value: 'csrf-token' },
    ]);
    const status = await getSessionStatus(f.session);
    expect(status).toEqual({
      hasAuthToken: true,
      hasCt0: true,
      cookieNames: ['auth_token', 'ct0'],
    });
    expect(JSON.stringify(status)).not.toContain('secret-token');
    expect(f.get).toHaveBeenCalledWith({ url: 'https://x.com/' });
  });

  it('Cookie が無ければ両方 false', async () => {
    const f = fakeSession();
    expect(await getSessionStatus(f.session)).toEqual({
      hasAuthToken: false,
      hasCt0: false,
      cookieNames: [],
    });
  });
});

describe('verifySession', () => {
  it('プロキシ適用＋解決結果＋Cookie 有無を返す', async () => {
    const f = fakeSession();
    f.get.mockResolvedValue([{ name: 'auth_token', value: 't' }]);
    const result = await verifySession(f.session, {
      scheme: 'http',
      host: 'proxy.example.com',
      port: 8080,
    });
    expect(result).toEqual({
      ok: true,
      proxy: 'PROXY proxy.example.com:8080',
      hasAuthToken: true,
      hasCt0: false,
      cookieNames: ['auth_token'],
    });
    expect(f.resolveProxy).toHaveBeenCalledWith('https://x.com/');
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('resolveProxy が無ければ適用した rules を返す', async () => {
    const f = fakeSession();
    delete f.session.resolveProxy;
    const result = await verifySession(f.session, null);
    expect(result.ok).toBe(true);
    expect(result.proxy).toBe('direct://');
  });

  it('失敗時は ok:false と理由を返す（例外を投げない）', async () => {
    const f = fakeSession();
    f.setProxy.mockRejectedValueOnce(new Error('proxy failed'));
    const result = await verifySession(f.session, null);
    expect(result).toEqual({ ok: false, error: 'proxy failed' });
  });
});

describe('configureSession', () => {
  it('proxy と cookies を両方設定する', async () => {
    const f = fakeSession();
    await configureSession(f.session, {
      proxy: { scheme: 'http', host: 'proxy.example.com', port: 8080 },
      cookies: [{ name: 'ct0', value: 'csrf-token' }],
    });
    expect(f.setProxy).toHaveBeenCalledTimes(1);
    expect(f.set).toHaveBeenCalledTimes(1);
  });

  it('未指定なら何も触らない（D-02 の動作を保つ）', async () => {
    const f = fakeSession();
    await configureSession(f.session, {});
    expect(f.setProxy).not.toHaveBeenCalled();
    expect(f.set).not.toHaveBeenCalled();
  });
});
