import {
  HELLO_TIMEOUT_MS,
  JOB_TIMEOUT_MS,
  PAGE_SOURCE,
  PROTOCOL_VERSION,
  isHelloAck,
  isJobResult,
  isSessionsMessage,
  type ExtensionJob,
  type ExtensionJobResult,
  type PageMessage,
} from './protocol';

/** 拡張が見つからない（未インストール／未読込／このページに未接続）。 */
export class ExtensionNotConnectedError extends Error {
  constructor() {
    super(
      'Chrome拡張「x-manager 実行役」が見つかりません。拡張を読み込んでから、もう一度お試しください。',
    );
    this.name = 'ExtensionNotConnectedError';
  }
}

/** 拡張は見つかったが、制限時間内に返事がなかった。 */
export class ExtensionTimeoutError extends Error {
  constructor(what: string) {
    super(`拡張からの返事が時間切れになりました（${what}）。`);
    this.name = 'ExtensionTimeoutError';
  }
}

/** ハンドシェイクの応答。 */
export interface ExtensionHandshake {
  version: number;
  extensionVersion: string;
}

/**
 * アプリと拡張をつなぐ輸送層。ExtensionExecutor はこの抽象だけを
 * 見るので、テストでは偽物に差し替えられるし、将来は
 * WebSocket（ローカルエージェント）版に置き換えられる。
 */
export interface ExtensionTransport {
  /** 拡張が応答するかどうか。未接続なら ExtensionNotConnectedError。 */
  ping(timeoutMs?: number): Promise<ExtensionHandshake>;
  /** ジョブを1件送り、結果を待つ。 */
  sendJob(job: ExtensionJob): Promise<ExtensionJobResult>;
  /** 拡張に連携済みのアカウントID一覧を聞く。 */
  listSessions(): Promise<string[]>;
}

/** window.postMessage 経由で content script と話す輸送層。 */
export interface PostMessageWindow {
  postMessage(message: unknown, targetOrigin: string): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export class WindowPostMessageTransport implements ExtensionTransport {
  private readonly target: PostMessageWindow | undefined;

  constructor(target?: PostMessageWindow) {
    this.target =
      target ?? (typeof window !== 'undefined' ? (window as unknown as PostMessageWindow) : undefined);
  }

  private requireTarget(): PostMessageWindow {
    if (!this.target) throw new ExtensionNotConnectedError();
    return this.target;
  }

  private request<T>(
    message: PageMessage,
    isExpected: (value: unknown) => value is T,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    const target = this.requireTarget();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new ExtensionTimeoutError(what));
      }, timeoutMs);
      const onMessage = (event: MessageEvent) => {
        if (event.source !== (target as unknown as Window)) return;
        const data: unknown = event.data;
        if (!isExpected(data)) return;
        // ジョブ結果は id で相関を取る。
        if (isJobResult(data) && 'id' in message && data.id !== (message as ExtensionJob).id) {
          return;
        }
        clearTimeout(timer);
        cleanup();
        resolve(data);
      };
      const cleanup = () => target.removeEventListener('message', onMessage);
      target.addEventListener('message', onMessage);
      try {
        target.postMessage(message, '*');
      } catch (err) {
        clearTimeout(timer);
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  async ping(timeoutMs = HELLO_TIMEOUT_MS): Promise<ExtensionHandshake> {
    const ack = await this.request(
      { source: PAGE_SOURCE, kind: 'hello', version: PROTOCOL_VERSION },
      isHelloAck,
      timeoutMs,
      '拡張の確認',
    ).catch((err: unknown) => {
      if (err instanceof ExtensionTimeoutError) throw new ExtensionNotConnectedError();
      throw err;
    });
    if (ack.version !== PROTOCOL_VERSION) {
      throw new ExtensionNotConnectedError();
    }
    return { version: ack.version, extensionVersion: ack.extensionVersion };
  }

  async sendJob(job: ExtensionJob): Promise<ExtensionJobResult> {
    const result = await this.request(
      { source: PAGE_SOURCE, kind: 'job', ...job },
      isJobResult,
      JOB_TIMEOUT_MS,
      `ジョブ ${job.method}`,
    );
    return result;
  }

  async listSessions(): Promise<string[]> {
    const reply = await this.request(
      { source: PAGE_SOURCE, kind: 'list-sessions' },
      isSessionsMessage,
      HELLO_TIMEOUT_MS,
      '連携アカウントの確認',
    ).catch((err: unknown) => {
      if (err instanceof ExtensionTimeoutError) throw new ExtensionNotConnectedError();
      throw err;
    });
    return reply.accountIds;
  }
}
