import type { Account } from '../db/types';
import { updateAccount } from '../db/repository';
import type {
  AccountCheckResult,
  ActionResult,
  ActionTarget,
  BulkActionKind,
  DeletePostResult,
  Executor,
  NotificationItem,
  PostAnalyticsItem,
  PostContent,
  PostResult,
  SearchBanCheckResult,
} from './Executor';
import { WindowBridgeTransport, type DesktopTransport } from './desktopTransport';
import {
  MEDIA_JOB_TIMEOUT_MS,
  MEDIA_MAX_ITEM_BYTES,
  MEDIA_MAX_POST_BYTES,
} from './protocol';
import type {
  ExtensionJob,
  ExtensionJobResult,
  ExtensionMethod,
  ExtensionResultCode,
} from './protocol';

/** デスクトップホストが「未実装」と返したときの表示文言。 */
export const DESKTOP_NOT_IMPLEMENTED_MESSAGE =
  'この操作はまだデスクトップアプリで実装されていません。次の段階で対応します。';

/**
 * 失敗分類ごとのフォールバック文言（ホストが理由文を付けなかった場合）。
 * ホストは通常、具体的な理由を日本語で付けて返すので、そちらを優先する。
 */
export const DESKTOP_ERROR_MESSAGES: Record<ExtensionResultCode, string> = {
  not_implemented: DESKTOP_NOT_IMPLEMENTED_MESSAGE,
  no_session:
    'このアカウントはデスクトップアプリに連携されていません。デスクトップアプリでアカウントを取り込んでください。',
  rate_limited:
    'Xの制限（レートリミット）にかかりました。しばらく待ってから再試行してください。',
  x_error: 'デスクトップアプリでの実行に失敗しました',
  extension_broken:
    'デスクトップホストで問題が発生しました。デスクトップアプリを再起動してください。',
  unknown: 'デスクトップアプリでの実行に失敗しました',
};

