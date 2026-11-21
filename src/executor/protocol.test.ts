import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_SOURCE,
  PAGE_SOURCE,
  PROTOCOL_VERSION,
  isExtensionMessage,
  isHelloAck,
  isJobResult,
  isSessionsMessage,
} from './protocol';

describe('protocol validators', () => {
  it('hello-ack を正しく判定する', () => {
    expect(
      isHelloAck({
        source: EXTENSION_SOURCE,
        kind: 'hello-ack',
        version: 1,
        extensionVersion: '0.1.0',
      }),
    ).toBe(true);
    expect(isHelloAck({ source: EXTENSION_SOURCE, kind: 'hello-ack', version: 1 })).toBe(false);
    expect(isHelloAck({ source: PAGE_SOURCE, kind: 'hello', version: 1 })).toBe(false);
  });

  it('job result を正しく判定する', () => {
    expect(
      isJobResult({
        source: EXTENSION_SOURCE,
        kind: 'result',
        id: 'job-1',
        ok: true,
        data: { postId: '123' },
        at: 1,
      }),
    ).toBe(true);
    expect(
      isJobResult({
        source: EXTENSION_SOURCE,
        kind: 'result',
        id: 'job-1',
        ok: false,
        error: 'だめでした',
        code: 'not_implemented',
        at: 1,
      }),
    ).toBe(true);
    // id が無いものは別ジョブの結果かもしれないので弾く
    expect(isJobResult({ source: EXTENSION_SOURCE, kind: 'result', ok: true, at: 1 })).toBe(false);
    // 送信元が違うものは弾く
    expect(
      isJobResult({ source: PAGE_SOURCE, kind: 'result', id: 'job-1', ok: true, at: 1 }),
    ).toBe(false);
  });

  it('sessions メッセージを正しく判定する', () => {
    expect(
      isSessionsMessage({ source: EXTENSION_SOURCE, kind: 'sessions', accountIds: ['a', 'b'] }),
    ).toBe(true);
    expect(
      isSessionsMessage({ source: EXTENSION_SOURCE, kind: 'sessions', accountIds: ['a', 1] }),
    ).toBe(false);
  });

  it('isExtensionMessage は拡張からの3種だけ通す', () => {
    expect(
      isExtensionMessage({ source: EXTENSION_SOURCE, kind: 'hello-ack', version: 1 }),
    ).toBe(true);
    expect(isExtensionMessage({ source: PAGE_SOURCE, kind: 'hello', version: 1 })).toBe(false);
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage('x-manager-extension')).toBe(false);
  });
});

describe('extension/src/protocol.js との同期', () => {
  it('拡張側のミラーが正本と同じ定数を持つ', () => {
    const mirror = readFileSync(
      new URL('../../extension/src/protocol.js', import.meta.url),
      'utf8',
    );
    expect(mirror).toContain(`VERSION: ${PROTOCOL_VERSION}`);
    expect(mirror).toContain(`PAGE_SOURCE: '${PAGE_SOURCE}'`);
    expect(mirror).toContain(`EXTENSION_SOURCE: '${EXTENSION_SOURCE}'`);
    for (const method of [
      'executePost',
      'deletePost',
      'executeAction',
      'checkAccount',
      'checkSearchBan',
      'fetchPostAnalytics',
      'fetchNotifications',
    ]) {
      expect(mirror).toContain(`'${method}'`);
    }
  });
});
