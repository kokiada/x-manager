import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  EXTENSION_SOURCE,
  MEDIA_CHUNK_SIZE,
  PAGE_SOURCE,
  POPUP_SOURCE,
  PROTOCOL_VERSION,
  helloAckDiagnostics,
  isExtensionMessage,
  isHelloAck,
  isJobResult,
  isMediaChunkAck,
  isMediaChunkMessage,
  isSessionsMessage,
  normalizeSessionsMessage,
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

  it('hello-ack の診断は有るものだけ取り出し、無い・壊れたものは null', () => {
    // 新しい拡張：診断付き
    expect(
      helloAckDiagnostics({
        source: EXTENSION_SOURCE,
        kind: 'hello-ack',
        version: 1,
        extensionVersion: '0.1.0',
        diagnostics: { cookiesApi: true },
      }),
    ).toEqual({ cookiesApi: true });
    expect(
      helloAckDiagnostics({
        source: EXTENSION_SOURCE,
        kind: 'hello-ack',
        version: 1,
        extensionVersion: '0.1.0',
        diagnostics: { cookiesApi: false },
      }),
    ).toEqual({ cookiesApi: false });
    // 古い拡張：診断が無いので「不明」
    expect(
      helloAckDiagnostics({
        source: EXTENSION_SOURCE,
        kind: 'hello-ack',
        version: 1,
        extensionVersion: '0.1.0',
      }),
    ).toBe(null);
    // 形が壊れた診断も「不明」として扱い、疎通自体は通す
    expect(
      helloAckDiagnostics({
        source: EXTENSION_SOURCE,
        kind: 'hello-ack',
        version: 1,
        extensionVersion: '0.1.0',
        diagnostics: { cookiesApi: 'yes' },
      }),
    ).toBe(null);
    expect(helloAckDiagnostics(null)).toBe(null);
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

  it('sessions メッセージを正しく判定する（新形式・旧形式）', () => {
    // 新形式：ID＋ハンドル
    expect(
      isSessionsMessage({
        source: EXTENSION_SOURCE,
        kind: 'sessions',
        sessions: [
          { accountId: 'a', handle: 'foo' },
          { accountId: 'b', handle: null },
        ],
      }),
    ).toBe(true);
    expect(
      isSessionsMessage({
        source: EXTENSION_SOURCE,
        kind: 'sessions',
        sessions: [{ accountId: 'a', handle: 1 }],
      }),
    ).toBe(false);
    expect(
      isSessionsMessage({
        source: EXTENSION_SOURCE,
        kind: 'sessions',
        sessions: [{ handle: 'foo' }],
      }),
    ).toBe(false);
    // 旧形式：IDだけ（後方互換）
    expect(
      isSessionsMessage({ source: EXTENSION_SOURCE, kind: 'sessions', accountIds: ['a', 'b'] }),
    ).toBe(true);
    expect(
      isSessionsMessage({ source: EXTENSION_SOURCE, kind: 'sessions', accountIds: ['a', 1] }),
    ).toBe(false);
    // どちらも無ければ弾く
    expect(isSessionsMessage({ source: EXTENSION_SOURCE, kind: 'sessions' })).toBe(false);
  });

  it('normalizeSessionsMessage は新旧どちらの形も揃える', () => {
    // 新形式：@付きハンドルは外し、空のハンドルは null にする
    expect(
      normalizeSessionsMessage({
        source: EXTENSION_SOURCE,
        kind: 'sessions',
        sessions: [
          { accountId: 'a', handle: '@foo' },
          { accountId: 'b', handle: '' },
          { accountId: 'c', handle: null },
        ],
      }),
    ).toEqual([
      { accountId: 'a', handle: 'foo' },
      { accountId: 'b', handle: null },
      { accountId: 'c', handle: null },
    ]);
    // 旧形式：ハンドル null に変換する
    expect(
      normalizeSessionsMessage({
        source: EXTENSION_SOURCE,
        kind: 'sessions',
        accountIds: ['a', 'b'],
      }),
    ).toEqual([
      { accountId: 'a', handle: null },
      { accountId: 'b', handle: null },
    ]);
    // ID の空文字と重複は落とす
    expect(
      normalizeSessionsMessage({
        source: EXTENSION_SOURCE,
        kind: 'sessions',
        sessions: [
          { accountId: 'a', handle: 'x' },
          { accountId: 'a', handle: 'y' },
          { accountId: '', handle: 'z' },
        ],
      }),
    ).toEqual([{ accountId: 'a', handle: 'x' }]);
    // 壊れたメッセージは空になる
    expect(normalizeSessionsMessage({ source: EXTENSION_SOURCE, kind: 'sessions' })).toEqual([]);
    expect(normalizeSessionsMessage(null)).toEqual([]);
  });

  it('isExtensionMessage は拡張からの3種だけ通す', () => {
    expect(
      isExtensionMessage({ source: EXTENSION_SOURCE, kind: 'hello-ack', version: 1 }),
    ).toBe(true);
    expect(isExtensionMessage({ source: PAGE_SOURCE, kind: 'hello', version: 1 })).toBe(false);
    expect(isExtensionMessage(null)).toBe(false);
    expect(isExtensionMessage('x-manager-extension')).toBe(false);
  });

  it('media-chunk / media-chunk-ack を正しく判定する', () => {
    expect(
      isMediaChunkMessage({
        source: PAGE_SOURCE,
        kind: 'media-chunk',
        uploadId: 'u1',
        index: 0,
        totalChunks: 2,
        data: 'aGVsbG8=',
      }),
    ).toBe(true);
    expect(
      isMediaChunkMessage({
        source: PAGE_SOURCE,
        kind: 'media-chunk',
        uploadId: 'u1',
        index: 2,
        totalChunks: 2,
        data: 'aGVsbG8=',
      }),
    ).toBe(false);
    expect(
      isMediaChunkMessage({
        source: PAGE_SOURCE,
        kind: 'media-chunk',
        uploadId: 'u1',
        index: 0,
        totalChunks: 0,
        data: 'aGVsbG8=',
      }),
    ).toBe(false);
    expect(
      isMediaChunkMessage({
        source: EXTENSION_SOURCE,
        kind: 'media-chunk',
        uploadId: 'u1',
        index: 0,
        totalChunks: 1,
        data: 'aGVsbG8=',
      }),
    ).toBe(false);
    expect(
      isMediaChunkAck({
        source: EXTENSION_SOURCE,
        kind: 'media-chunk-ack',
        uploadId: 'u1',
        index: 0,
      }),
    ).toBe(true);
    expect(
      isMediaChunkAck({
        source: EXTENSION_SOURCE,
        kind: 'media-chunk-ack',
        uploadId: 'u1',
        index: 0,
        error: '壊れたデータです。',
      }),
    ).toBe(true);
    expect(
      isMediaChunkAck({
        source: PAGE_SOURCE,
        kind: 'media-chunk-ack',
        uploadId: 'u1',
        index: 0,
      }),
    ).toBe(false);
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
    expect(mirror).toContain(`POPUP_SOURCE: '${POPUP_SOURCE}'`);
    expect(mirror).toContain(`MEDIA_CHUNK_SIZE: ${MEDIA_CHUNK_SIZE}`);
    // 連携一覧の正規化ヘルパーもミラー側にあること
    expect(mirror).toContain('normalizeSessions');
    // メディアチャンクもミラー側の isPageMessage が通すこと
    expect(mirror).toContain(`'media-chunk'`);
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
