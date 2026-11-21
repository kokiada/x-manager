import type { Account } from '../db/types';
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
import { WindowPostMessageTransport, type ExtensionTransport } from './transport';
import type { ExtensionJob, ExtensionJobResult, ExtensionMethod } from './protocol';

/** 拡張が「未実装」と返したときの表示文言。 */
export const EXTENSION_NOT_IMPLEMENTED_MESSAGE =
  'この操作はまだ拡張機能で実装されていません。次の段階で対応します。';

function newJobId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `job-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

/**
 * Executor の拡張版。実X操作はすべて Chrome 拡張に委譲する。
 * このアプリはトークンを持たず、ジョブの指示と結果だけをやり取りする
 * （詳しくは docs/REAL_X_DESIGN.md）。
 *
 * 拡張が未接続の場合、各メソッドは ExtensionNotConnectedError を投げる
 * （シミュレータに黙って落ちることはない）。
 */
export class ExtensionExecutor implements Executor {
  private readonly transport: ExtensionTransport;

  constructor(transport?: ExtensionTransport) {
    this.transport = transport ?? new WindowPostMessageTransport();
  }

  private async call(
    method: ExtensionMethod,
    account: Account,
    payload: Record<string, unknown>,
  ): Promise<ExtensionJobResult> {
    const job: ExtensionJob = {
      id: newJobId(),
      method,
      accountId: account.id,
      accountHandle: account.handle,
      payload,
    };
    return this.transport.sendJob(job);
  }

  private errorOf(result: ExtensionJobResult): string {
    if (result.code === 'not_implemented') return EXTENSION_NOT_IMPLEMENTED_MESSAGE;
    return result.error ?? '拡張での実行に失敗しました';
  }

  async executePost(account: Account, content: PostContent): Promise<PostResult> {
    const at = Date.now();
    const result = await this.call('executePost', account, { content });
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
    return {
      accountId: account.id,
      status: status as AccountCheckResult['status'],
      notifications: typeof data.notifications === 'number' ? data.notifications : 0,
      dmCount: typeof data.dmCount === 'number' ? data.dmCount : 0,
      followers: typeof data.followers === 'number' ? data.followers : account.followers,
      checkedAt: result.at ?? at,
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
