/**
 * extension/src/transactionId.js のテスト。
 *
 * 拡張の素の JS を node:vm で読み込み、fetch のスタブを差し込む。
 * Service Worker には DOM が無いので、ここでは合成したシェル HTML
 * （verification メタ・ondemand.s・loading-x-anim）で検証する。
 * 実シェルでの検証は、こうきくんの PC での一括投稿の再試行が担う。
 */
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type AnyRecord = Record<string, any>;

// keyBytes: [10,20,30,40,50,6,70,80,90,100,110,120,130,140,150,160]
// keyBytes[5]=6 → frames[2]、indices の先頭 2 → keyBytes[2]=30 → 行 14。
const KEY_BYTES = [10, 20, 30, 40, 50, 6, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160];
const VERIFICATION_KEY = Buffer.from(KEY_BYTES).toString('base64');
const ONDEMAND_HASH = 'abcdefg123';
const ONDEMAND_URL = `https://abs.twimg.com/responsive-web/client-web/ondemand.s.${ONDEMAND_HASH}a.js`;
const ONDEMAND_SOURCE =
  `var runtime = { 123: "ondemand.s", foo: 1 })[e] || e) + "." + ({ 123: "${ONDEMAND_HASH}" });\n` +
  `var idx = (k[2], 16); var a = (k[5], 16); var b = (k[7], 16); var c = (k[1], 16);`;

function animationPathD() {
  // d は "M12345678"（9文字）+ C セグメント16個。各セグメント12数値。
  const segment = 'C0 32 64 96 128 160 192 224 255 16 48 80';
  return `M12345678${segment.repeat(16)}`;
}

function homepageHtml() {
  const frames = [0, 1, 2, 3]
    .map(
      (i) =>
        `<g id="loading-x-anim-${i}"><g><path d="M11111111"/><path d="${i === 2 ? animationPathD() : 'M12345678C0 1 2 3 4 5 6 7 8 9 10 11'}"/></g><circle r="1"/></g>`,
    )
    .join('');
  return (
    `<html><head>` +
    `<meta name="twitter-site-verification" content="${VERIFICATION_KEY}">` +
    `<script>var runtime = { 123: "ondemand.s", foo: 1 })[e] || e) + "." + ({ 123: "${ONDEMAND_HASH}" });</script>` +
    `</head><body><svg>${frames}</svg></body></html>`
  );
}

function loadModule(fetchStub: AnyRecord) {
  const sandbox: AnyRecord = {
    console,
    AbortController,
    setTimeout,
    clearTimeout,
    TextEncoder,
    URL,
    crypto: webcrypto,
    btoa: globalThis.btoa,
    atob: globalThis.atob,
    fetch: fetchStub,
  };
  sandbox.self = sandbox;
  const ctx = createContext(sandbox);
  runInContext(
    readFileSync(new URL('../../extension/src/transactionId.js', import.meta.url), 'utf8'),
    ctx,
    { filename: 'transactionId.js' },
  );
  return sandbox as AnyRecord;
}

function textResponse(status: number, text: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Not Found',
    text: async () => text,
  };
}

function makeFetchStub() {
  const calls: Array<{ url: string; opts: any }> = [];
  const fn = async (url: string, opts: any = {}) => {
    calls.push({ url, opts });
    if (url === 'https://x.com/i/jf/') return textResponse(200, homepageHtml());
    if (url === ONDEMAND_URL) return textResponse(200, ONDEMAND_SOURCE);
    throw new Error(`unexpected fetch: ${url}`);
  };
  (fn as any).calls = calls;
  return fn as any;
}

