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
 *
 * 走査の時間制限：アプリ側のジョブタイムアウトは30秒なので、
 * 走査は締切（既定15秒）までに打ち切り、見つかった分と
 * フォールバックで返す。締切を過ぎてからも走査し続けて
 * ジョブ全体を時間切れにする、ということが無いようにする。
 * 並行する解決は1回の走査を共有する（同じタイミングで複数の
 * ジョブが走っても、x.com への取得が重ならない）。
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

  /** 走査の締切（既定15秒）。アプリ側の30秒タイムアウトに収まる。 */
  SCAN_DEADLINE_MS: 15_000,
  /** トップページ取得のタイムアウト。 */
  HOME_FETCH_TIMEOUT_MS: 8_000,
  /** バンドル1個の取得タイムアウト。 */
  BUNDLE_FETCH_TIMEOUT_MS: 5_000,

  /** 進行中の走査（並行する解決が共有する）。 */
  inflight: null,

  /**
   * 全操作の query ID を返す（キャッシュ→ライブ解決→フォールバック）。
   * deps には scanDeadlineMs（締切）と timeouts {homeMs, bundleMs} を
   * 渡せる（テスト用。未指定なら既定値）。
   */
  async resolve(deps) {
    const cached = await this.readCache(deps.storage).catch(() => null);
    if (cached && Date.now() - cached.fetchedAt < this.TTL_MS) {
      return { ...this.FALLBACK_IDS, ...cached.ids };
    }
    if (this.inflight) return this.inflight;
    const deadlineMs =
      typeof deps.scanDeadlineMs === 'number' ? deps.scanDeadlineMs : this.SCAN_DEADLINE_MS;
    const timeouts = deps.timeouts || {};
    const scan = (async () => {
      let found = {};
      try {
        found = await this.scanBundles(deps.fetchImpl, {
          deadline: Date.now() + deadlineMs,
          homeMs:
            typeof timeouts.homeMs === 'number' ? timeouts.homeMs : this.HOME_FETCH_TIMEOUT_MS,
          bundleMs:
            typeof timeouts.bundleMs === 'number'
              ? timeouts.bundleMs
              : this.BUNDLE_FETCH_TIMEOUT_MS,
        });
      } catch {
        found = {};
      }
      const ids = { ...this.FALLBACK_IDS, ...found };
      await this.writeCache(deps.storage, ids).catch(() => {});
      return ids;
    })();
    this.inflight = scan;
    try {
      return await scan;
    } finally {
      if (this.inflight === scan) this.inflight = null;
    }
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
   * 締切（opts.deadline）を過ぎたら新しいバンドルの取得は止め、
   * ここまでに見つかった分だけを返す（フォールバックと合わせて使う）。
   */
  async scanBundles(fetchImpl, opts = {}) {
    const deadline =
      typeof opts.deadline === 'number' ? opts.deadline : Date.now() + this.SCAN_DEADLINE_MS;
    const homeMs =
      typeof opts.homeMs === 'number' ? opts.homeMs : this.HOME_FETCH_TIMEOUT_MS;
    const bundleMs =
      typeof opts.bundleMs === 'number' ? opts.bundleMs : this.BUNDLE_FETCH_TIMEOUT_MS;
    const found = {};
    const homeRes = await fetchWithTimeout(fetchImpl, 'https://x.com/', homeMs);
    const html = await homeRes.text();
    const chunkUrls = [
      ...new Set(
        [...html.matchAll(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/[^"'\s]+\.js/g)].map(
          (m) => m[0],
        ),
      ),
    ].slice(0, 8);
    for (const url of chunkUrls) {
      if (Date.now() > deadline) break;
      try {
        const res = await fetchWithTimeout(fetchImpl, url, bundleMs);
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
  // signal だけでは足りない（signal を無視する実装だと永遠に
  // 待つ）ため、Promise.race でも締切を付ける。
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      fetchImpl(url, { signal: controller.signal }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`fetch timeout: ${url}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

if (typeof self !== 'undefined') {
  self.XManagerQueryIds = XManagerQueryIds;
}
