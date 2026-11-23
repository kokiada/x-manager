import { describe, expect, it, vi } from 'vitest';
import {
  VERIFY_CREDENTIALS_URL,
  buildReadCheckScript,
  classifyReadCheckResult,
  parseVerifyCredentials,
  runReadCheck,
  runReadCheckForAccount,
} from './readCheck.cjs';

/** 成功時の verify_credentials 応答（実データ相当の形）。 */
const SUCCESS_BODY = JSON.stringify({
  id: 123456789,
  id_str: '123456789',
  screen_name: 'korosukeada',
  name: 'ころすけ',
});

/** ページ文脈スクリプトを Node 上で動かすための document / fetch の差し替え。 */
function withPageStubs({ cookie = 'ct0=csrf-token-abc; auth_token=secret', fetchImpl }) {
  const prevDocument = globalThis.document;
  const prevFetch = globalThis.fetch;
  globalThis.document = { cookie };
  globalThis.fetch = fetchImpl;
  return () => {
    if (prevDocument === undefined) delete globalThis.document;
    else globalThis.document = prevDocument;
    if (prevFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = prevFetch;
  };
}

describe('buildReadCheckScript', () => {
  it('verify_credentials の URL・ct0 ヘッダ・credentials:include を含む', () => {
    const script = buildReadCheckScript();
    expect(script).toContain(VERIFY_CREDENTIALS_URL);
    expect(script).toContain('x-csrf-token');
    expect(script).toContain("credentials: 'include'");
    expect(script).toContain('x-twitter-auth-type');
    expect(script).toContain('AbortSignal.timeout');
    // auth_token の値をスクリプトに埋め込まない（ページ文脈の Cookie に任せる）。
    expect(script).not.toContain('auth_token=');
    expect(script).not.toContain('authorization');
  });

  it('スタブ fetch で成功応答を { status, body } で返す', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => SUCCESS_BODY,
    });
    const restore = withPageStubs({ fetchImpl });
    try {
      // eslint-disable-next-line no-eval
      const result = await eval(buildReadCheckScript());
      expect(result).toEqual({ status: 200, body: SUCCESS_BODY });
      expect(fetchImpl).toHaveBeenCalledWith(
        VERIFY_CREDENTIALS_URL,
        expect.objectContaining({
          method: 'GET',
          credentials: 'include',
          headers: expect.objectContaining({ 'x-csrf-token': 'csrf-token-abc' }),
        }),
      );
    } finally {
      restore();
    }
  });

  it('ct0 が Cookie に無いときは空文字で送る', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ status: 200, text: async () => SUCCESS_BODY });
    const restore = withPageStubs({ cookie: 'auth_token=secret', fetchImpl });
    try {
      // eslint-disable-next-line no-eval
      await eval(buildReadCheckScript());
      expect(fetchImpl).toHaveBeenCalledWith(
        VERIFY_CREDENTIALS_URL,
        expect.objectContaining({
          headers: expect.objectContaining({ 'x-csrf-token': '' }),
        }),
      );
    } finally {
      restore();
    }
  });

  it('fetch が投げたら { status: 0, error } を返す', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('Failed to fetch'));
    const restore = withPageStubs({ fetchImpl });
    try {
      // eslint-disable-next-line no-eval
      const result = await eval(buildReadCheckScript());
      expect(result).toEqual({ status: 0, error: 'Failed to fetch' });
    } finally {
      restore();
    }
  });
});

describe('parseVerifyCredentials', () => {
  it('id_str と screen_name を取る', () => {
    expect(parseVerifyCredentials({ id_str: '123456789', screen_name: 'korosukeada' })).toEqual({
      id: '123456789',
      handle: 'korosukeada',
    });
  });

  it('id（数値）だけのときは文字列化する', () => {
    expect(parseVerifyCredentials({ id: 123456789, screen_name: 'korosukeada' })).toEqual({
      id: '123456789',
      handle: 'korosukeada',
    });
  });

  it('id・handle のどちらかが欠けたら投げる', () => {
    expect(() => parseVerifyCredentials({ screen_name: 'korosukeada' })).toThrow(/確認できませんでした/);
    expect(() => parseVerifyCredentials({ id_str: '123456789' })).toThrow(/確認できませんでした/);
    expect(() => parseVerifyCredentials({})).toThrow(/確認できませんでした/);
    expect(() => parseVerifyCredentials(null)).toThrow(/確認できませんでした/);
  });
});