function decodeId(id: string): Uint8Array {
  // 生成器は末尾の '=' を落とす。復元して読む。
  const padded = id + '='.repeat((4 - (id.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

describe('transactionId.js（x-client-transaction-id 生成器）', () => {
  it('シェルから鍵・index・アニメーション行を抜き出せる', async () => {
    const sandbox = loadModule(makeFetchStub());
    const t = sandbox.XManagerTransactionId;
    const internals = t._internals;
    expect(internals.getVerificationKey(homepageHtml())).toBe(VERIFICATION_KEY);
    expect(internals.getOnDemandFileUrl(homepageHtml())).toBe(ONDEMAND_URL);
    const indices = await internals.fetchKeyByteIndices(homepageHtml(), async (url: string) => {
      expect(url).toBe(ONDEMAND_URL);
      return textResponse(200, ONDEMAND_SOURCE);
    });
    expect(indices).toEqual({ rowIndex: 2, keyBytesIndices: [5, 7, 1] });
    const rows = internals.getAnimationFrameRows(homepageHtml(), KEY_BYTES);
    expect(rows).toHaveLength(17);
    expect(rows[14]).toEqual([0, 32, 64, 96, 128, 160, 192, 224, 255, 16, 48, 80]);
    const animationKey = internals.getAnimationKey(KEY_BYTES, indices, rows);
    expect(animationKey).toMatch(/^[0-9a-z]+$/);
    expect(animationKey.length).toBeGreaterThan(0);
  });

  it('トランザクションIDは決まった構造（鍵・時刻・ハッシュ・末尾3）になる', async () => {
    const sandbox = loadModule(makeFetchStub());
    const internals = sandbox.XManagerTransactionId._internals;
    const keys = { keyBytes: KEY_BYTES, animationKey: 'abc123' };
    const id = await internals.buildTransactionId(keys, 'POST', '/i/api/graphql/QID/CreateTweet', {
      timeNow: 100000,
      randomByteOverride: 7,
    });
    expect(typeof id).toBe('string');
    const bytes = decodeId(id);
    // 1（ランダム）+ 16（鍵）+ 4（時刻LE）+ 16（ハッシュ）+ 1（=3）
    expect(bytes).toHaveLength(38);
    expect(bytes[0]).toBe(7);
    const xor = (b: number) => b ^ 7;
    expect(Array.from(bytes.slice(1, 17)).map(xor)).toEqual(KEY_BYTES);
    expect(Array.from(bytes.slice(17, 21)).map(xor)).toEqual([0xa0, 0x86, 0x01, 0x00]);
    expect(xor(bytes[37])).toBe(3);
    // method・パスが違えば同じ時刻でも ID が変わる
    const other = await internals.buildTransactionId(keys, 'GET', '/i/api/graphql/QID/CreateTweet', {
      timeNow: 100000,
      randomByteOverride: 7,
    });
    expect(other).not.toBe(id);
  });

  it('生成器は初回に初期化し、2回目以降は取り直さない', async () => {
    const fetchStub = makeFetchStub();
    const sandbox = loadModule(fetchStub);
    const gen = sandbox.XManagerTransactionId.createGenerator({
      fetchImpl: fetchStub,
      now: () => 1795000000000,
      random: () => 0.5,
    });
    const id1 = await gen('POST', 'https://x.com/i/api/graphql/QID/CreateTweet');
    const id2 = await gen('POST', 'https://x.com/i/api/graphql/QID/CreateTweet');
    expect(typeof id1).toBe('string');
    expect(typeof id2).toBe('string');
    expect(fetchStub.calls.filter((c: AnyRecord) => c.url === 'https://x.com/i/jf/')).toHaveLength(1);
    expect(fetchStub.calls.filter((c: AnyRecord) => c.url === ONDEMAND_URL)).toHaveLength(1);
    // 生成された ID は鍵の構造を満たす
    const bytes = decodeId(id1);
    expect(bytes).toHaveLength(38);
    expect(bytes[0]).toBe(Math.floor(0.5 * 256));
  });

  it('シェルが取れない・鍵が無い・ondemand が取れないときは null を返す', async () => {
    const failingHome = async (url: string) => {
      if (url === 'https://x.com/i/jf/') return textResponse(403, 'denied');
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sandbox1 = loadModule(failingHome);
    const gen1 = sandbox1.XManagerTransactionId.createGenerator({ fetchImpl: failingHome });
    await expect(gen1('POST', 'https://x.com/i/api/graphql/QID/CreateTweet')).resolves.toBeNull();

    const noMeta = async (url: string) => {
      if (url === 'https://x.com/i/jf/') return textResponse(200, '<html><head></head><body></body></html>');
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sandbox2 = loadModule(noMeta);
    const gen2 = sandbox2.XManagerTransactionId.createGenerator({ fetchImpl: noMeta });
    await expect(gen2('POST', 'https://x.com/i/api/graphql/QID/CreateTweet')).resolves.toBeNull();

    const failingOndemand = async (url: string) => {
      if (url === 'https://x.com/i/jf/') return textResponse(200, homepageHtml());
      if (url === ONDEMAND_URL) return textResponse(404, 'not found');
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sandbox3 = loadModule(failingOndemand);
    const gen3 = sandbox3.XManagerTransactionId.createGenerator({ fetchImpl: failingOndemand });
    await expect(gen3('POST', 'https://x.com/i/api/graphql/QID/CreateTweet')).resolves.toBeNull();
  });

  it('URL が壊れていても null を返して落とさない', async () => {
    const fetchStub = makeFetchStub();
    const sandbox = loadModule(fetchStub);
    const gen = sandbox.XManagerTransactionId.createGenerator({ fetchImpl: fetchStub });
    await expect(gen('POST', 'not a url')).resolves.toBeNull();
  });

  it('probe は生成できる環境では ok:true を返し、鍵をキャッシュする', async () => {
    const fetchStub = makeFetchStub();
    const sandbox = loadModule(fetchStub);
    const gen = sandbox.XManagerTransactionId.createGenerator({ fetchImpl: fetchStub });
    await expect(gen.probe()).resolves.toEqual({ ok: true });
    // probe で初期化した鍵は、その後の生成でも取り直されない。
    const id = await gen('POST', 'https://x.com/i/api/graphql/QID/CreateTweet');
    expect(typeof id).toBe('string');
    expect(fetchStub.calls.filter((c: AnyRecord) => c.url === 'https://x.com/i/jf/')).toHaveLength(1);
  });

  it('probe は失敗の理由を返す（シェル取得失敗・メタタグ無し）', async () => {
    const failingHome = async (url: string) => {
      if (url === 'https://x.com/i/jf/') return textResponse(403, 'denied');
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sandbox1 = loadModule(failingHome);
    const gen1 = sandbox1.XManagerTransactionId.createGenerator({ fetchImpl: failingHome });
    const r1 = await gen1.probe();
    expect(r1.ok).toBe(false);
    expect(r1.error).toContain('403');

    const noMeta = async (url: string) => {
      if (url === 'https://x.com/i/jf/') return textResponse(200, '<html><head></head><body></body></html>');
      throw new Error(`unexpected fetch: ${url}`);
    };
    const sandbox2 = loadModule(noMeta);
    const gen2 = sandbox2.XManagerTransactionId.createGenerator({ fetchImpl: noMeta });
    const r2 = await gen2.probe();
    expect(r2.ok).toBe(false);
    expect(r2.error).toContain('twitter-site-verification');
  });
});
