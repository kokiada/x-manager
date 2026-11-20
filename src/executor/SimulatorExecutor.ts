import type { Account, SearchBanState } from '../db/types';
import { updateAccount } from '../db/repository';
import type {
  ActionResult,
  ActionTarget,
  AccountCheckResult,
  BulkActionKind,
  DeletePostResult,
  Executor,
  NotificationItem,
  PostAnalyticsItem,
  PostContent,
  PostResult,
  SearchBanCheckResult,
} from './Executor';

/** Small deterministic PRNG (mulberry32) for plausible, stable demo data. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const delay = (min: number, max: number) =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, min + Math.random() * (max - min)),
  );

const jitter = (base: number, spread: number, min = 0) =>
  Math.max(min, Math.round(base + (Math.random() * 2 - 1) * spread));

/**
 * SimulatorExecutor — a stand-in Executor that behaves plausibly
 * against demo data so every console flow works end to end.
 * Check results are written back through the repository, exactly as
 * a real executor's results would be.
 */
export class SimulatorExecutor implements Executor {
  async executePost(account: Account, content: PostContent): Promise<PostResult> {
    await delay(700, 1600);
    const at = Date.now();
    if (account.status !== 'logged_in') {
      return {
        accountId: account.id,
        ok: false,
        error: `アカウントがログイン状態ではありません（${account.status}）`,
        at,
      };
    }
    if (!content.text.trim() && !content.mediaCount) {
      return { accountId: account.id, ok: false, error: '本文が空です', at };
    }
    const postId = `${at}${Math.floor(Math.random() * 1000)}`;
    const threadPostIds = (content.threadTexts ?? []).map(
      (_, i) => `${postId}t${i + 1}`,
    );
    return {
      accountId: account.id,
      ok: true,
      postId,
      postUrl: `https://x.com/${account.handle}/status/${postId}`,
      threadPostIds: threadPostIds.length > 0 ? threadPostIds : undefined,
      at,
    };
  }

  async deletePost(account: Account, postId: string): Promise<DeletePostResult> {
    await delay(300, 800);
    const at = Date.now();
    if (account.status !== 'logged_in') {
      return {
        accountId: account.id,
        postId,
        ok: false,
        error: `アカウントがログイン状態ではありません（${account.status}）`,
        at,
      };
    }
    return { accountId: account.id, postId, ok: true, at };
  }

  async executeAction(
    account: Account,
    kind: BulkActionKind,
    target: ActionTarget,
  ): Promise<ActionResult> {
    await delay(500, 1200);
    const at = Date.now();
    if (account.status !== 'logged_in') {
      return { accountId: account.id, kind, ok: false, error: '未ログインのため実行できません', at };
    }
    if (kind === 'follow' && !target.targetHandle) {
      return { accountId: account.id, kind, ok: false, error: 'フォロー対象が未指定です', at };
    }
    if (kind !== 'follow' && !target.postUrl) {
      return { accountId: account.id, kind, ok: false, error: '対象ポストが未指定です', at };
    }
    return { accountId: account.id, kind, ok: true, at };
  }

  async checkAccount(account: Account): Promise<AccountCheckResult> {
    await delay(600, 1400);
    const checkedAt = Date.now();

    // Plausible transitions: a token-registered logged-out account can
    // come back via token login; a connection error may recover;
    // locked / frozen accounts stay as they are until handled.
    let status = account.status;
    if (status === 'logged_out' && account.authToken) status = 'logged_in';
    if (status === 'connection_error' && Math.random() < 0.7) status = 'logged_in';

    const live = status === 'logged_in';
    const result: AccountCheckResult = {
      accountId: account.id,
      status,
      notifications: live ? jitter(account.notifications, 6) : 0,
      dmCount: live ? jitter(account.dmCount, 2) : 0,
      followers: live ? jitter(account.followers, 8) : account.followers,
      checkedAt,
    };

    await updateAccount(account.id, {
      status: result.status,
      notifications: result.notifications,
      dmCount: result.dmCount,
      followers: result.followers,
      lastCheckedAt: checkedAt,
    });
    return result;
  }

  async checkSearchBan(
    account: Account,
    viaAccount: Account,
  ): Promise<SearchBanCheckResult> {
    await delay(800, 1600);
    const checkedAt = Date.now();

    // The checking account must be usable (research §9-1).
    if (viaAccount.status !== 'logged_in') {
      return {
        accountId: account.id,
        checkedByAccountId: viaAccount.id,
        topicVisible: null,
        latestVisible: null,
        checkedAt,
      };
    }

    // Keep the simulated verdict consistent with the stored state,
    // with a small chance the state improves or worsens.
    let state: SearchBanState = account.searchBan;
    const roll = Math.random();
    if (state === 'unknown') state = roll < 0.7 ? 'visible' : roll < 0.85 ? 'topic_hidden' : 'both_hidden';
    else if (state === 'topic_hidden' && roll < 0.25) state = 'visible';
    else if (state === 'visible' && roll < 0.08) state = 'topic_hidden';

    const topicVisible = state === 'visible';
    const latestVisible = state === 'visible' || state === 'topic_hidden';

    await updateAccount(account.id, { searchBan: state, lastCheckedAt: checkedAt });
    return {
      accountId: account.id,
      checkedByAccountId: viaAccount.id,
      topicVisible,
      latestVisible,
      checkedAt,
    };
  }