describe('classifyReadCheckResult', () => {
  it('200 の正常応答は { id, handle } を返す', () => {
    expect(classifyReadCheckResult({ status: 200, body: SUCCESS_BODY })).toEqual({
      ok: true,
      id: '123456789',
      handle: 'korosukeada',
    });
  });

  it('status 0（通信失敗）はネットワーク文言で返す', () => {
    const result = classifyReadCheckResult({ status: 0, error: 'Failed to fetch' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('通信に失敗しました');
    expect(result.error).toContain('Failed to fetch');
  });

  it('429 はレートリミット文言で返す', () => {
    const result = classifyReadCheckResult({ status: 429, body: '' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('レートリミット');
  });

  it('401 / 403 は確認できない文言で返す', () => {
    for (const status of [401, 403]) {
      const result = classifyReadCheckResult({ status, body: '' });
      expect(result.ok).toBe(false);
      expect(result.error).toContain('確認できませんでした');
    }
  });

  it('その他の非 2xx は HTTP ステータスと X のエラー詳細を返す', () => {
    const result = classifyReadCheckResult({
      status: 422,
      body: JSON.stringify({ errors: [{ message: 'Invalid credentials' }] }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 422');
    expect(result.error).toContain('Invalid credentials');
  });

  it('非 2xx で本文が JSON でなければ本文の先頭を付ける', () => {
    const result = classifyReadCheckResult({ status: 500, body: 'Internal Server Error' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('HTTP 500');
    expect(result.error).toContain('Internal Server Error');
  });

  it('200 でも JSON でなければ読み取れない文言で返す', () => {
    const result = classifyReadCheckResult({ status: 200, body: '<html>not json</html>' });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('読み取れませんでした');
  });

  it('200 で errors 配列があれば X のエラー文言で返す', () => {
    const result = classifyReadCheckResult({
      status: 200,
      body: JSON.stringify({ errors: [{ message: 'Bad Authentication data.' }] }),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Xがエラーを返しました');
    expect(result.error).toContain('Bad Authentication data.');
  });

  it('200 で id・handle が欠けたら確認できない文言で返す', () => {
    const result = classifyReadCheckResult({ status: 200, body: JSON.stringify({}) });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('確認できませんでした');
  });

  it('結果がオブジェクトでなければ読み取れない文言で返す', () => {
    expect(classifyReadCheckResult(null).ok).toBe(false);
    expect(classifyReadCheckResult('oops').error).toContain('読み取れませんでした');
  });
});

describe('runReadCheck', () => {
  /** webContents の最小の偽物。executeJavaScript の返り値を差し替える。 */
  function fakeWebContents(result) {
    const executeJavaScript = vi.fn().mockResolvedValue(result);
    return { webContents: { executeJavaScript }, executeJavaScript };
  }

  it('ページ文脈の成功応答から { id, handle } を返す', async () => {
    const f = fakeWebContents({ status: 200, body: SUCCESS_BODY });
    const result = await runReadCheck(f.webContents);
    expect(result).toEqual({ ok: true, id: '123456789', handle: 'korosukeada' });
    expect(f.executeJavaScript).toHaveBeenCalledTimes(1);
    const script = f.executeJavaScript.mock.calls[0][0];
    expect(typeof script).toBe('string');
    expect(script).toContain(VERIFY_CREDENTIALS_URL);
  });

  it('401 の応答は ok:false を返す（例外を投げない）', async () => {
    const f = fakeWebContents({ status: 401, body: '' });
    const result = await runReadCheck(f.webContents);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('確認できませんでした');
  });

  it('executeJavaScript が拒否されたら ok:false を返す', async () => {
    const executeJavaScript = vi.fn().mockRejectedValue(new Error('Object has been destroyed'));
    const result = await runReadCheck({ executeJavaScript });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Object has been destroyed');
  });

  it('executeJavaScript が無い webContents は ok:false を返す', async () => {
    const result = await runReadCheck({});
    expect(result.ok).toBe(false);
    expect(result.error).toContain('executeJavaScript');
  });

  it('タイムアウトしたら ok:false を返す', async () => {
    const executeJavaScript = vi.fn().mockImplementation(() => new Promise(() => {}));
    const result = await runReadCheck({ executeJavaScript }, { timeoutMs: 10 });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('タイムアウト');
  });
});

describe('runReadCheckForAccount', () => {
  /** electron モジュールの最小の偽物（host.test.ts と同じ形＋close / executeJavaScript）。 */
  function fakeElectron(result) {
    const loadURL = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn();
    const executeJavaScript = vi.fn().mockResolvedValue(result);
    const window = { loadURL, close, webContents: { executeJavaScript } };
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
      close,
      executeJavaScript,
    };
  }

  it('partition のウィンドウで読み取り、終わったら閉じる', async () => {
    const f = fakeElectron({ status: 200, body: SUCCESS_BODY });
    const result = await runReadCheckForAccount(f.electron, {
      accountId: 'korosukeada',
      url: 'https://x.com/',
    });
    expect(result).toEqual({ ok: true, id: '123456789', handle: 'korosukeada' });
    expect(f.fromPartition).toHaveBeenCalledWith('persist:xmgr-korosukeada');
    expect(f.loadURL).toHaveBeenCalledWith('https://x.com/');
    expect(f.executeJavaScript).toHaveBeenCalledTimes(1);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('読み取り失敗時もウィンドウを閉じる', async () => {
    const f = fakeElectron({ status: 401, body: '' });
    const result = await runReadCheckForAccount(f.electron, {
      accountId: 'korosukeada',
      url: 'https://x.com/',
    });
    expect(result.ok).toBe(false);
    expect(f.close).toHaveBeenCalledTimes(1);
  });

  it('ウィンドウ生成に失敗したら ok:false を返す', async () => {
    const f = fakeElectron({ status: 200, body: SUCCESS_BODY });
    f.loadURL.mockRejectedValueOnce(new Error('ERR_NAME_NOT_RESOLVED'));
    const result = await runReadCheckForAccount(f.electron, {
      accountId: 'korosukeada',
      url: 'https://x.com/',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ERR_NAME_NOT_RESOLVED');
    expect(f.close).not.toHaveBeenCalled();
  });

  it('proxy / cookies を渡すと読み込み前に session へ設定する', async () => {
    const f = fakeElectron({ status: 200, body: SUCCESS_BODY });
    const setProxy = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockResolvedValue(undefined);
    f.electron.session.fromPartition.mockReturnValue({ setProxy, cookies: { set } });
    const result = await runReadCheckForAccount(f.electron, {
      accountId: 'korosukeada',
      url: 'https://x.com/',
      proxy: { scheme: 'http', host: 'proxy.example.com', port: 8080 },
      cookies: [{ name: 'ct0', value: 'csrf-token' }],
    });
    expect(result.ok).toBe(true);
    expect(setProxy).toHaveBeenCalledWith({ proxyRules: 'http://proxy.example.com:8080' });
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ name: 'ct0' }));
  });
});
