/**
 * GraphQL query ID の解決。
 *
 * X の内部APIは操作ごとに不透明な query ID（ハッシュ）を要求し、
 * X が Web 版を更新するたびに数週間単位で変わる。維持方法は
 * 公開クライアント（twscrape / twikit など）と同じ二段構え：
 *
 *  1. ライブ解決：x.com のトップページから JS バンドル（abs.twimg.com）の
 *     URL を拾い、中身を走査して `/i/api/graphql/<id>/<操作名>` の組を
 *     見つける。見つかったものが最新。
 *  2. フォールバック：下の FALLBACK_IDS。2026-02 時点の公開情報に
 *     基づくもので、古くなっている可能性がある。ライブ解決が
 *     失敗したときの最後の手段。
 *
 * 解決結果は chrome.storage.local に24時間キャッシュする。
 * 見つからなかった操作は null を返し、呼び出し側が
 * not_implemented として扱う（成功を偽らない）。
 */
'use strict';

/* global self */

const XManagerQueryIds = {
  /** 2026-02 時点の公開情報による既知の ID（古い可能性あり）。 */
  FALLBACK_IDS: {
    CreateTweet: 'bDE2rBtZb3uyrczSZ_pI9g',
    UserByScreenName: 'qW5u-DAuXpMEG0zA1F7UGQ',
    UserTweets: 'E3opETHurmVJflFsUBVuUQ',
    SearchTimeline: 'ML-n2SfAxx5S_9QMqNejbg',
    Followers: 'P7m4Qr-rJEB8KUluOenU6A',
  },

  /** 解決の対象にする操作名。 */
  OPERATIONS: [
    'CreateTweet',
    'DeleteTweet',
    'FavoriteTweet',
    'CreateRetweet',
    'CreateBookmark',
    'UserByScreenName',
    'UserTweets',
    'TweetDetail',
    'SearchTimeline',
    'Followers',
  ],

  STORAGE_KEY: 'xmanager.queryIds.v1',
  TTL_MS: 24 * 60 * 60 * 1000,

  /** 全操作の query ID を返す（キャッシュ→ライブ解決→フォールバック）。 */
  async resolve(deps) {
    const cached = await this.readCache(deps.storage).catch(() => null);
    if (cached && Date.now() - cached.fetchedAt < this.TTL_MS) {
      return { ...this.FALLBACK_IDS, ...cached.ids };
    }
    let found = {};
    try {
      found = await this.scanBundles(deps.fetchImpl);
    } catch {
      found = {};
    }
    const ids = { ...this.FALLBACK_IDS, ...found };
    await this.writeCache(deps.storage, ids).catch(() => {});
    return ids;
  },

  /** 1操作分の query ID。見つからなければ null。 */
  async getQueryId(operation, deps) {
    const ids = await this.resolve(deps);
    return ids[operation] || null;
  },

  async readCache(storage) {
    const stored = await storage.get(this.STORAGE_KEY);
    const row = stored ? stored[this.STORAGE_KEY] : null;
    if (!row || typeof row !== 'object' || !row.ids) return null;
    return row;
  },

  async writeCache(storage, ids) {
    await storage.set({ [this.STORAGE_KEY]: { ids, fetchedAt: Date.now() } });
  },

  /**
   * x.com のトップページから JS バンドルを探し、query ID を走査する。
   * バンドルは最大8個まで、全部の操作が見つかった時点で打ち切る。
   */
  async scanBundles(fetchImpl) {
    const found = {};
    const homeRes = await fetchWithTimeout(fetchImpl, 'https://x.com/', 15_000);
    const html = await homeRes.text();
    const chunkUrls = [
      ...new Set(
        [...html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"'\s]+\.js/g)].map(
          (m) => m[0],
        ),
      ),
    ].slice(0, 8);
    for (const url of chunkUrls) {
      try {
        const res = await fetchWithTimeout(fetchImpl, url, 15_000);
        if (!res.ok) continue;
        const js = await res.text();
        for (const m of js.matchAll(/\/i\/api\/graphql\/([A-Za-z0-9_-]+)\/([A-Za-z]+)/g)) {
          if (this.OPERATIONS.includes(m[2])) found[m[2]] = m[1];
        }
        for (const m of js.matchAll(/graphql\/([A-Za-z0-9_-]+)\/([A-Za-z]+)/g)) {
          if (this.OPERATIONS.includes(m[2]) && !found[m[2]]) found[m[2]] = m[1];
        }
        if (this.OPERATIONS.every((op) => found[op])) break;
      } catch {
        // このバンドルは諦めて次へ
      }
    }
    return found;
  },
};

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

if (typeof self !== 'undefined') {
  self.XManagerQueryIds = XManagerQueryIds;
}
