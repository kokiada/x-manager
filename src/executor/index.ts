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
import type { ExecutorMode } from '../db/types';
import { DesktopExecutor } from './DesktopExecutor';
import { ExtensionExecutor } from './ExtensionExecutor';
import { SimulatorExecutor } from './SimulatorExecutor';

export * from './Executor';
export { DesktopExecutor } from './DesktopExecutor';
export { ExtensionExecutor } from './ExtensionExecutor';
export {
  DesktopNotConnectedError,
  DesktopTimeoutError,
  WindowBridgeTransport,
  type DesktopTransport,
} from './desktopTransport';
export {
  ExtensionNotConnectedError,
  ExtensionTimeoutError,
  WindowPostMessageTransport,
  type ExtensionTransport,
} from './transport';
export { checkExtensionConnection, type ExtensionConnection } from './extensionStatus';

/**
 * 実行方法の切替。既定はシミュレータ。設定画面で「拡張」を選ぶと
 * 拡張Executorに、「デスクトップ」を選ぶと DesktopExecutor に
 * 切り替わる（`setExecutorMode` は設定の読込時と保存時に呼ぶ）。
 * モードはメモリ内にだけ持ち、設定値そのものは AppSettings
 * （IndexedDB）に保存する。
 */
let mode: ExecutorMode = 'simulator';
const simulator = new SimulatorExecutor();
let extensionExecutor: ExtensionExecutor | null = null;
let desktopExecutor: DesktopExecutor | null = null;

function activeExecutor(): Executor {
  if (mode === 'extension') {
    if (!extensionExecutor) extensionExecutor = new ExtensionExecutor();
    return extensionExecutor;
  }
  if (mode === 'desktop') {
    if (!desktopExecutor) desktopExecutor = new DesktopExecutor();
    return desktopExecutor;
  }
  return simulator;
}

export function setExecutorMode(next: ExecutorMode): void {
  mode = next;
}

export function getExecutorMode(): ExecutorMode {
  return mode;
}

/**
 * アプリ全体の Executor。呼び出し側はこの束縛だけを見る。
 * 内部で現在のモードに応じた実装（シミュレータ／拡張／
 * デスクトップ）に委譲する。拡張・デスクトップモードで相手が
 * 未接続の場合、各メソッドは NotConnectedError を投げる —
 * 黙ってシミュレータに落ちることはない。
 */
class DelegatingExecutor implements Executor {
  executePost(account: Account, content: PostContent): Promise<PostResult> {
    return activeExecutor().executePost(account, content);
  }
  deletePost(account: Account, postId: string): Promise<DeletePostResult> {
    return activeExecutor().deletePost(account, postId);
  }
  executeAction(
    account: Account,
    kind: BulkActionKind,
    target: ActionTarget,
  ): Promise<ActionResult> {
    return activeExecutor().executeAction(account, kind, target);
  }
  checkAccount(account: Account): Promise<AccountCheckResult> {
    return activeExecutor().checkAccount(account);
  }
  resolveAccountIdentity(accountId: string): Promise<{ accountId: string; handle: string }> {
    return activeExecutor().resolveAccountIdentity(accountId);
  }
  checkSearchBan(account: Account, viaAccount: Account): Promise<SearchBanCheckResult> {
    return activeExecutor().checkSearchBan(account, viaAccount);
  }
  fetchPostAnalytics(
    account: Account,
    fetcherAccounts: Account[],
  ): Promise<PostAnalyticsItem[]> {
    return activeExecutor().fetchPostAnalytics(account, fetcherAccounts);
  }
  fetchNotifications(account: Account): Promise<NotificationItem[]> {
    return activeExecutor().fetchNotifications(account);
  }
}

export const executor: Executor = new DelegatingExecutor();
