import {
  HELLO_TIMEOUT_MS,
  JOB_TIMEOUT_MS,
  PAGE_SOURCE,
  PROTOCOL_VERSION,
} from './protocol';
import {
  isDesktopHelloAck,
  isDesktopJobResult,
  isDesktopSessionsMessage,
  normalizeDesktopSessions,
  type DesktopHelloAckMessage,
  type DesktopJobResultMessage,
  type ExtensionJob,
  type ExtensionJobResult,
  type ExtensionSession,
} from './desktopProtocol';

/**
 * デスクトップアプリとして起動されていない
 * （window.xManagerDesktop が無い／このページはブラウザ版）。
 */
export class DesktopNotConnectedError extends Error {
  constructor() {
    super(
      'デスクトップアプリとして起動されていません。デスクトップアプリで開いてから、もう一度お試しください。',
    );
    this.name = 'DesktopNotConnectedError';
  }
}

/** デスクトップホストは見つかったが、制限時間内に返事がなかった。 */
export class DesktopTimeoutError extends Error {
  constructor(what: string) {
    super(`デスクトップホストからの返事が時間切れになりました（${what}）。`);
    this.name = 'DesktopTimeoutError';
  }
}

/** ハンドシェイクの応答。 */
export interface DesktopHandshake {
  version: number;
  hostVersion: string;
}

/**
 * preload が公開するブリッジの最小形。
 * `window.xManagerDesktop.invoke` がこれに当たる。
 * 送るのはメッセージ1件、返るのはホストからの応答1件。
 * ジョブ結果の相関は、応答に含まれる job id で取る。
 */
export interface DesktopBridge {
  invoke(message: unknown): Promise<unknown>;
}

/**
 * アプリとデスクトップホストをつなぐ輸送層。DesktopExecutor は
 * この抽象だけを見るので、テストでは偽物に差し替えられる。
 *
 * 拡張の ExtensionTransport と違い `sendMedia` は持たない。
 * デスクトップではメディア本体をチャンク転送せず、ジョブの
 * payload に inline で載せる（IPC は postMessage より大きな
 * メッセージを扱えるため。詳しくは docs/DESKTOP_BRIDGE.md）。
 */
export interface DesktopTransport {
  /** ホストが応答するかどうか。未接続なら DesktopNotConnectedError。 */
  ping(timeoutMs?: number): Promise<DesktopHandshake>;
  /** ジョブを1件送り、結果を待つ。 */
  sendJob(job: ExtensionJob): Promise<ExtensionJobResult>;
  /** ホストに連携済みのアカウント（ID＋ハンドル）一覧を聞く。 */
  listSessions(): Promise<ExtensionSession[]>;
}

/** preload が差し込む window.xManagerDesktop を読むための窓口。 */
export interface DesktopBridgeWindow {
  xManagerDesktop?: DesktopBridge;
}

export class WindowBridgeTransport implements DesktopTransport {
  private readonly bridge: DesktopBridge | undefined;

  constructor(bridge?: DesktopBridge) {
    this.bridge =
      bridge ??
      (typeof window !== 'undefined'
        ? (window as unknown as DesktopBridgeWindow).xManagerDesktop
        : undefined);
  }

  private requireBridge(): DesktopBridge {
    if (!this.bridge) throw new DesktopNotConnectedError();
    return this.bridge;
  }

  /**
   * ブリッジへ1件送り、検証済みの応答を待つ。
   * 時間切れなら DesktopTimeoutError。invoke 自体が拒否した
   * 場合（ホスト側の例外など）はそのエラーをそのまま通す。
   */
  private async request<T>(
    message: unknown,
    isExpected: (value: unknown) => value is T,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    const bridge = this.requireBridge();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DesktopTimeoutError(what)), timeoutMs);
    });
    try {
      const reply = await Promise.race([bridge.invoke(message), timeout]);
      if (!isExpected(reply)) {
        throw new Error(`デスクトップホストからの返事の形が不正です（${what}）。`);
      }
      return reply;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  async ping(timeoutMs = HELLO_TIMEOUT_MS): Promise<DesktopHandshake> {
    const ack = await this.request<DesktopHelloAckMessage>(
      { source: PAGE_SOURCE, kind: 'hello', version: PROTOCOL_VERSION },
      isDesktopHelloAck,
      timeoutMs,
      'デスクトップホストの確認',
    ).catch((err: unknown) => {
      if (err instanceof DesktopTimeoutError) throw new DesktopNotConnectedError();
      throw err;
    });
    if (ack.version !== PROTOCOL_VERSION) {
      throw new DesktopNotConnectedError();
    }
    return { version: ack.version, hostVersion: ack.hostVersion };
  }

  async sendJob(job: ExtensionJob): Promise<ExtensionJobResult> {
    const result = await this.request<DesktopJobResultMessage>(
      { source: PAGE_SOURCE, kind: 'job', ...job },
      isDesktopJobResult,
      job.timeoutMs ?? JOB_TIMEOUT_MS,
      `ジョブ ${job.method}`,
    );
    // ジョブ結果は id で相関を取る（別ジョブの結果は受け取らない）。
    if (result.id !== job.id) {
      throw new Error(`デスクトップホストからの返事のIDが一致しません（ジョブ ${job.method}）。`);
    }
    return result;
  }

  async listSessions(): Promise<ExtensionSession[]> {
    const reply = await this.request(
      { source: PAGE_SOURCE, kind: 'list-sessions' },
      isDesktopSessionsMessage,
      HELLO_TIMEOUT_MS,
      '連携アカウントの確認',
    ).catch((err: unknown) => {
      if (err instanceof DesktopTimeoutError) throw new DesktopNotConnectedError();
      throw err;
    });
    // 新形式（sessions）と旧形式（accountIds）のどちらが来ても同じ形に揃える。
    return normalizeDesktopSessions(reply);
  }
}