  async fetchPostAnalytics(
    account: Account,
    fetcherAccounts: Account[],
  ): Promise<PostAnalyticsItem[]> {
    await delay(900, 1800);
    const fetchedAt = Date.now();
    if (account.status !== 'logged_in') return [];
    if (fetcherAccounts.length === 0) return [];

    // DEMO DATA: deterministic-ish metrics seeded from the account id
    // so the same account yields a stable-looking history. A real
    // executor would fetch the account's actual posts. Metrics grow
    // with follower count and decay for older posts.
    const rng = mulberry32(hashSeed(`analytics:${account.id}`));
    const topics = [
      '試合お疲れさまでした！今日のベストプレーを振り返ります。',
      'スタジアムの雰囲気が最高でした。次節も現地で応援します。',
      '新加入選手のプレーに注目。ここ数試合の調子が良いです。',
      '今日の練習風景を少しだけ。明日に向けて調整中です。',
      'サポーターの皆さん、たくさんの応援ありがとうございました。',
      'チケット情報のお知らせです。お早めにご確認ください。',
      '今週の注目カードをピックアップしました。',
      'クラブからのお知らせです。詳細は公式サイトをご覧ください。',
    ];
    const posts: PostAnalyticsItem[] = [];
    const count = 25;
    for (let i = 0; i < count; i++) {
      const daysAgo = Math.floor((i / count) * 30) + rng() * 1.2;
      const postedAt = fetchedAt - daysAgo * 24 * 3600_000 - rng() * 20 * 3600_000;
      const ageFactor = Math.max(0.15, 1 - daysAgo / 35);
      const buzz = 0.3 + rng() * rng() * 2.2; // a few posts pop
      const views = Math.max(
        50,
        Math.round(account.followers * (0.15 + rng() * 0.5) * ageFactor * buzz),
      );
      const likes = Math.max(1, Math.round(views * (0.02 + rng() * 0.06)));
      const reposts = Math.max(0, Math.round(likes * (0.1 + rng() * 0.25)));
      const bookmarks = Math.max(0, Math.round(likes * (0.05 + rng() * 0.2)));
      const postId = `${account.id}-p${String(i + 1).padStart(3, '0')}`;
      posts.push({
        accountId: account.id,
        postId,
        postUrl: `https://x.com/${account.handle}/status/${postId}`,
        text: topics[Math.floor(rng() * topics.length)],
        likes,
        reposts,
        bookmarks,
        views,
        postedAt,
        fetchedAt,
      });
    }
    return posts.sort((a, b) => b.postedAt - a.postedAt);
  }

  async fetchNotifications(account: Account): Promise<NotificationItem[]> {
    await delay(500, 1000);
    const now = Date.now();
    if (account.status !== 'logged_in') return [];

    // DEMO DATA: the manual (§11) only documents counts, not bodies,
    // so these items are plausible fabrications generated from the
    // account's current notification/DM counts. A real executor would
    // fetch the actual notification and DM list.
    const rng = mulberry32(hashSeed(`inbox:${account.id}:${Math.floor(now / 3600_000)}`));
    const items: NotificationItem[] = [];
    const notifKinds = [
      { title: 'いいねされました', body: 'あなたのポストがいいねされました。', from: 'antlers_daily' },
      { title: 'リポストされました', body: 'あなたのポストがリポストされました。', from: 'jleague_watch' },
      { title: '新しいフォロワー', body: '新しいフォロワーがいます。', from: 'stadium_gourmet' },
      { title: 'メンションされました', body: 'あなたのポストに返信がありました。', from: 'reply_squad_01' },
      { title: 'おすすめのポスト', body: 'フォロー中のアカウントが投稿しました。', from: 'matchday_live_jp' },
    ];
    const dmKinds = [
      { title: 'DMを受信しました', body: '試合の件で連絡があります。', from: 'antlers_daily' },
      { title: 'DMを受信しました', body: 'チケットについて教えてください。', from: 'stadium_gourmet' },
      { title: 'DMを受信しました', body: 'お疲れさまです！', from: 'jleague_watch' },
    ];
    const take = (pool: typeof notifKinds, n: number) => {
      for (let i = 0; i < n; i++) {
        const kind = pool[Math.floor(rng() * pool.length)];
        items.push({
          kind: pool === notifKinds ? 'notification' : 'dm',
          title: kind.title,
          body: kind.body,
          fromHandle: kind.from,
          at: now - Math.floor(rng() * 20) * 3600_000 - Math.floor(rng() * 3600_000),
        });
      }
    };
    take(notifKinds, Math.min(account.notifications, 5));
    take(dmKinds, Math.min(account.dmCount, 3));
    return items.sort((a, b) => b.at - a.at);
  }
}
