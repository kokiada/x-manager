import { describe, expect, it } from 'vitest';
import { checkExtensionReady } from './extensionPrecheck';
import type { ExtensionTransport } from '../executor/transport';

function fakeTransport(overrides: Partial<ExtensionTransport>): ExtensionTransport {
  return {
    ping: async () => ({ version: 1, extensionVersion: '0.1.0' }),
    sendJob: async () => ({ id: 'x', ok: true, at: 0 }),
    listSessions: async () => [],
    sendMedia: async () => {},
    ...overrides,
  };
}

describe('checkExtensionReady', () => {
  it('診断が無くても（古い拡張）疎通が通れば ok', async () => {
    await expect(checkExtensionReady(fakeTransport({}))).resolves.toEqual({ ok: true });
  });

  it('Cookie API が使える診断なら ok', async () => {
    const transport = fakeTransport({
      ping: async () => ({
        version: 1,
        extensionVersion: '0.1.0',
        diagnostics: { cookiesApi: true },
      }),
    });
    await expect(checkExtensionReady(transport)).resolves.toEqual({ ok: true });
  });

  it('Cookie API が使えない診断なら再読み込みを促して止める', async () => {
    const transport = fakeTransport({
      ping: async () => ({
        version: 1,
        extensionVersion: '0.1.0',
        diagnostics: { cookiesApi: false },
      }),
    });
    const result = await checkExtensionReady(transport);
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('再読み込み'),
    });
    expect(result).toEqual({
      ok: false,
      message: expect.stringContaining('Cookie'),
    });
  });

  it('拡張が未接続なら接続エラーの文言で止める', async () => {
    // 既定の輸送層は window が無い環境では未接続になる。
    const result = await checkExtensionReady();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('拡張');
  });
});