function newJobId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `job-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/**
 * Executor のデスクトップ版。実X操作はすべて Electron ホストに
 * 委譲する（ブリッジ経由の IPC。詳しくは docs/DESKTOP_BRIDGE.md）。
 * このアプリはトークンを持たず、ジョブの指示と結果だけをやり取りする。
 *
 * 拡張版（ExtensionExecutor）との違いはメディアの扱いだけ：
 * チャンク転送はせず、メディア本体をジョブの payload に inline で
 * 載せる（IPC は大きなメッセージを扱えるため）。転送上限の
 * チェック（1件32MB・合計64MB）は拡張版と同じ。
 *
 * ホストが未接続の場合、各メソッドは DesktopNotConnectedError を
 * 投げる（シミュレータに黙って落ちることはない）。
 */
export class DesktopExecutor implements Executor {
  private readonly transport: DesktopTransport;

  constructor(transport?: DesktopTransport) {
    this.transport = transport ?? new WindowBridgeTransport();
  }

  private async call(
    method: ExtensionMethod,
    account: Account,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<ExtensionJobResult> {
    const job: ExtensionJob = {
      id: newJobId(),
      method,
      accountId: account.id,
      accountHandle: account.handle,
      payload,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
    return this.transport.sendJob(job);
  }

  /**
   * ホストの失敗を画面に出す文言に写す。ホストは通常、具体的な
   * 理由を日本語で付けて返すのでそれを優先し、理由が無い場合だけ
   * 分類ごとのフォールバック文言を使う（「失敗しました」だけの
   * 表示にしない）。
   */
  private errorOf(result: ExtensionJobResult): string {
    const detail =
      typeof result.error === 'string' && result.error.trim() ? result.error : undefined;
    if (detail) return detail;
    return result.code ? DESKTOP_ERROR_MESSAGES[result.code] : DESKTOP_ERROR_MESSAGES.unknown;
  }

  async executePost(account: Account, content: PostContent): Promise<PostResult> {
    const at = Date.now();
    // メディア付きの場合、本体をジョブの payload に inline で載せる。
    // 転送路の実用上限（1件32MB・合計64MB）を超えるものは送らずに
    // 失敗として返す（base64 化して何千通も送るのは現実的でない）。
    let timeoutMs: number | undefined;
    if (content.media && content.media.length > 0) {
      const total = content.media.reduce((sum, m) => sum + (m.size || 0), 0);
      const oversized = content.media.find((m) => (m.size || 0) > MEDIA_MAX_ITEM_BYTES);
      if (oversized) {
        return {
          accountId: account.id,
          ok: false,
          error: `メディア「${oversized.name}」が大きすぎます（転送上限32MB）。小さくしてから再試行してください。`,
          at,
        };
      }
      if (total > MEDIA_MAX_POST_BYTES) {
        return {
          accountId: account.id,
          ok: false,
          error:
            'メディアの合計が大きすぎます（転送上限64MB）。件数かサイズを減らしてから再試行してください。',
          at,
        };
      }
      // アップロード分の時間を見込む（ホスト側の実行タイムアウトも
      // これに合わせる。Phase 1 のホスト実装が job.timeoutMs から決める）。
      timeoutMs = MEDIA_JOB_TIMEOUT_MS;
    }
    const result = await this.call('executePost', account, { content }, timeoutMs);
    if (!result.ok) {
      return {
        accountId: account.id,
        ok: false,
        error: this.errorOf(result),
        at: result.at ?? at,
      };
    }
    const data = result.data ?? {};
    return {
      accountId: account.id,
      ok: true,
      postId: typeof data.postId === 'string' ? data.postId : undefined,
      postUrl: typeof data.postUrl === 'string' ? data.postUrl : undefined,
      threadPostIds: Array.isArray(data.threadPostIds)
        ? data.threadPostIds.filter((id): id is string => typeof id === 'string')
        : undefined,
      at: result.at ?? at,
    };
  }

  async deletePost(account: Account, postId: string): Promise<DeletePostResult> {
    const at = Date.now();
    const result = await this.call('deletePost', account, { postId });
    if (!result.ok) {
      return { accountId: account.id, postId, ok: false, error: this.errorOf(result), at: result.at ?? at };
    }
    return { accountId: account.id, postId, ok: true, at: result.at ?? at };
  }

  async executeAction(
    account: Account,
    kind: BulkActionKind,
    target: ActionTarget,
  ): Promise<ActionResult> {
    const at = Date.now();
    const result = await this.call('executeAction', account, { kind, target });
    if (!result.ok) {
      return { accountId: account.id, kind, ok: false, error: this.errorOf(result), at: result.at ?? at };
    }
    return { accountId: account.id, kind, ok: true, at: result.at ?? at };
  }

  async checkAccount(account: Account): Promise<AccountCheckResult> {
    const at = Date.now();
    const result = await this.call('checkAccount', account, {});
    if (!result.ok) {
      // チェック失敗は「状態不明」として返すのではなく、呼び出し元に
      // 分かる形で投げる（黙って古い値を残さない）。
      throw new Error(this.errorOf(result));
    }
    const data = result.data ?? {};
    const status = typeof data.status === 'string' ? data.status : 'connection_error';
    // ホストは取れなかった数を -1（不明）で返す。その場合はアプリ側の
    // 保存済みの値を残し、0 で上書きしてしまわないようにする。
    const numOr = (v: unknown, fallback: number): number =>
      typeof v === 'number' && v >= 0 ? v : fallback;
    const check: AccountCheckResult = {
      accountId: account.id,
      status: status as AccountCheckResult['status'],
      notifications: numOr(data.notifications, account.notifications),
      dmCount: numOr(data.dmCount, account.dmCount),
      followers: numOr(data.followers, account.followers),
      checkedAt: result.at ?? at,
      // 401/403 でセッション切れと判定された場合。呼び出し元は
      // これを見て再登録を促す文言を出せる（成功扱いに紛れない）。
      sessionExpired: data.sessionExpired === true ? true : undefined,
    };
    // 拡張版と同じく、判定結果を台帳に書き戻す。セッション切れ
    // のときは status が logged_out になるので、一覧の表示も変わる。
    await updateAccount(account.id, {
      status: check.status,
      notifications: check.notifications,
      dmCount: check.dmCount,
      followers: check.followers,
      lastCheckedAt: check.checkedAt,
    });
    return check;
  }

  async resolveAccountIdentity(accountId: string): Promise<{ accountId: string; handle: string }> {
    const result = await this.call(
      'resolveAccountIdentity',
      { id: accountId, handle: '' } as Account,
      {},
    );
    if (!result.ok) {
      throw new Error(this.errorOf(result));
    }
    const data = result.data ?? {};
    const handle = typeof data.handle === 'string' ? data.handle : '';
    if (!handle) {
      throw new Error('ハンドルを確認できませんでした');
    }
    return {
      accountId: typeof data.accountId === 'string' ? data.accountId : accountId,
      handle,
    };
  }

  async checkSearchBan(account: Account, viaAccount: Account): Promise<SearchBanCheckResult> {
    const at = Date.now();
    const result = await this.call('checkSearchBan', account, {
      viaAccountId: viaAccount.id,
      viaHandle: viaAccount.handle,
    });
    if (!result.ok) {
      throw new Error(this.errorOf(result));
    }
    const data = result.data ?? {};
    const asBool = (v: unknown): boolean | null =>
      typeof v === 'boolean' ? v : null;
    return {
      accountId: account.id,
      checkedByAccountId: viaAccount.id,
      topicVisible: asBool(data.topicVisible),
      latestVisible: asBool(data.latestVisible),
      checkedAt: result.at ?? at,
    };
  }

  async fetchPostAnalytics(
    account: Account,
    fetcherAccounts: Account[],
  ): Promise<PostAnalyticsItem[]> {
    const result = await this.call('fetchPostAnalytics', account, {
      fetcherAccountIds: fetcherAccounts.map((a) => a.id),
    });
    if (!result.ok) throw new Error(this.errorOf(result));
    const items = result.data?.items;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is PostAnalyticsItem => {
      const row = item as Record<string, unknown>;
      return (
        typeof row.postId === 'string' &&
        typeof row.postUrl === 'string' &&
        typeof row.text === 'string' &&
        typeof row.likes === 'number' &&
        typeof row.reposts === 'number' &&
        typeof row.bookmarks === 'number' &&
        typeof row.views === 'number' &&
        typeof row.postedAt === 'number'
      );
    });
  }

  async fetchNotifications(account: Account): Promise<NotificationItem[]> {
    const result = await this.call('fetchNotifications', account, {});
    if (!result.ok) throw new Error(this.errorOf(result));
    const items = result.data?.items;
    if (!Array.isArray(items)) return [];
    return items.filter((item): item is NotificationItem => {
      const row = item as Record<string, unknown>;
      return (
        (row.kind === 'notification' || row.kind === 'dm') &&
        typeof row.title === 'string' &&
        typeof row.body === 'string' &&
        typeof row.at === 'number'
      );
    });
  }
}
