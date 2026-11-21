import { describe, expect, it } from 'vitest';
import { checkExtensionConnection } from './extensionStatus';
import { ExtensionNotConnectedError, type ExtensionTransport } from './transport';

function fakeTransport(overrides: Partial<ExtensionTransport>): ExtensionTransport {
  return {
    ping: async () => ({ version: 1, extensionVersion: '0.1.0' }),
    sendJob: async () => ({ id: 'x', ok: true, at: 0 }),
    listSessions: async () => [],
    ...overrides,
  };
}

describe('checkExtensionConnection', () => {
  it('接続時は版と連携アカウント一覧を返す', async () => {
    const transport = fakeTransport({
      listSessions: async () => [
        { accountId: 'a', handle: 'foo' },
        { accountId: 'b', handle: null },
      ],
    });
    await expect(checkExtensionConnection(transport)).resolves.toEqual({
      connected: true,
      version: 1,
      extensionVersion: '0.1.0',
      linkedSessions: [
        { accountId: 'a', handle: 'foo' },
        { accountId: 'b', handle: null },
      ],
      linkedAccountIds: ['a', 'b'],
      // 診断を返さない古い拡張は「不明」
      cookiesApiOk: null,
    });
  });

  it('診断付きの ping は Cookie API の可否をそのまま返す', async () => {
    const okTransport = fakeTransport({
      ping: async () => ({
        version: 1,
        extensionVersion: '0.1.0',
        diagnostics: { cookiesApi: true },
      }),
    });
    await expect(checkExtensionConnection(okTransport)).resolves.toMatchObject({
      connected: true,
      cookiesApiOk: true,
    });

    const brokenTransport = fakeTransport({
      ping: async () => ({
        version: 1,
        extensionVersion: '0.1.0',
        diagnostics: { cookiesApi: false },
      }),
    });
    await expect(checkExtensionConnection(brokenTransport)).resolves.toMatchObject({
      connected: true,
      cookiesApiOk: false,
    });
  });

  it('未接続でも例外を投げず connected:false を返す', async () => {
    const transport = fakeTransport({
      ping: async () => {
        throw new ExtensionNotConnectedError();
      },
    });
    const result = await checkExtensionConnection(transport);
    expect(result.connected).toBe(false);
    expect(result.error).toContain('拡張');
  });
});
