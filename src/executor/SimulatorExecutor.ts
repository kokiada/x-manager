import type { Account, SearchBanState } from '../db/types';
import { updateAccount } from '../db/repository';
import type {
  ActionResult,
  ActionTarget,
  AccountCheckResult,
  BulkActionKind,
  Executor,
  PostContent,
  PostResult,
  SearchBanCheckResult,
} from './Executor';

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
    return {
      accountId: account.id,
      ok: true,
      postId,
      postUrl: `https://x.com/${account.handle}/status/${postId}`,
      at,
    };
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
}
